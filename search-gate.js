// search-gate.js v3 — 测试版
// bash     → PreToolUse(Bash): ① grep→rg 强制(rg 缺失兜底) ② 闸门未开时拦截 rg 搜索
// file     → PreToolUse(Grep|Glob): 闸门未开时拦截内置搜索工具
// graphify → PreToolUse(mcp__graphify.*): 图存在时的图查询 = 首搜完成, 开闸并放行
// session  → SessionStart: 清状态, 新会话重新武装
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
const MAX_BLOCK = 3;   // 逃生口: 同一参数连续 N 次被拦才自动放行; 不同参数不算重试
const SKILL = '~/.claude/skills/graphify/SKILL.md';

const mode = process.argv[2];
const cwd = process.cwd();

function stateFile() {
  const h = crypto.createHash('md5').update(cwd).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), 'graphify-gate-' + h + '.json');
}
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); }
  catch (e) { return { open: false, last: null, repeat: 0 }; }
}
function writeState(st) { try { fs.writeFileSync(stateFile(), JSON.stringify(st)); } catch (e) {} }
function allow() { process.exit(0); }
function deny(msg) { console.error(msg); process.exit(2); }

function graphExists() { return fs.existsSync(path.join(cwd, 'graphify-out', 'graph.json')); }

// 图新鲜度: git 最后提交晚于 graph.json mtime, 或存在建图之后修改的 tracked 文件 → 过期。
// 非 git 目录跳过(无可靠变更源)。
// ponytail: 每次检索触发都探测(两次 git 调用 ~100ms); 巨型仓库 git status 变慢时再加节流或只看提交时间。
function stale() {
  const g = path.join(cwd, 'graphify-out', 'graph.json');
  if (!graphExists()) return false;
  const gm = fs.statSync(g).mtimeMs;
  const log = spawnSync('git', ['-C', cwd, 'log', '-1', '--format=%ct'], { encoding: 'utf8' });
  if (log.status === 0 && parseInt(log.stdout, 10) * 1000 > gm) return true;
  const dirty = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '-uno'], { encoding: 'utf8' });
  if (dirty.status !== 0 || dirty.stdout.trim() === '') return false;
  // 逐 dirty 文件比对 mtime: 建图窗口内的旧改动(建图已捕获)不误报, 只报建图后的修改
  // 注意: porcelain 行首字符是状态列 X(常为空格), 必须先按行 split 再 trimEnd,
  // 整串 trim 会吃掉行首空格导致列错位(实测踩过: 文件名被截成 '.txt' → 误判删除 → 恒报过期)。
  // ponytail: 重命名条目(R)路径含 '->' 会 stat 失败按删除处理, 偶发误报可接受
  for (const raw of dirty.stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (line[0] === 'D' || line[1] === 'D') return true;   // 删除: 图里还有, 文件已没了
    const f = line.slice(3).trim().replace(/^"|"$/g, '');
    try { if (fs.statSync(path.join(cwd, f)).mtimeMs > gm) return true; } catch (e) { return true; }
  }
  return false;
}

// 过期提醒: block-once — 拦截一次让模型转达用户; staleNagged 置位后本次对话结束前不再提醒。
// 重试同一检索直接放行, 无循环。
function maybeStaleWarning(st) {
  if (st.staleNagged) return;
  if (stale()) {
    st.staleNagged = true;
    writeState(st);
    deny('提示(拦截一次): 检测到代码在图构建后有变更(git 提交或修改晚于 graph.json), 建议重建 graphify 图后再检索。' +
         '若确认无需更新, 重试同一检索即可继续(本次对话结束前不再提醒)。');
  }
}

// 闸门资格: (本目录或任一父目录)是 git 仓库, 或本目录 ≥2 个文件
function eligible() {
  let d = cwd;
  while (true) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  let n = 0;
  const stack = [cwd];
  while (stack.length && n < 2) {
    const dir = stack.pop();
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of es) {
      if (e.isDirectory()) { if (!SKIP.has(e.name)) stack.push(path.join(dir, e.name)); }
      else if (e.isFile()) n++;
      if (n >= 2) break;
    }
  }
  return n >= 2;
}

function gateMsg(hasGraph) {
  return 'Blocked: ' + (hasGraph
    ? '图已存在。先调用一次 graphify 查询（query_graph / shortest_path / god_nodes）完成首搜，之后所有检索工具自动放开。'
    : '先按 ' + SKILL + ' 运行 graphify 建图（产出 graphify-out/graph.json），再调用一次 graphify 查询完成首搜；完成后所有检索工具自动放开。')
    + '（更换参数不算重试；同一命令连续 ' + MAX_BLOCK + ' 次被拦后自动放行）';
}

// 首搜闸核心 + 参数校验: 同指纹连续重试才计入逃生口; 换参数计数重置。
// 返回 true = 放行; 闸门关闭时 deny() 退出进程。
function enforceGate(inputStr) {
  if (!eligible()) return true;
  const st = readState();
  if (st.open) { maybeStaleWarning(st); return true; }
  const h = crypto.createHash('md5').update(inputStr).digest('hex');
  const repeat = (st.last === h) ? st.repeat + 1 : 1;
  if (repeat >= MAX_BLOCK) {
    writeState({ open: true, last: h, repeat, degraded: true });
    return true;
  }
  writeState({ open: false, last: h, repeat });
  deny(gateMsg(graphExists()));
}

// ---------- graphify 查询: 图存在才开闸(防空图查询绕过) ----------
if (mode === 'graphify') {
  if (graphExists()) writeState({ open: true, last: null, repeat: 0, ts: Date.now() });
  allow();   // 图不存在时放行调用本身, 但不开闸 — 查询会自然报错, 模型转向建图
}

// ---------- session: 重新武装 ----------
if (mode === 'session') {
  try { fs.unlinkSync(stateFile()); } catch (e) {}
  allow();
}

// ---------- bash: grep→rg 强制 + rg 首搜闸 ----------
if (mode === 'bash') {
  let s = ''; try { s = fs.readFileSync(0, 'utf8'); } catch (e) {}
  let cmd = '';
  try { cmd = JSON.parse(s).tool_input.command || ''; } catch (e) {}
  const isGrep = /(^|[|;&\s])(e|f)?grep\b/.test(cmd);
  const isRgSearch = /(^|[|;&\s])rg\b/.test(cmd);
  if (!isGrep && !isRgSearch) allow();            // 非搜索命令(含 graphify 建图)直接放行

  if (isGrep && spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0) {
    deny('Blocked: 请改用 rg。');
  }
  enforceGate(cmd);
  allow();
}

// ---------- file: 内置 Grep/Glob 首搜闸 ----------
if (mode === 'file') {
  let s = ''; try { s = fs.readFileSync(0, 'utf8'); } catch (e) {}
  let ti = {};
  try { ti = JSON.parse(s).tool_input || {}; } catch (e) {}
  // 元数据检查豁免: 查看/定位建图产物本身不算代码检索, 否则模型连"图是否存在"都无法确认
  if (typeof ti.pattern === 'string' && /graphify-out|graph\.json/i.test(ti.pattern)) allow();
  enforceGate(JSON.stringify(ti));                // 以 tool_input(pattern/path 等)做参数指纹
  allow();
}

allow();                                          // 未知 mode: 放行
