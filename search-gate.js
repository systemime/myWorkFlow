// search-gate.js v5.3
// v5.3: 只在「命令位置」识别 grep/rg/graphify — 引号/参数里的同名词不再误拦;
//       状态文件损坏时按未开闸处理而不是崩溃; 已开闸时先读状态, 跳过每次检索的资格扫描
// v5: 资格收敛 — (本目录或父目录)git 仓库, 或浅层 ≥2 个「代码证据」(代码后缀文件/项目清单);
//     旧「≥2 个任意文件」兜底会让几千 mp4 的纯媒体目录误武装(实测 F:\Douyin)
// bash     → PreToolUse(Bash): ① grep→rg 强制(rg 缺失兜底) ② 拦截未完成首搜的检索
//                              ③ graphify 图查询(CLI) = 首搜完成, 开闸并放行
// file     → PreToolUse(Grep|Glob): 拦截未完成首搜的内置搜索工具
// graphify → PreToolUse(mcp__graphify.*): 图存在时的 MCP 图查询 = 首搜完成, 开闸并放行
// session  → SessionStart: 清状态, 新会话重新武装
//
// 环境变量 GRAPHIFY_GATE=off|0|false 时整个插件放行(CI / 无头场景逃生口)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// 资格计数时跳过的产物目录: 依赖/构建输出/缓存/IDE — 只收高确定性名字,
// 不收 packages/src 这类常为真实源码的名字
const SKIP = new Set([
  // 依赖
  'node_modules', 'bower_components', 'vendor', 'deps', 'third_party', 'thirdparty', 'Pods',
  // 构建输出
  'dist', 'build', 'out', 'bin', 'obj', 'target', 'release', 'debug', 'cmake-build',
  // Python
  '.venv', 'venv', 'env', '__pycache__', '.tox', '.nox', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', 'htmlcov', 'site-packages',
  // 缓存/覆盖率/前端框架产物
  '.cache', 'coverage', '.nyc_output', '.next', '.nuxt', '.svelte-kit', '.turbo', '.gradle',
  // IDE / 特殊
  '.git', '.vs', '.vscode', '.idea', 'graphify-out'
]);
const MAX_BLOCK = 3;          // 逃生口: 同一参数连续 N 次被拦才自动放行; 不同参数不算重试
const SKILL = '~/.claude/skills/graphify/SKILL.md';
const GIT_TIMEOUT = 5000;     // ms, git log / rev-parse
const GIT_STATUS_TIMEOUT = 8000;
const SCAN_LIMIT = 500;       // 过期检测逐文件比对 mtime 的上限条数

// 代码证据(v5): 闸门只服务编码/脚本场景 — 浅层出现 ≥2 个代码后缀文件/项目清单才视为编码目录。
// 刻意不收 .json/.yml/.md 泛后缀(媒体/资料目录也常见); .json 仅按清单文件名白名单收。
// html/htm 不收(v5.1): 文档库常见报告/页面导出物(实测 GLB-DOC: 12 个 html 导出误武装,
// 要求纯资料目录建图); Web 项目有 package.json 等清单兜底, 不依赖 html 作证据。
const CODE_EXT = new Set(['py', 'pyi', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'go', 'rs',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'java', 'kt', 'kts', 'rb', 'php', 'swift',
  'm', 'mm', 'lua', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'r', 'jl', 'dart',
  'scala', 'clj', 'cljs', 'ex', 'exs', 'erl', 'hrl', 'hs', 'ml', 'mli', 'fs', 'fsx', 'vue',
  'svelte', 'astro', 'css', 'scss', 'less', 'sass', 'styl', 'v', 'sv', 'vhd',
  'csproj', 'sln']);
const MANIFEST = new Set(['package.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'cmakelists.txt', 'makefile', 'dockerfile',
  'requirements.txt', 'composer.json', 'gemfile', 'rakefile']);

function isCodeFile(name) {
  const lower = name.toLowerCase();
  if (MANIFEST.has(lower)) return true;
  const dot = lower.lastIndexOf('.');
  return dot > 0 && CODE_EXT.has(lower.slice(dot + 1));
}

const mode = process.argv[2];
const cwd = process.cwd();

// ---------- stdin: 只读一次(tool_input 与 session_id 都从这里来) ----------
// session 模式不读 stdin — 手动调用时 fd0 是终端, 读会一直等 EOF
let payloadCache;
function payload() {
  if (payloadCache === undefined) {
    let s = '';
    try { s = fs.readFileSync(0, 'utf8'); } catch (e) {}
    try { payloadCache = JSON.parse(s) || {}; } catch (e) { payloadCache = {}; }
  }
  return payloadCache;
}
// 没有 session_id(手动跑/测试)时回落到 nosession, 行为等同旧版「按项目一个状态文件」
function sid() {
  const s = payload().session_id;
  return (typeof s === 'string' && s) ? s : 'nosession';
}

