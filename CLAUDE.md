# my-workflow 开发文档（Agent 向）

给在此仓库工作的 agent 的全部开发信息。面向用户的说明见 [README.md](README.md)。本文件是唯一开发细节来源。

## 项目定位

Claude Code 插件：marketplace 名 `my-workflow-marketplace`，插件名 `my-workflow`。单脚本 `search-gate.js` 承载全部逻辑，由 `hooks/hooks.json` 的 1 个 hook（PreToolUse:Bash）触发。目标：把「rg 替代 grep」的工具路由纪律和 sleep 时长上限做成确定性拦截。

**sleep 上限**：除非能够精确计算 sleep 时间，否则单次 sleep 时间不能超过 60 秒。超时拦截；命令前加 `SLEEP_GATE=allow` 即视为已精确计算，放行。

**rg 永远放行**——不要求建图、不要求任何前置操作。这是 1.3.0 的刻意取舍：旧版「首搜闸」（不建图就拦 rg）与用户 CLAUDE.md 的「文本搜索优先用 rg」直接冲突，文档评审等非编码 git 目录也被拦（实测），故整体移除。

## 文件布局

| 文件 | 职责 |
|------|------|
| `search-gate.js` | 全部逻辑：bash 模式 grep→rg 强制、sleep 60 秒上限 |
| `hooks/hooks.json` | hook 接线：PreToolUse(Bash) |
| `.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json` | 插件清单；**版本号两处需同步升** |
| `test-search-gate.js` | 自检 12 用例，`node test-search-gate.js`，无框架无依赖 |
| `README.md` | 用户向（功能 / 安装 / 依赖），不含开发细节 |
| `CLAUDE.md` | 本文件，Agent 向 |

## 模式表

| 模式 | 触发 | 职责 |
|------|------|------|
| bash | PreToolUse(Bash) | grep/egrep/fgrep 打回换 rg（含全路径 `/bin/grep`、引号包裹、`sh -c` 递归、`git grep`、`find -exec grep`）；rg 缺失时放行兜底。单次 sleep > 60 秒打回（`SLEEP_GATE=allow` 前缀放行；算不出时长如变量则放行） |

## grep 识别（命令位置词法解析，v5.3 保留）

- 按未加引号的 `; & | ( )` 换行切段，段内按引号/空白切词，只看每段实际执行的命令词；`sh -c '…'` 里的字符串递归解析（深度上限 3）。
- 跳过 `FOO=1` 前缀、`if/do` 关键字与 `sudo/env/xargs/timeout` 等 wrapper，wrapper 后取被执行的命令（能处理 `sudo -u root grep`）。
- 误拦防线：`git commit -m "use grep"`、`python grep.py`、`echo rg` 等参数位置的同名词不打回。
- 漏拦防线：`/bin/grep`（全路径）、带引号包裹、`sh -c 'grep …'`、`git grep`、`find -exec grep` 同样命中。
- ponytail: 轻量词法而非完整 shell 解析器；eval/反引号等动态求值不识别（与 awk/sed 同属已知边界）。

## 调参（`search-gate.js` 顶部）

- `GRAPHIFY_GATE`（环境变量）：`off` / `0` / `false` 时整个插件放行（CI / 无头场景逃生口，含 grep→rg 强制一并关闭）。
- `SLEEP_GATE`（环境变量）：`off` / `0` / `false` 时只关闭 sleep 上限；命令内的 `SLEEP_GATE=allow` 前缀声明单次精确等待。
- `SLEEP_LIMIT`：sleep 秒数上限，默认 60。
- 词法相关集合（`GREPS` / `WRAPPERS` / `SHELLS`）按需扩充；无其他可调参数。

## 已知边界

- 黑名单不含 awk/sed/findstr 等替代搜索——目标是路由教育，不是完美强制。
- 只拦 Bash 里的 grep；内置 Grep 工具本身是 ripgrep，不拦。
- 只拦「搜索」，不拦 Read（指名读文件永远自由）。
- grep→rg 强制全局生效（含非编码目录）：工具路由教育，与目录场景无关。
- eval/反引号等动态求值里的 grep 识别不了（轻量词法的边界）。
- sleep 时长只认字面量（`90`、`1m`、`1m30s`、`1.5h`）；参数是变量/命令替换时算不出，放行不管——上限针对的是模型随手写长 sleep，不是防绕过。
- 后台 sleep（`&`）与循环内的 sleep 同样受单次上限约束；频繁短 sleep 不拦。

## 测试

**自检（入库）：`node test-search-gate.js`** —— 22 用例，无框架无依赖（rg 缺失时强制类用例跳过）。用例组：

