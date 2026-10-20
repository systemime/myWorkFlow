// 自检: node test-search-gate.js
// 用子进程按 bash 模式跑 search-gate.js, 断言退出码与 stderr。
// 退出码: 0 = 放行, 2 = 拦截(hook 语义)。无框架, 无外部依赖(rg 缺失时强制类用例跳过)。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'search-gate.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-test-'));
let pass = 0, fail = 0, skipped = 0;

function has(cmd) { return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0; }

// GRAPHIFY_GATE 从继承环境里摘掉; extra 可注入环境变量
function run(cmd, extra) {
  const env = Object.assign({}, process.env);
  delete env.GRAPHIFY_GATE;
  if (extra) Object.assign(env, extra);
  const r = spawnSync(process.execPath, [SCRIPT, 'bash'], {
    cwd: ROOT, input: JSON.stringify({ tool_input: { command: cmd } }), encoding: 'utf8', env,
  });
  return { code: r.status, err: r.stderr || '' };
}
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  [' + String(detail).slice(0, 120) + ']' : '')); }
}
function skip(name, why) { skipped++; console.log('  skip  ' + name + '  (' + why + ')'); }
const forced = (r) => r.code === 2 && /请改用 rg/.test(r.err);

// ---------- J. grep→rg 强制(v5.2/v5.3 词法回归组) ----------
if (!has('rg')) {
  skip('J1-J5/G1/E1 grep→rg 强制类', 'rg 不在 PATH');
} else {
  const j1 = run('grep -rn foo .');
  check('J1 grep→rg 强制', forced(j1), j1.code + ' ' + j1.err);

  // 全路径/引号包裹的 grep 同样打回(实测 agent 用 /bin/grep 绕过)
  const j2 = run('/bin/grep -rn foo .');
  check('J2 /bin/grep 也强制', forced(j2), j2.code + ' ' + j2.err);
  const j3 = run('/usr/bin/egrep foo .');
  check('J3 全路径 egrep 也强制', forced(j3), j3.code + ' ' + j3.err);
  const j4 = run("sh -c 'grep -rn foo .'");
  check('J4 引号内 grep 也强制', forced(j4), j4.code + ' ' + j4.err);
  const j5 = run('git grep -n foo');
  check('J5 git grep 也强制', forced(j5), j5.code + ' ' + j5.err);

  // 非编码目录同样强制 —— 路由教育与目录场景无关(v1.2.0 前的旧行为保留)
  const media = path.join(ROOT, 'media');
  fs.mkdirSync(media, { recursive: true });
  fs.writeFileSync(path.join(media, 'a.mp4'), 'x');
  const g1 = run('cd ' + JSON.stringify(media) + ' && grep -rn foo .');
  check('G1 媒体目录路径下 grep 仍强制', forced(g1), g1.code + ' ' + g1.err);

  // 逃生开关: 整体关闭后 grep 放行
  const e1 = run('grep -rn foo .', { GRAPHIFY_GATE: 'off' });
  check('E1 GRAPHIFY_GATE=off 放行', e1.code === 0 && e1.err === '', e1.code + ' ' + e1.err);
}

// ---------- 非 grep 命令不误拦(v5.3 词法回归组) ----------
const j6 = run('git commit -m "use grep"');
check('J6 消息文本里的 grep 不误拦', j6.code === 0 && j6.err === '', j6.code + ' ' + j6.err);
const j7 = run('python grep.py');
check('J7 文件名 grep.py 不误拦', j7.code === 0 && j7.err === '', j7.code + ' ' + j7.err);
const j8 = run('echo rg');
check('J8 参数里的 rg 不误拦', j8.code === 0 && j8.err === '', j8.code + ' ' + j8.err);

// ---------- rg 永远放行(v6: 无首搜闸) ----------
const j9 = run('/usr/bin/rg foo .');
check('J9 全路径 rg 放行', j9.code === 0 && j9.err === '', j9.code + ' ' + j9.err);
const j10 = run("sh -c 'rg foo .'");
check('J10 sh -c 里的 rg 放行', j10.code === 0 && j10.err === '', j10.code + ' ' + j10.err);

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ': ' + pass + ' passed, ' + fail + ' failed, ' + skipped + ' skipped');
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