function allow() { process.exit(0); }
function deny(msg) { console.error(msg); process.exit(2); }

// ---------- 状态: 按「项目目录 + 会话」隔离 ----------
// 两层命名: tmp/graphify-gate-<cwd md5 前12位>/<session_id>.json
// 同仓库多会话互不干扰, SessionStart 删整个项目目录即可重新武装
function stateDir() {
  const h = crypto.createHash('md5').update(cwd).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), 'graphify-gate-' + h);
}
function stateFile() { return path.join(stateDir(), sid() + '.json'); }
function readState() {
  const empty = { open: false, last: null, repeat: 0 };
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    // 状态文件被截断/写坏时可能是 null 或标量, 直接当空状态, 避免 st.open 抛 TypeError
    return (st && typeof st === 'object') ? st : empty;
  } catch (e) { return empty; }
}
// 原子写(临时文件 + rename), 避免并发读到半截 JSON; 失败返回 false
function writeState(st) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const f = stateFile();
    const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, f);
    return true;
  } catch (e) { return false; }
}

// ---------- 认图: 从 cwd 向上找, 非 git 目录同样适用 ----------
function normPath(p) {
  try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); }
}
const cwdReal = normPath(cwd);

// graphify-out/.graphify_root 存的是建图时的扫描根(绝对路径); 缺失/读不出返回 null
function builtRoot(dir) {
  try {
    const r = fs.readFileSync(path.join(dir, 'graphify-out', '.graphify_root'), 'utf8').trim();
    return r ? normPath(r) : null;
  } catch (e) { return null; }
}
function under(root, dir) { return dir === root || dir.startsWith(root + path.sep); }

// 最近的一张图生效。有 .graphify_root 时核对覆盖(当前目录必须在其之下),
// 否则会把兄弟目录的图认成自己的; 没有该文件时退回「存在即认」, 不硬依赖它
function findGraph() {
  let d = cwd;
  while (true) {
    const file = path.join(d, 'graphify-out', 'graph.json');
    if (fs.existsSync(file)) {
      const r = builtRoot(d);
      if (!r || under(r, cwdReal)) return { dir: d, file: file };
    }
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}
function graphExists() { return findGraph() !== null; }

function git(args, timeout) {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: timeout, maxBuffer: 8 * 1024 * 1024 });
  return (r.status === 0 && typeof r.stdout === 'string') ? r.stdout : null;
}

// 图过期: git 最后提交晚于 graph.json mtime, 或存在建图之后修改/新增的未跟踪文件。
// 非 git 目录不查(没有可靠变更源)。路径基准一律用仓库根 ——
// git status --porcelain 给的是根相对路径, 用 cwd 拼会在子目录里 stat 全部失败 → 恒报过期。
function stale() {
  const g = findGraph();
  if (!g) return false;
  let gm; try { gm = fs.statSync(g.file).mtimeMs; } catch (e) { return false; }
  const top = git(['-C', g.dir, 'rev-parse', '--show-toplevel'], GIT_TIMEOUT);
  if (top === null) return false;
  const root = top.trim() || g.dir;

  const log = git(['-C', root, 'log', '-1', '--format=%ct'], GIT_TIMEOUT);
  if (log !== null) {
    const ct = parseInt(log, 10);
    if (ct > 0 && ct * 1000 > gm) return true;
  }

  // -uall: 未跟踪文件也要看(建图后新建的源文件正是该重建的场景), 且新目录不被折叠成一条
  const dirty = git(['-C', root, 'status', '--porcelain', '-uall'], GIT_STATUS_TIMEOUT);
  if (dirty === null || dirty.trim() === '') return false;
  // 逐 dirty 文件比对 mtime: 建图窗口内的旧改动(建图已捕获)不误报, 只报建图后的修改
  // 注意: porcelain 行首字符是状态列 X(常为空格), 必须先按行 split 再 trimEnd,
  // 整串 trim 会吃掉行首空格导致列错位(实测踩过: 文件名被截成 '.txt' → 误判删除 → 恒报过期)。
  // ponytail: 只扫前 SCAN_LIMIT 条, 巨型脏树不全量遍历; 真需要再按目录分段或加缓存
  let n = 0;
  for (const raw of dirty.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (++n > SCAN_LIMIT) break;
    if (line[0] === 'D' || line[1] === 'D') return true;   // 删除: 图里还有, 文件已没了
    const f = line.slice(3).trim().replace(/^"|"$/g, '');
    // graphify 自己的产物不算改动(否则 graphify-out 下的新文件 mtime 必然晚于 graph.json → 自伤)
    if (!f || f.split('/').includes('graphify-out')) continue;
    // ponytail: 重命名条目(R)路径含 '->' 会 stat 失败按删除处理, 偶发误报可接受
    try { if (fs.statSync(path.join(root, f)).mtimeMs > gm) return true; } catch (e) { return true; }
  }
  return false;
}