- J1-J5 grep→rg 强制（基础 / `/bin/grep` 全路径 / 全路径 egrep / `sh -c` 递归 / `git grep`）
- G1 媒体目录路径下 grep 仍强制（全局生效）
- E1 `GRAPHIFY_GATE=off` 放行（逃生开关）
- J6-J8 不误拦（commit 消息里的 grep / 文件名 grep.py / 参数里的 rg）
- J9-J10 rg 永远放行（全路径 rg / `sh -c` 里的 rg——v6 无首搜闸回归）
- S1-S10 sleep 上限（`sleep 90` / `1m30s` / `sh -c` 递归 / wrapper 后；`sleep 60` 与短 sleep 放行；注释与提交消息里的时长不误拦；`SLEEP_GATE=allow` 与 `SLEEP_GATE=off` 放行）

**历史记录（旧版首搜闸的测试装置与实战，1.3.0 起不再适用）**：单元级 8 组 49 用例（全过）；headless `claude -p` 实战 3 轮（Windows 11 实机，rg 15.2.0 / node 24.19 / claude 2.1.282）。Round 2 完整走通 Grep 拦截 → 建图 7 步 → query 开闸 → 放行；Round 3 验证过期提醒 block-once。移除原因见上「项目定位」。

## 开发中抓出的真实缺陷（现行相关，勿回退）

1. 异步 stdin 监听 + `process.exit` 竞争 → 拦截逻辑静默失效。改 `fs.readFileSync(0)` 同步读。
2. grep 前导字符只认空白/管道等 → `/bin/grep`（前导 `/`）、`sh -c 'grep …'`（前导引号）不匹配。前导字符类补 `/`、引号、`(`（v5.2）。
3. 检索命令用子串正则匹配 → 引号/参数里的同名词（`git commit -m "use grep"`、`python grep.py`、`echo rg`）被误拦；反过来 `/usr/bin/rg`、带引号的 rg 又漏拦。v5.3 改为命令位置词法解析（按未引号 `; & | ( )` 切段、看实际命令词、递归解析 `sh -c`）。

**随首搜闸移除而失效的旧缺陷记录（1.3.0 前修复，相关代码已删，仅存档）**：空图查询开闸绕过；`dirty.stdout` 整串 trim 吃掉行首列空格；认图向上查找 + `.graphify_root` 覆盖校验；porcelain 路径按仓库根拼接；状态按「项目 + 会话」隔离；状态写失败放行；资格收敛为代码证据（≥2，纯媒体目录不武装）；html/htm 不计证据；状态文件损坏按空状态；已开闸跳过资格重扫；Windows 测试 harness 需 `TMPDIR`+`TEMP`+`TMP` 三件套。

## 版本历史

- 1.4.0（v6.1）：新增 sleep 上限——单次 sleep 超过 60 秒打回，`SLEEP_GATE=allow` 前缀声明精确等待；`SLEEP_GATE=off` 环境变量单独关闭；命令词法抽出 `walk` 复用；注释剥离；新增 S1-S10（共 22 用例）。对应规则从用户全局 CLAUDE.md 迁入插件，软硬双约束。
- 1.3.0（v6）：删除首搜闸、图过期提醒及全部状态/资格/认图代码——「不建图就拦 rg」与「rg 优先」的检索约定冲突（实测文档评审场景被拦）。只留 grep→rg 强制，rg 永远放行；hooks 收敛为单个 PreToolUse(Bash)；测试 39 → 12 用例。
- 1.2.3（v5.3）：命令位置词法解析——引号/参数里的 grep/rg/graphify 不再误拦，`/usr/bin/rg`、带引号 rg、全路径 graphify 不再漏拦；Glob 的 `path` 指向 graphify-out 时豁免；状态文件损坏不崩溃；已开闸目录跳过资格重扫；新增 F2/J5-J8/N10-N11（共 39 用例）。
- 1.2.2（v5.2）：`/bin/grep` 等全路径/引号包裹的 grep 变体同样打回换 rg——`isGrep` 前导字符类补 `/` `'` `"` `(`；新增 J2/J3/J4（共 32 用例）。
- 1.2.1（v5.1）：html/htm 从代码证据剔除——文档库的报告/页面导出物（实测 GLB-DOC：12 个 html 导出 + 1 个 py）不再误武装；Web 项目由清单 + js/ts 兜底；新增 N8/N9（共 29 用例）。
- 1.2.0（v5）：资格收敛为代码证据（≥2），纯媒体目录不再武装；新增 N 组 7 用例（共 27）；harness 修 Windows 临时目录；文档拆分 README（用户向）/ CLAUDE.md（Agent 向），删除 info.md。
- 1.1.0：开闸认 CLI 读命令；认图向上 + `.graphify_root` 覆盖校验；状态按「项目 + 会话」；写不进放行；过期检测 `-uall` + 仓库根基准 + 排除 graphify 产物；20 用例入库。
- 1.0.0：首版——首搜闸、rg 强制、新鲜度提醒。

升版本时同步 `.claude-plugin/plugin.json` 与 `.claude-plugin/marketplace.json` 两处。
