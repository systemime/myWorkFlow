// search-gate.js v6.0
// v6: 删除首搜闸/图过期提醒 —— 「不建图就拦 rg」与 CLAUDE.md「rg 优先」直接冲突,
//     文档评审等非编码 git 目录也被拦(实测)。插件只保留 grep→rg 的工具路由强制,
//     rg 永远放行; 状态目录/资格扫描/认图/过期检测/会话隔离随之全部移除。
// v5.3: 只在「命令位置」识别 grep —— 引号/参数里的同名词不误拦
//       (`git commit -m "use grep"`、`python grep.py`、`echo rg`),
//       /bin/grep、sh -c 'grep …' 等变体不漏拦(词法解析保留)。
// bash → PreToolUse(Bash): grep/egrep/fgrep 一律打回换 rg; rg 缺失时放行兜底。
//
// 环境变量 GRAPHIFY_GATE=off|0|false 时整个插件放行(CI / 无头场景逃生口)
const fs = require('fs');
const { spawnSync } = require('child_process');

const mode = process.argv[2];

function allow() { process.exit(0); }
function deny(msg) { console.error(msg); process.exit(2); }

// ---------- stdin: 只读一次(tool_input 从这里来) ----------
let payloadCache;
function payload() {
  if (payloadCache === undefined) {
    let s = '';
    try { s = fs.readFileSync(0, 'utf8'); } catch (e) {}
    try { payloadCache = JSON.parse(s) || {}; } catch (e) { payloadCache = {}; }
  }
  return payloadCache;
}

// ---------- 逃生开关: CI / 无头场景直接关掉 ----------
// (hook 超时不阻塞工具调用, 所以这里必须显式放行, 不能靠超时)
const off = (process.env.GRAPHIFY_GATE || '').toLowerCase();
if (off === 'off' || off === '0' || off === 'false') allow();

// ---------- bash 命令词法: 只在「命令位置」识别 grep ----------
// 旧实现按子串正则匹配 " grep": `git commit -m "use grep"`、`python grep.py`、`echo grep`
// 都被误判成检索命令打回。这里按未加引号的 ; & | ( ) 换行切段, 段内按引号/空白切词,
// 只看每段实际执行的命令词(wrapper 后取被执行的命令); sh -c '…' 里的字符串递归解析。
// ponytail: 轻量词法而非完整 shell 解析器; eval/反引号等动态求值不识别(与 awk/sed 同属已知边界)
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', 'done', '!', '{', '}']);
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'time', 'timeout', 'nohup',
  'nice', 'ionice', 'stdbuf', 'xargs', 'busybox', 'wsl', 'npx', 'pnpx', 'bunx', 'uvx', 'pipx']);
const GREPS = new Set(['grep', 'egrep', 'fgrep']);
const INTERESTING = new Set([...GREPS, 'find', ...SHELLS]);

function baseName(w) {
  const b = w.replace(/\\/g, '/').split('/').pop();
  return b.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

// 切成简单命令的词数组; 引号内容保留为一个词, 以便 sh -c '<cmd>' 递归解析
function segments(cmd) {
  const out = [];
  let words = [], word = '', quote = '';
  const endWord = () => { if (word) words.push(word); word = ''; };
  const endSeg = () => { endWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"') word += cmd[++i] || '';
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '\\') { word += cmd[++i] || ''; continue; }
    if (/[|;&()\n\r]/.test(c)) { endSeg(); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    word += c;
  }
  endSeg();
  return out;
}

// 段内实际执行的命令词下标; 跳过 FOO=1 前缀、if/do 等关键字与 sudo/env/xargs 等 wrapper,
// wrapper 后取第一个「像命令」的词(能处理 sudo -u root grep)
function commandAt(words) {
  let i = 0;
  while (i < words.length && (KEYWORDS.has(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i++;
  if (i < words.length && WRAPPERS.has(baseName(words[i]))) {
    for (let j = i + 1; j < words.length; j++) {
      if (!words[j].startsWith('-') && INTERESTING.has(baseName(words[j]))) return j;
    }
    return -1;
  }
  return i < words.length ? i : -1;
}

// 命令里是否存在「命令位置」上的 grep/egrep/fgrep
// (含 git grep、find -exec grep、sh -c 递归; 全路径 /bin/grep 同样命中)
function hasGrep(cmd, depth) {
  for (const words of segments(cmd)) {
    const i = commandAt(words);
    if (i < 0) continue;
    const name = baseName(words[i]);
    if (GREPS.has(name)) return true;
    // git grep / find -exec grep 仍是 grep 检索
    if (name === 'git' && words[i + 1] === 'grep') return true;
    if (name === 'find') {
      for (let j = i + 1; j < words.length - 1; j++) {
        if (/^-(exec|execdir|ok)$/.test(words[j]) && GREPS.has(baseName(words[j + 1]))) return true;
      }
      continue;
    }
    // sh -c / bash -lc '<cmd>': 引号里的字符串本身是命令
    if (SHELLS.has(name) && depth < 3) {
      const k = words.findIndex((w, j) => j > i && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
      if (k > i && words[k + 1] !== undefined && hasGrep(words[k + 1], depth + 1)) return true;
    }
  }
  return false;
}

// ---------- bash: grep→rg 强制(rg 永远放行, 无首搜闸) ----------
if (mode === 'bash') {
  const cmd = (payload().tool_input || {}).command || '';
  if (hasGrep(cmd, 0) && spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0) {
    deny('Blocked: 请改用 rg。');
  }
}

allow();                                          // 未知 mode / 非检索命令 / rg 缺失: 放行
