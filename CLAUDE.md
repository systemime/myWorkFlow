# my-workflow 开发文档（Agent 向）

给在此仓库工作的 agent 的全部开发信息。面向用户的说明见 [README.md](README.md)。原 info.md 已整合至此并删除，本文件是唯一开发细节来源。

## 项目定位

Claude Code 插件：marketplace 名 `my-workflow-marketplace`，插件名 `my-workflow`。单脚本 `search-gate.js` 承载全部逻辑，由 `hooks/hooks.json` 的 4 个 hook 触发。目标：把「graphify 优先、rg 替代 grep」的检索纪律做成确定性拦截，而非提示词软约束。

## 文件布局

| 文件 | 职责 |
|------|------|
| `search-gate.js` | 全部逻辑，四模式（bash / file / graphify / session） |
| `hooks/hooks.json` | hook 接线：PreToolUse(Bash / Grep\|Glob / mcp__graphify.*) + SessionStart |
| `.claude-plugin/plugin.json`、`marketplace.json` | 插件清单；**版本号两处需同步升** |
| `test-search-gate.js` | 自检 27 用例，`node test-search-gate.js`，无框架无依赖 |
| `README.md` | 用户向（功能 / 安装 / 依赖），不含开发细节 |
| `CLAUDE.md` | 本文件，Agent 向 |

## 模式表

| 模式 | 触发 | 职责 |
|------|------|------|
| bash | PreToolUse(Bash) | grep/egrep/fgrep 打回换 rg（rg 缺失时放行兜底）；`graphify query\|path\|explain\|affected\|god-nodes` 视为完成首搜并开闸；拦截未完成首搜的 rg 搜索 |
| file | PreToolUse(Grep\|Glob) | 拦截未完成首搜的内置搜索工具（Read 不拦，指名读文件自由）；pattern 含 graphify-out 的元数据检查豁免 |
| graphify | PreToolUse(mcp__graphify.*) | 图存在时的 MCP 图查询 = 首搜完成 → 开闸；图不存在时放行调用但不开闸（防空图绕过） |
| session | SessionStart | 清状态目录，新会话重新武装 |

## 首搜闸机制

- **资格（`eligible()`，v5 收敛）**：`.git` 存在于本目录或任一父目录（向上查找）；或本目录浅层出现 **≥2 个「代码证据」**——代码后缀文件（`CODE_EXT`：py/js/ts/go/rs/...）或项目清单（`MANIFEST`：package.json/pyproject.toml/Makefile/...）。扫描深度上限 8、节点上限 500，跳过 `SKIP`（33 类产物目录）。**单代码文件目录维持放行（单文件豁免，回归用例 I1）**。纯媒体/资料目录（仅 mp4/webp/文档等；实测 F:\Douyin 数千 mp4）不武装。刻意不收 `.json/.yml/.md` 泛后缀（媒体/资料目录也常见）；`.json` 仅按清单文件名白名单收。
- **认图（`findGraph()`）**：从 cwd 逐级向上找**最近的**一张图，非 git 目录同样适用。同级有 `graphify-out/.graphify_root`（graphify 建图时记下的扫描根）时，要求 cwd 在该根之下才算数，避免把兄弟目录的图认成自己的；文件缺失时退回「存在即认」。
- **拦截与开闸**：每次拦截对 `tool_input` MD5 指纹。开闸路径：① 一次图查询——CLI 读命令（query/path/explain/affected/god-nodes）或 MCP 查询（`mcp__graphify.*`），两条等价，且都要求图已存在（防空图绕过）；② 同一参数连续 `MAX_BLOCK = 3` 次被拦自动放行（逃生口，`degraded` 标记落盘）；换参数 = 新指纹，计数重置。`graphify update` 之类建图/维护命令不开闸。
- **状态**：`<临时目录>/graphify-gate-<cwd md5 前12位>/<session_id>.json`，原子写（临时文件+rename）。按「项目 + 会话」两层隔离，同仓库多会话互不影响；SessionStart 删整个项目目录重新武装。**写不进去就不拦**（状态落不了盘时直接放行，否则重试计数凑不满会变永久拦截）；同理记不住 staleNagged 就不再提醒。
- **逃生开关**：环境变量 `GRAPHIFY_GATE=off` / `0` / `false` 时整个插件放行（CI / 无头场景）。

