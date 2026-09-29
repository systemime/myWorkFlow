// 自检: node test-search-gate.js
// 造临时目录当样本, 用子进程按各模式跑 search-gate.js, 断言退出码与 stderr。
// 退出码: 0 = 放行, 2 = 拦截(hook 语义)。无框架, 无外部依赖(git 与 rg 缺失时相关用例跳过)。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'search-gate.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-test-'));
let pass = 0, fail = 0, skipped = 0;

const NOW = Date.now();
const T = { old: new Date(NOW - 120000), mid: new Date(NOW - 90000), graph: new Date(NOW - 60000), new: new Date(NOW - 30000) };

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function put(p, s) { mkdirp(path.dirname(p)); fs.writeFileSync(p, s); }
function touch(p, when) { fs.utimesSync(p, when, when); }
function has(cmd) { return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0; }

// 每个用例独立的 TMPDIR: 状态文件互不串台; GRAPHIFY_GATE 从继承环境里摘掉
function run(mode, pl, cwd, tmp) {
  const env = Object.assign({}, process.env, { TMPDIR: tmp });
  delete env.GRAPHIFY_GATE;
  const r = spawnSync(process.execPath, [SCRIPT, mode], {
    cwd, input: JSON.stringify(pl || {}), encoding: 'utf8', env,
  });
  return { code: r.status, err: r.stderr || '' };
}
const search = (tmp, cwd, sid, cmd) =>
  run('bash', { session_id: sid, tool_input: { command: cmd || 'rg foo .' } }, cwd, tmp);
// 走 MCP 那条路开闸: 新旧版都支持, 不掺进 CLI 开闸那个 bug, 好隔离各自要测的行为
const openGate = (tmp, cwd, sid) => run('graphify', { session_id: sid }, cwd, tmp);

function caseTmp(name) { const d = path.join(ROOT, name); mkdirp(d); return d; }
function fakeGraph(dir, rootPath, when) {
  put(path.join(dir, 'graphify-out', 'graph.json'), '{"nodes":[],"links":[]}');
  put(path.join(dir, 'graphify-out', '.graphify_root'), rootPath);   // 真实产物无尾换行
  touch(path.join(dir, 'graphify-out', 'graph.json'), when || T.graph);
}
function repo(dir, commitAt) {
  mkdirp(dir);
  const env = Object.assign({}, process.env, {
    GIT_AUTHOR_DATE: commitAt.toISOString(), GIT_COMMITTER_DATE: commitAt.toISOString(),
  });
  const g = (...a) => spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8', env });
  g('init', '-q');
  return g;
}
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  [' + String(detail).slice(0, 120) + ']' : '')); }
}
function skip(name, why) { skipped++; console.log('  skip  ' + name + '  (' + why + ')'); }

// ---------- A. 非 git 子目录 + 上层有图 → 认得图, 且不误报过期 ----------
{
  const t = caseTmp('A');
  const proj = path.join(t, 'proj'), sub = path.join(proj, 'sub');
  put(path.join(sub, 'a.js'), 'a'); put(path.join(sub, 'b.js'), 'b');
  fakeGraph(proj, proj, T.graph);

  const blocked = search(t, sub, 'A', 'rg foo .');
  check('A1 子目录首搜被拦', blocked.code === 2, 'code=' + blocked.code);
  check('A2 提示认得上层图', /图已存在/.test(blocked.err), blocked.err);

  const q = search(t, sub, 'A', 'graphify query "x"');
  check('A3 graphify query 放行', q.code === 0 && q.err === '', 'code=' + q.code + ' ' + q.err);

  const after = search(t, sub, 'A', 'rg foo .');
  check('A4 查询后检索放行', after.code === 0, 'code=' + after.code + ' ' + after.err);
  check('A5 非 git 目录不报过期', !/建议重建/.test(after.err), after.err);
}