// 过期提醒: block-once — 拦截一次让模型转达用户; staleNagged 置位后本次对话结束前不再提醒。
// 重试同一检索直接放行, 无循环。
function maybeStaleWarning(st) {
  if (st.staleNagged) return;
  if (!stale()) return;
  st.staleNagged = true;
  if (!writeState(st)) return;   // 记不住就不再提醒, 否则每次检索都报一次
  deny('提示(拦截一次): 检测到代码在图构建后有变更(git 提交或修改晚于 graph.json), 建议重建 graphify 图后再检索。' +
       '若确认无需更新, 重试同一检索即可继续(本次对话结束前不再提醒)。');
}

// 资格: (本目录或任一父目录)是 git 仓库, 或本目录浅层有 ≥2 个代码证据(见 CODE_EXT/MANIFEST)。
// 纯媒体/资料目录(仅 mp4/webp/文档等)不武装 —— graphify 首搜只服务编码/脚本场景。
// 单代码文件目录维持放行(单文件豁免), 与旧版回归用例 I1 一致。
// ponytail: 扫描上限 深度8/节点500; 更大非 git 目录慢时再加缓存
function eligible() {
  let d = cwd;
  while (true) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  const MAX_DEPTH = 8, MAX_NODES = 500;
  const stack = [[cwd, 0]];
  let n = 0, visited = 0;
  while (stack.length && visited < MAX_NODES) {
    const [dir, depth] = stack.shift();
    visited++;
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of es) {
      if (e.isDirectory()) { if (!SKIP.has(e.name) && depth < MAX_DEPTH) stack.push([path.join(dir, e.name), depth + 1]); }
      else if (e.isFile() && isCodeFile(e.name) && ++n >= 2) return true;
    }
  }
  return false;
}

function gateMsg(hasGraph) {
  return 'Blocked: ' + (hasGraph
    ? '图已存在。先跑一次图查询完成首搜 —— `graphify query "<问题>"` / `graphify path` / `graphify explain` / ' +
      '`graphify affected` / `graphify god-nodes`(或等价的 MCP 图查询),之后所有检索工具自动放开。'
    : '先按 ' + SKILL + ' 运行 graphify 建图(产出 graphify-out/graph.json),再跑一次图查询完成首搜;完成后所有检索工具自动放开。')
    + '(更换参数不算重试;同一命令连续 ' + MAX_BLOCK + ' 次被拦后自动放行)';
}

// 一次图查询(CLI 或 MCP) = 首搜完成 → 开闸
function openGate() { writeState({ open: true, last: null, repeat: 0, ts: Date.now() }); }

// 未完成首搜时拦截 + 参数校验: 同指纹连续重试才计入逃生口; 换参数计数重置。
// 返回 true = 放行; 未完成首搜时 deny() 退出进程。
function enforceGate(inputStr) {
  // 先读状态: 已开闸的目录不必每次检索都重扫资格(最多 500 个目录)
  const st = readState();
  if (st.open) { maybeStaleWarning(st); return true; }
  if (!eligible()) return true;
  const h = crypto.createHash('md5').update(inputStr).digest('hex');
  const repeat = (st.last === h) ? st.repeat + 1 : 1;
  if (repeat >= MAX_BLOCK) {
    if (!writeState({ open: true, last: h, repeat: repeat, degraded: true })) return true;
    return true;
  }
  // 写不进去就不拦: 状态落不了盘时重试计数永远凑不满, 再拦就是永久拦截
  if (!writeState({ open: false, last: h, repeat: repeat })) return true;
  deny(gateMsg(graphExists()));
}

// ---------- 逃生开关: CI / 无头场景直接关掉 ----------
// (hook 超时不阻塞工具调用, 所以这里必须显式放行, 不能靠超时)
const off = (process.env.GRAPHIFY_GATE || '').toLowerCase();
if (off === 'off' || off === '0' || off === 'false') allow();