## 图过期检测（`stale()`）

- git 最后提交时间晚于 `graph.json` mtime；或存在建图之后修改/新增的文件（`--porcelain -uall`，含未跟踪文件）。
- 路径基准统一用**仓库根**（`git rev-parse --show-toplevel`）——git 给的路径是根相对，用 cwd 拼会在子目录里 stat 全部失败、恒报过期。
- graphify 自身产物（路径含 `graphify-out` 段）不算改动，否则新建 cache 文件会自伤。
- 逐文件比对上限 `SCAN_LIMIT = 500` 条；重命名条目（`R`，路径含 `->`）stat 失败按删除处理，偶发误报可接受。
- 过期时 block-once 拦截提醒（`staleNagged` 对话级粘性），重试即放行。非 git 目录不查。

## 调参（`search-gate.js` 顶部）

- `MAX_BLOCK`：逃生口阈值，默认 3。
- `SKIP`：资格扫描跳过的产物目录，默认 33 个。刻意不收 `packages`、`src` 这类常为真实源码的名字。
- `CODE_EXT` / `MANIFEST`：代码证据白名单（v5）。需要让数据目录也触发时增后缀（如 `ipynb`）；判据是「≥2 个」，单个代码文件不武装。
- `MAX_DEPTH` / `MAX_NODES`（`eligible()` 内）：资格扫描深度与节点上限，默认 8 / 500。
- `SCAN_LIMIT`：过期检测逐文件比对上限，默认 500。
- `GIT_TIMEOUT` / `GIT_STATUS_TIMEOUT`：git 调用超时，默认 5s / 8s。
- `GRAPHIFY_GATE`（环境变量）：`off` / `0` / `false` 时整个插件放行。

## 已知边界

- 黑名单不含 awk/sed/findstr 等替代搜索——目标是路由教育，不是完美强制。
- 只拦「搜索」，不拦 Read（指名读文件永远自由）。
- grep→rg 强制全局生效（含非编码目录）：工具路由教育，与场景闸门独立。
- 资格需 ≥2 个代码证据或 git；「只有单个脚本文件」或「只有数据文件」的目录不触发——需要时调 `CODE_EXT` / `MANIFEST`。
- 图新鲜度只看 git；非 git 目录不查（没有可靠变更源）。
- 脏文件逐条比对 mtime 有上限（500），巨型脏树只查前 500 条。
- `graph.json` 跨会话复用；代码大改后建议手动重建。
- 巨型仓库（10k+ 文件）每次检索的 git 探测可能变慢；`git status -uall` 在未跟踪文件极多的仓库里开销更明显——届时可加节流或只看提交时间。
- 与 graphify 自带的 Claude Code hook（`graphify claude install`：`Bash|Grep` 软提示、`Read|Glob` 可选 `--strict` 拦第一次读）叠加会双重拦截、提示口径不一致，建议二选一。

## 测试

**自检（入库）：`node test-search-gate.js`** —— 27 用例，无框架无依赖（git 缺失跳过 git 用例，rg 缺失跳过 rg 用例）。用例组：

- A 非 git 子目录认得上层图；graphify query 开闸；查询后放行；非 git 不报过期
- B `.graphify_root` 指向兄弟目录时不算自己的图
- C 建图前的旧改动不误报过期（子目录路径基准）
- D 建图后新增未跟踪源文件报过期，重试即放行
- E `graphify-out/` 内新文件不算改动
- F `graphify update` 不开闸
- G 两个会话状态互不影响
- H 状态写不进磁盘仍放行
- L 图就建在子目录里仍按仓库根比对路径（隔离测路径基准）
- M 图在当前目录，未跟踪新文件报过期（隔离测 `-uall`）
- I 单文件目录放行；J grep→rg 强制；K 同参连拦 3 次后放行（回归组）
- N（v5 资格收敛）纯媒体目录 rg/Grep 放行、媒体目录深处仍放行、单代码文件放行、两个代码文件拦截、清单+代码文件拦截、媒体目录 grep→rg 仍强制