// ---------- B. .graphify_root 指向别处 → 不算自己的图 ----------
{
  const t = caseTmp('B');
  const proj = path.join(t, 'proj'), sub = path.join(proj, 'sub'), other = path.join(t, 'other');
  put(path.join(sub, 'a.js'), 'a'); put(path.join(sub, 'b.js'), 'b');
  mkdirp(other);
  fakeGraph(proj, other, T.graph);

  const r = search(t, sub, 'B');
  check('B1 兄弟目录的图不认', r.code === 2 && /先按/.test(r.err), 'code=' + r.code + ' ' + r.err);
}

// ---------- C. 子目录里的旧改动(建图前)不误报过期 ----------
{
  const t = caseTmp('C');
  const r0 = path.join(t, 'repo'), sub = path.join(r0, 'sub');
  const g = repo(r0, T.old);
  put(path.join(sub, 'x.js'), 'one\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  fs.appendFileSync(path.join(sub, 'x.js'), 'two\n');   // 制造 tracked 改动
  touch(path.join(sub, 'x.js'), T.mid);                 // 改动早于建图
  fakeGraph(r0, r0, T.graph);

  openGate(t, sub, 'C');
  const r = search(t, sub, 'C');
  check('C1 建图前的旧改动不报过期', r.code === 0 && !/建议重建/.test(r.err), 'code=' + r.code + ' ' + r.err);
}

// ---------- D. 建图后新增的未跟踪源文件 → 报过期(拦截一次, 重试放行) ----------
{
  const t = caseTmp('D');
  const r0 = path.join(t, 'repo'), sub = path.join(r0, 'sub');
  const g = repo(r0, T.old);
  put(path.join(sub, 'x.js'), 'one\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  fakeGraph(r0, r0, T.graph);
  put(path.join(sub, 'new.js'), 'new\n');
  touch(path.join(sub, 'new.js'), T.new);

  openGate(t, sub, 'D');
  const first = search(t, sub, 'D');
  check('D1 新建未跟踪文件报过期', first.code === 2 && /建议重建/.test(first.err), 'code=' + first.code + ' ' + first.err);
  const second = search(t, sub, 'D');
  check('D2 重试即放行(只拦一次)', second.code === 0, 'code=' + second.code + ' ' + second.err);
}

// ---------- E. graphify-out 内的新文件不算改动 ----------
{
  const t = caseTmp('E');
  const r0 = path.join(t, 'repo'), sub = path.join(r0, 'sub');
  const g = repo(r0, T.old);
  put(path.join(sub, 'x.js'), 'one\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  fakeGraph(r0, r0, T.graph);
  put(path.join(r0, 'graphify-out', 'cache', 'blob'), 'x');
  touch(path.join(r0, 'graphify-out', 'cache', 'blob'), T.new);

  openGate(t, sub, 'E');
  const r = search(t, sub, 'E');
  check('E1 图产物自身不算改动', r.code === 0 && !/建议重建/.test(r.err), 'code=' + r.code + ' ' + r.err);
}

// ---------- F. 建图/维护类命令不开闸 ----------
{
  const t = caseTmp('F');
  const proj = path.join(t, 'proj'), sub = path.join(proj, 'sub');
  put(path.join(sub, 'a.js'), 'a'); put(path.join(sub, 'b.js'), 'b');
  fakeGraph(proj, proj, T.graph);

  search(t, sub, 'F', 'graphify update .');
  const r = search(t, sub, 'F');
  check('F1 graphify update 不开闸', r.code === 2, 'code=' + r.code);
}

// ---------- G. 两个会话的状态互不影响 ----------
// 图放在当前目录: 新旧版都能开闸, 差异只剩状态文件是否按会话分开
{
  const t = caseTmp('G');
  const sub = path.join(t, 'proj');
  put(path.join(sub, 'a.js'), 'a'); put(path.join(sub, 'b.js'), 'b');
  fakeGraph(sub, sub, T.graph);

  openGate(t, sub, 'G1');
  const a = search(t, sub, 'G1');   // 已开闸
  const b = search(t, sub, 'G2');   // 新会话, 未首搜
  check('G1 A 会话已放行', a.code === 0, 'code=' + a.code);
  check('G2 B 会话仍被拦', b.code === 2, 'code=' + b.code + ' ' + b.err);
}

// ---------- H. 状态写不进磁盘 → 放行(不永久拦截) ----------
{
  const t = caseTmp('H');
  const proj = path.join(t, 'proj'), sub = path.join(proj, 'sub');
  put(path.join(sub, 'a.js'), 'a'); put(path.join(sub, 'b.js'), 'b');
  put(path.join(t, 'blocker'), 'x');                     // TMPDIR 落到普通文件下 → mkdir ENOTDIR
  const badTmp = path.join(t, 'blocker', 'nope');

  const r = run('bash', { session_id: 'H', tool_input: { command: 'rg foo .' } }, sub, badTmp);
  check('H1 状态写不进去仍放行', r.code === 0, 'code=' + r.code + ' ' + r.err);
}

// ---------- L. 图就建在当前子目录里(隔离测路径基准) ----------
// 旧版用 cwd 拼 porcelain 的根相对路径 → stat 必失败 → 恒报过期
{
  const t = caseTmp('L');
  const r0 = path.join(t, 'repo'), sub = path.join(r0, 'sub');
  const g = repo(r0, T.old);
  put(path.join(sub, 'x.js'), 'one\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  fs.appendFileSync(path.join(sub, 'x.js'), 'two\n');
  touch(path.join(sub, 'x.js'), T.mid);                 // 改动早于建图
  fakeGraph(sub, sub, T.graph);                         // 图在子目录

  openGate(t, sub, 'L');
  const r = search(t, sub, 'L');
  check('L1 子目录里的图仍按仓库根比对路径', r.code === 0 && !/建议重建/.test(r.err), 'code=' + r.code + ' ' + r.err);
}

// ---------- M. 图在当前目录, 新建未跟踪文件(隔离测 -uall) ----------
// 旧版 -uno 不看未跟踪文件 → 新建源文件不报过期
{
  const t = caseTmp('M');
  const r0 = path.join(t, 'repo');
  const g = repo(r0, T.old);
  put(path.join(r0, 'x.js'), 'one\n');
  g('add', '-A'); g('commit', '-qm', 'init');
  fakeGraph(r0, r0, T.graph);
  put(path.join(r0, 'new.js'), 'new\n');
  touch(path.join(r0, 'new.js'), T.new);

  openGate(t, r0, 'M');
  const r = search(t, r0, 'M');
  check('M1 未跟踪新文件报过期', r.code === 2 && /建议重建/.test(r.err), 'code=' + r.code + ' ' + r.err);
}

// ---------- I. 回归: 单文件目录不拦 ----------
{
  const t = caseTmp('I');
  const solo = path.join(t, 'solo');
  put(path.join(solo, 'only.js'), 'x');
  const r = search(t, solo, 'I');
  check('I1 单文件目录放行', r.code === 0, 'code=' + r.code + ' ' + r.err);
}

// ---------- J. 回归: grep 打回换 rg ----------
{
  const t = caseTmp('J');
  const d = path.join(t, 'd');
  put(path.join(d, 'a.js'), 'a'); put(path.join(d, 'b.js'), 'b');
  if (!has('rg')) skip('J1 grep→rg 强制', 'rg 不在 PATH');
  else {
    const r = search(t, d, 'J', 'grep -rn foo .');
    check('J1 grep→rg 强制', r.code === 2 && /请改用 rg/.test(r.err), 'code=' + r.code + ' ' + r.err);
  }
}

// ---------- K. 回归: 同一命令连拦 3 次后放行 ----------
{
  const t = caseTmp('K');
  const d = path.join(t, 'd');
  put(path.join(d, 'a.js'), 'a'); put(path.join(d, 'b.js'), 'b');
  const a = search(t, d, 'K'); const b = search(t, d, 'K'); const c = search(t, d, 'K');
  check('K1 前两次拦', a.code === 2 && b.code === 2, 'codes=' + [a.code, b.code].join(','));
  check('K2 第三次放行', c.code === 0, 'code=' + c.code + ' ' + c.err);
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ': ' + pass + ' passed, ' + fail + ' failed, ' + skipped + ' skipped');
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
