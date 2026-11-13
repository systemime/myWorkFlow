// search-gate.js v6.2
// v6.3: 新增部署拦截 —— git push/merge、docker restart、scp/rsync 远程目标、deploy.sh 默认打回;
//       用户明确授权后命令前加 DEPLOY_GATE=allow 放行。
// v6.2: 新增输出禁用词 —— Stop 时扫最后一条 assistant 回答文本, 含 BANNED_WORDS 即打回重答。
// v6.1: 新增 sleep 上限 —— 除非能够精确计算 sleep 时间,否则单次 sleep 不能超过 60 秒。
//       命令前加 SLEEP_GATE=allow 显式声明精确等待时才放行。
// v6: 删除首搜闸/图过期提醒 —— 「不建图就拦 rg」与 CLAUDE.md「rg 优先」直接冲突,
//     文档评审等非编码 git 目录也被拦(实测)。插件只保留 grep→rg 的工具路由强制,
//     rg 永远放行; 状态目录/资格扫描/认图/过期检测/会话隔离随之全部移除。
// v5.3: 只在「命令位置」识别 grep —— 引号/参数里的同名词不误拦
//       (`git commit -m "use grep"`、`python grep.py`、`echo rg`),
//       /bin/grep、sh -c 'grep …' 等变体不漏拦(词法解析保留)。
// bash → PreToolUse(Bash): grep/egrep/fgrep 一律打回换 rg; rg 缺失时放行兜底。
//                         单次 sleep > 60 秒打回。
// stop → Stop: 回答文本含禁用词时打回, 要求删词后重答(stop_hook_active 时不循环)。
//
// 环境变量 GRAPHIFY_GATE=off|0|false 时整个插件放行(CI / 无头场景逃生口)
// 环境变量 SLEEP_GATE=off|0|false 时只关闭 sleep 上限
// 环境变量 WORDS_GATE=off|0|false 时只关闭输出禁用词
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
const INTERESTING = new Set([...GREPS, 'find', 'sleep', ...SHELLS]);

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
    if (c === '#' && (i === 0 || /\s/.test(cmd[i - 1]))) {
      while (i < cmd.length && cmd[i] !== '\n') i++;
      endSeg();
      continue;
    }
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