测试 harness 注意：每个用例设独立临时目录（`TMPDIR` + `TEMP` + `TMP` 三件套——Windows 下 node `os.tmpdir()` 只认 `TEMP`，实测 TMPDIR/TMP 被忽略），状态文件互不串台。

**历史记录（测试装置不在本仓库）**：单元级 8 组 49 用例（全过）；headless `claude -p` 实战 3 轮（Windows 11 实机，rg 15.2.0 / node 24.19 / claude 2.1.282）：

- Round 1：首次 Grep 被拦 → 模型当轮转向 graphify skill；暴露「Glob 检查图状态被拦」误伤 → 加元数据豁免。headless 无权限审批者导致建图阻塞（非闸门问题）。
- Round 2（`--dangerously-skip-permissions`）：完整链路走通——Grep 拦截 → 读 SKILL.md → 建图 7 步 → query_graph 开闸 → Grep/rg 放行 → Bash 里 grep 被强制转 rg → 任务完成 `is_error=false`。
- Round 3（git 仓库 modbus_104）：3a 预置图——Grep 拦 → query_graph 开闸 → 完成，5 turns；3b 图 mtime 置 2020 模拟过期——拦 → 开闸 → 新鲜度提醒实战出现 → 重试放行 → 完成，6 turns。

## 开发中抓出的真实缺陷（已修复，勿回退）

1. 异步 stdin 监听 + `process.exit` 竞争 → 拦截逻辑静默失效。改 `fs.readFileSync(0)` 同步读。
2. 空图查询即可开闸的绕过洞 → 图存在才开闸。
3. `dirty.stdout.trim()` 整串 trim 吃掉 porcelain 行首状态列空格 → 列错位 → 恒报过期。改为行级 split + trimEnd。
4. 提示里的 `query_graph / shortest_path / god_nodes` 是 graphify 内部函数名，CLI 环境下没有这些工具，且 CLI 查询不开闸 → 开闸路径实际只有逃生口。改为同时认 CLI 读命令。
5. 认图只看当前目录、资格判定却向上找 `.git` → 子目录里看不见上层的图，被要求重复建图。改为向上找 + `.graphify_root` 覆盖校验。
6. `git status --porcelain` 的路径是仓库根相对，代码却按当前目录拼 → 子目录里恒报过期。改为先取仓库根再拼。
7. 状态文件只按目录命名 → 同仓库两个会话互相放行、SessionStart 互相重置。改为按「项目 + 会话」隔离。
8. 状态写失败时重试计数永远凑不满 → 永久拦截。改为写不进去直接放行。
9. 资格旧「≥2 个任意文件」兜底 → 数千 mp4 的纯媒体目录误武装（实测 F:\Douyin）。改为「≥2 个代码证据」（v5）。
10. 测试 harness 在 Windows 上设 `TMPDIR` 不生效（node 只认 `TEMP`）→ 用例 H 状态写不通场景失配。改为三件套都设。

## 版本历史

- 1.2.0（v5）：资格收敛为代码证据（≥2），纯媒体目录不再武装；新增 N 组 7 用例（共 27）；harness 修 Windows 临时目录；文档拆分 README（用户向）/ CLAUDE.md（Agent 向），删除 info.md。
- 1.1.0：开闸认 CLI 读命令；认图向上 + `.graphify_root` 覆盖校验；状态按「项目 + 会话」；写不进放行；过期检测 `-uall` + 仓库根基准 + 排除 graphify 产物；20 用例入库。
- 1.0.0：首版——首搜闸、rg 强制、新鲜度提醒。

升版本时同步 `.claude-plugin/plugin.json` 与 `marketplace.json` 两处。
