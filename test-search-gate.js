// 自检: node test-search-gate.js
// 用子进程按 bash / stop 模式跑 search-gate.js, 断言退出码与 stderr。
// 退出码: 0 = 放行, 2 = 拦截(hook 语义)。无框架, 无外部依赖(rg 缺失时强制类用例跳过)。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'search-gate.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-test-'));
let pass = 0, fail = 0, skipped = 0;

function has(cmd) { return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0; }

// GRAPHIFY_GATE / SLEEP_GATE 从继承环境里摘掉; extra 可注入环境变量
function run(cmd, extra) {
  const env = Object.assign({}, process.env);
  delete env.GRAPHIFY_GATE;
  delete env.SLEEP_GATE;
  delete env.DEPLOY_GATE;
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
const sleepBlocked = (r) => r.code === 2 && /60 秒/.test(r.err);
const allowed = (r) => r.code === 0 && r.err === '';

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

// ---------- S. sleep 上限(v6.1) ----------
const s1 = run('sleep 90');
check('S1 sleep 90 拦截', sleepBlocked(s1), s1.code + ' ' + s1.err);
const s2 = run('sleep 1m30s');
check('S2 sleep 1m30s 拦截', sleepBlocked(s2), s2.code + ' ' + s2.err);
const s3 = run("sh -c 'sleep 90'");
check('S3 引号内 sleep 90 拦截', sleepBlocked(s3), s3.code + ' ' + s3.err);
const s4 = run('timeout 5 sleep 90');
check('S4 wrapper 后的 sleep 90 拦截', sleepBlocked(s4), s4.code + ' ' + s4.err);
const s5 = run('sleep 60');
check('S5 sleep 60 放行(不超过 60 秒)', allowed(s5), s5.code + ' ' + s5.err);
const s6 = run('sleep 30 && echo ok');
check('S6 sleep 30 放行', allowed(s6), s6.code + ' ' + s6.err);
const s7 = run('sleep 45 # 等 90 秒的注释');
check('S7 注释里的时长不误拦', allowed(s7), s7.code + ' ' + s7.err);
const s8 = run('git commit -m "sleep 90"');
check('S8 提交消息里的 sleep 不误拦', allowed(s8), s8.code + ' ' + s8.err);
const s9 = run('SLEEP_GATE=allow sleep 90');
check('S9 显式声明精确等待时放行', allowed(s9), s9.code + ' ' + s9.err);
const s10 = run('sleep 90', { SLEEP_GATE: 'off' });
check('S10 SLEEP_GATE=off 放行', allowed(s10), s10.code + ' ' + s10.err);

// ---------- D. 部署拦截(v6.3) ----------
const deployBlocked = (r) => r.code === 2 && /对外变更/.test(r.err);
const d1 = run('git push origin main');
check('D1 git push 拦截', deployBlocked(d1), d1.code + ' ' + d1.err);
const d2 = run('git merge fix/x --no-ff');
check('D2 git merge 拦截', deployBlocked(d2), d2.code + ' ' + d2.err);
const d3 = run('docker restart isoc-c-vas');
check('D3 docker restart 拦截', deployBlocked(d3), d3.code + ' ' + d3.err);
const d4 = run('scp -q a.jar root@172.16.2.204:/tmp/');
check('D4 scp 远程目标拦截', deployBlocked(d4), d4.code + ' ' + d4.err);
const d5 = run('rsync -a dist/ root@172.16.4.77:/opt/');
check('D5 rsync 远程目标拦截', deployBlocked(d5), d5.code + ' ' + d5.err);
const d6 = run('DEPLOY_GATE=allow git push origin main');
check('D6 DEPLOY_GATE=allow 放行', allowed(d6), d6.code + ' ' + d6.err);
const d7 = run('git status && git commit -m "x"');
check('D7 提交/查状态不误拦', allowed(d7), d7.code + ' ' + d7.err);
const d8 = run('rsync -a build/ dist/');
check('D8 本地 rsync 不误拦', allowed(d8), d8.code + ' ' + d8.err);
const d9 = run("ssh qifeng@172.16.2.204 'cd repo && git log -1'");
check('D9 ssh 远程读操作不误拦', allowed(d9), d9.code + ' ' + d9.err);
const d10 = run('git push origin main', { DEPLOY_GATE: 'off' });
check('D10 DEPLOY_GATE=off 放行', allowed(d10), d10.code + ' ' + d10.err);

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

// ---------- W. 输出禁用词(v6.2) ----------
// Stop 模式吃 {transcript_path, stop_hook_active}, transcript 是 JSONL
function runStop(entries, extra, hookActive) {
  const env = Object.assign({}, process.env);
  delete env.GRAPHIFY_GATE; delete env.SLEEP_GATE; delete env.WORDS_GATE;
  if (extra) Object.assign(env, extra);
  const tp = path.join(ROOT, 'stop-' + (++runStop.n) + '.jsonl');
  fs.writeFileSync(tp, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  const r = spawnSync(process.execPath, [SCRIPT, 'stop'], {
    cwd: ROOT,
    input: JSON.stringify({ transcript_path: tp, stop_hook_active: !!hookActive }),
    encoding: 'utf8', env,
  });
  return { code: r.status, err: r.stderr || '' };
}
const A = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const wordsBlocked = (r) => r.code === 2 && /禁用词/.test(r.err);

const w1 = runStop([A('打开抽屉看看结构')]);
check('W1 回答含「抽屉」拦截', wordsBlocked(w1), w1.code + ' ' + w1.err);
const w2 = runStop([A('这是值错位导致的')]);
check('W2 回答含「值错位」拦截', wordsBlocked(w2), w2.code + ' ' + w2.err);
const w3 = runStop([A('把这一项挪到另一栏')]);
check('W3 干净回答放行', allowed(w3), w3.code + ' ' + w3.err);
const w4 = runStop([{ type: 'assistant', message: { content: [{ type: 'tool_use', input: { command: "grep '抽屉' x" } }] } }]);
check('W4 工具参数里的同名词不算输出', allowed(w4), w4.code + ' ' + w4.err);
const w5 = runStop([A('旧回答提到抽屉'), A('回答干净')]);
check('W5 只看最后一条回答', allowed(w5), w5.code + ' ' + w5.err);
const w6 = runStop([A('抽屉')], { WORDS_GATE: 'off' });
check('W6 WORDS_GATE=off 放行', allowed(w6), w6.code + ' ' + w6.err);
const w7 = runStop([A('引用原文「抽屉」同样要拦')]);
check('W7 引用语境同样拦截', wordsBlocked(w7), w7.code + ' ' + w7.err);

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ': ' + pass + ' passed, ' + fail + ' failed, ' + skipped + ' skipped');
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