// 遍历所有「命令位置」, visit(name, words, i) 返回 true 即停止
// (含 git grep、find -exec、sh -c 递归; 全路径 /bin/grep 同样命中)
function walk(cmd, depth, visit) {
  for (const words of segments(cmd)) {
    const i = commandAt(words);
    if (i < 0) continue;
    const name = baseName(words[i]);
    if (visit(name, words, i)) return true;
    if (name === 'git' && words[i + 1] === 'grep' && visit('grep', words, i + 1)) return true;
    if (name === 'find') {
      for (let j = i + 1; j < words.length - 1; j++) {
        if (/^-(exec|execdir|ok)$/.test(words[j]) && visit(baseName(words[j + 1]), words, j + 1)) return true;
      }
      continue;
    }
    // sh -c / bash -lc '<cmd>': 引号里的字符串本身是命令
    if (SHELLS.has(name) && depth < 3) {
      const k = words.findIndex((w, j) => j > i && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
      if (k > i && words[k + 1] !== undefined && walk(words[k + 1], depth + 1, visit)) return true;
    }
  }
  return false;
}

function hasGrep(cmd, depth) {
  return walk(cmd, depth, (name) => GREPS.has(name));
}

// ---------- sleep 上限: 除非能精确算出等待时间, 单次 sleep 不超过 60 秒 ----------
const SLEEP_LIMIT = 60;

// "90" / "1m" / "1m30s" / "1.5h" → 秒; 无法完整解析返回 null
function secondsOf(word) {
  const MULT = { s: 1, m: 60, h: 3600, d: 86400 };
  const re = /(\d+(?:\.\d+)?)([smhd]?)/gi;
  let total = 0, consumed = '', m;
  while ((m = re.exec(word))) {
    consumed += m[0];
    total += parseFloat(m[1]) * MULT[(m[2] || 's').toLowerCase()];
  }
  return consumed === word && total > 0 ? total : null;
}

// sleep 参数里出现变量/命令替换等算不出的值时返回 null(放行, 不误拦)
function sleepSeconds(words, i) {
  let total = 0;
  for (let j = i + 1; j < words.length; j++) {
    const w = words[j];
    if (w.startsWith('-') || /^\d*[<>]/.test(w)) continue;   // 选项 / 重定向
    const s = secondsOf(w);
    if (s === null) return null;
    total += s;
  }
  return total;
}

function oversleep(cmd, depth) {
  return walk(cmd, depth, (name, words, i) => {
    if (name !== 'sleep') return false;
    // 精确等待例外: 命令前显式声明 SLEEP_GATE=allow
    for (let j = 0; j < i; j++) if (/^SLEEP_GATE=allow$/i.test(words[j])) return false;
    const s = sleepSeconds(words, i);
    return s !== null && s > SLEEP_LIMIT;
  });
}

// ---------- 部署拦截: 推送/合并/远程部署属于对外变更, 需显式授权 ----------
// 匹配范围保守: git push/merge、docker restart、scp/rsync 带远程目标、deploy.sh。
// ssh 不拦 —— 日常查状态/读日志大量使用; 远程部署通常经 scp/rsync/deploy.sh 落地。
function remoteTarget(words) {
  for (let j = 1; j < words.length; j++) {
    const w = words[j];
    if (w.startsWith('-')) continue;
    if (/^[^/\s]+@[^:]+:/.test(w) || /^[A-Za-z0-9._-]+:/.test(w)) return true;  // user@host:path / host:path
  }
  return false;
}

function deployCommand(cmd, depth) {
  return walk(cmd, depth, (name, words, i) => {
    // 授权例外: 命令前显式声明 DEPLOY_GATE=allow
    for (let j = 0; j < i; j++) if (/^DEPLOY_GATE=allow$/i.test(words[j])) return false;
    if (name === 'git') {
      const sub = words.slice(i + 1).find((w) => !w.startsWith('-'));
      return sub === 'push' || sub === 'merge';
    }
    if (name === 'docker') {
      const sub = words.slice(i + 1).find((w) => !w.startsWith('-'));
      return sub === 'restart';
    }
    if (name === 'scp' || name === 'rsync') return remoteTarget(words);
    if (name === 'deploy.sh' || name === 'deploy-cdos.sh') return true;
    return false;
  });
}

// ---------- bash: grep→rg 强制(rg 永远放行, 无首搜闸) + sleep 上限 ----------
if (mode === 'bash') {
  const cmd = (payload().tool_input || {}).command || '';
  const deployOff = ['off', '0', 'false'].includes((process.env.DEPLOY_GATE || '').toLowerCase());
  if (!deployOff && deployCommand(cmd, 0)) {
    deny('Blocked: 推送、合并与远程部署属于对外变更，需用户明确授权后再执行。'
      + '用户同意后，在命令前加 DEPLOY_GATE=allow 声明；用户未要求时先完成代码改动并等待通知。');
  }
  const sleepOff = ['off', '0', 'false'].includes((process.env.SLEEP_GATE || '').toLowerCase());
  if (!sleepOff && oversleep(cmd, 0)) {
    deny('Blocked: 除非能够精确计算 sleep 时间，否则单次 sleep 时间不能超过 60 秒。'
      + '改用不超过 60 秒的 sleep 循环；确实需要精确等待更久时，在命令前加 SLEEP_GATE=allow 声明。');
  }
  if (hasGrep(cmd, 0) && spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0) {
    deny('Blocked: 请改用 rg。');
  }
}

// ---------- 输出禁用词: Stop 时扫最后一条回答, 含禁用词打回重答 ----------
// 只扫最后一条 assistant 的 text 块: 历史轮次里的旧词不追打, 工具参数里的同名词不算输出
// 与 ~/.claude/CLAUDE.md「禁用词」表同步（2026-11-13）。
// 取舍：「闭环」「对齐」不进硬拦截——日常技术语境（版本对齐/流程闭环讨论）误报率高，留在软约束；
// 其余绝对禁用词（任何语境）全部硬拦截。
const BANNED_WORDS = [
  '门禁', '契约', '种子', '播种', '豁免', '抽屉', '值错位',
  '硬顶', '保险丝', '战役', '点火', '污染', '毒化', '幻影',
  '老树', '纪律',
  '赋能', '抓手', '颗粒度', '拉通', '沉淀',
];
const WORDS_OFF = ['off', '0', 'false'];

// 从 transcript JSONL 里取最后一条 assistant 的文本(text 块); 读不到返回 null(放行兜底)
function lastAssistantText(file) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch (e) { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch (e) { continue; }   // 空行/写一半的行跳过
    if (!entry || entry.type !== 'assistant' || !Array.isArray((entry.message || {}).content)) continue;
    return entry.message.content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
  }
  return null;
}

if (mode === 'stop') {
  const p = payload();
  if (!WORDS_OFF.includes((process.env.WORDS_GATE || '').toLowerCase())
      && p.transcript_path && !p.stop_hook_active) {
    const text = lastAssistantText(p.transcript_path);
    const found = text ? BANNED_WORDS.filter(w => text.includes(w)) : [];
    if (found.length) {
      deny('Blocked: 回答中出现禁用词「' + found.join('」「') + '」。'
        + '删除这些词或换成直白说法，重新给出完整回答。');
    }
  }
}

allow();                                          // 未知 mode / 非检索命令 / 干净回答: 放行