// ---------- graphify 图查询(MCP): 图存在才开闸(防空图查询绕过) ----------
if (mode === 'graphify') {
  if (graphExists()) openGate();
  allow();   // 图不存在时放行调用本身, 但不开闸 — 查询会自然报错, 模型转向建图
}

// ---------- session: 重新武装 ----------
if (mode === 'session') {
  try { fs.rmSync(stateDir(), { recursive: true, force: true }); } catch (e) {}
  allow();
}

// ---------- bash 命令词法: 只在「命令位置」识别 grep/rg/graphify ----------
// 旧实现按子串正则匹配 " grep": `git commit -m "use grep"`、`python grep.py`、`echo grep`
// 都被误判成检索命令打回。这里按未加引号的 ; & | ( ) 换行切段, 段内按引号/空白切词,
// 只看每段实际执行的命令词(wrapper 后取被执行的命令); sh -c '…' 里的字符串递归解析。
// ponytail: 轻量词法而非完整 shell 解析器; eval/反引号等动态求值不识别(与 awk/sed 同属已知边界)
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', 'done', '!', '{', '}']);
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'time', 'timeout', 'nohup',
  'nice', 'ionice', 'stdbuf', 'xargs', 'busybox', 'wsl', 'npx', 'pnpx', 'bunx', 'uvx', 'pipx']);
const GREPS = new Set(['grep', 'egrep', 'fgrep']);
// graphify 的读命令: query / path / explain / affected / god-nodes
// (update / cluster-only / label / add / watch / install 是建图或维护, 不算首搜)
const GRAPH_READ_CMD = new Set(['query', 'path', 'explain', 'affected', 'god-nodes']);

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
const INTERESTING = new Set([...GREPS, 'rg', 'graphify', 'find', ...SHELLS]);
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

function classify(cmd, depth) {
  const res = { grep: false, rg: false, graphQuery: false };
  for (const words of segments(cmd)) {
    const i = commandAt(words);
    if (i < 0) continue;
    const name = baseName(words[i]);
    if (GREPS.has(name)) { res.grep = true; continue; }
    if (name === 'rg') { res.rg = true; continue; }
    // git grep / find -exec grep 仍是 grep 检索; 保留旧版的强制范围
    if (name === 'git' && words[i + 1] === 'grep') { res.grep = true; continue; }
    if (name === 'find') {
      for (let j = i + 1; j < words.length - 1; j++) {
        if (/^-(exec|execdir|ok)$/.test(words[j]) && GREPS.has(baseName(words[j + 1]))) res.grep = true;
      }
      continue;
    }
    if (name === 'graphify') {
      if (GRAPH_READ_CMD.has(words[i + 1])) res.graphQuery = true;
      continue;
    }
    // sh -c / bash -lc '<cmd>': 引号里的字符串本身是命令
    if (SHELLS.has(name) && depth < 3) {
      const k = words.findIndex((w, j) => j > i && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
      if (k > i && words[k + 1] !== undefined) {
        const sub = classify(words[k + 1], depth + 1);
        res.grep = res.grep || sub.grep;
        res.rg = res.rg || sub.rg;
        res.graphQuery = res.graphQuery || sub.graphQuery;
      }
    }
  }
  return res;
}

// ---------- bash: grep→rg 强制 + 图查询开闸 + 未完成首搜时拦截 ----------
if (mode === 'bash') {
  const cmd = (payload().tool_input || {}).command || '';
  const c = classify(cmd, 0);
  if (c.graphQuery) {
    if (graphExists()) openGate();
    allow();
  }
  if (!c.grep && !c.rg) allow();                  // 非搜索命令(含 graphify 建图)直接放行

  if (c.grep && spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0) {
    deny('Blocked: 请改用 rg。');
  }
  enforceGate(cmd);
  allow();
}

// ---------- file: 内置 Grep/Glob 首搜拦截 ----------
if (mode === 'file') {
  const ti = payload().tool_input || {};
  // 元数据检查豁免: 查看/定位建图产物本身不算代码检索, 否则模型连"图是否存在"都无法确认。
  // Glob 用 path 指向 graphify-out 时 pattern 只是 '*'，所以 path 也要看。
  const isMeta = (v) => typeof v === 'string' && /graphify-out|graph\.json/i.test(v);
  if (isMeta(ti.pattern) || isMeta(ti.path)) allow();
  enforceGate(JSON.stringify(ti));                // 以 tool_input(pattern/path 等)做参数指纹
  allow();
}

allow();                                          // 未知 mode: 放行
