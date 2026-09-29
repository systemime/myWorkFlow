# my-workflow 详细信息

## 行为规格

- **首搜闸**：在 git 仓库（含子目录）或 ≥2 个真实源码文件的目录内，任何代码检索（Grep / Glob / rg）在会话内首次被拦截，直到完成一次图查询。放行有两条等价的路径——跑一次 graphify 的读命令（`graphify query` / `path` / `explain` / `affected` / `god-nodes`），或调一次 MCP 图查询（`mcp__graphify.*`）。两条路都要求图已经存在。图不存在时先按 graphify skill 建图（产出 `graphify-out/graph.json`），再查询一次。纯聊天零开销。
- **认图**：从当前目录逐级向上找**最近的**一张图；非 git 目录同样适用（只依赖 `graphify-out` 标记，不依赖 `.git`）。同级若有 `graphify-out/.graphify_root`（graphify 建图时记下的扫描根），要求当前目录在该根之下才算数，避免把兄弟目录的图认成自己的；该文件缺失或读不出时退回「存在即认」，不硬依赖它。
- **rg 强制**：Bash 中的 grep/egrep/fgrep 一律打回并要求改用 rg；仅当 rg 不可用时放行 grep 兜底（自动判定，无需配置）。
- **图新鲜度**：过期则拦截一次，提醒重建；重试同一检索即放行，本次对话结束前不再提醒。判定依据是 git：最后提交时间晚于 `graph.json`，或存在建图之后修改/新增的文件（含未跟踪文件，`-uall`）。路径基准统一用**仓库根**（`git rev-parse --show-toplevel`）——git 给的路径是根相对，用当前目录拼会在子目录里 stat 全部失败、恒报过期。graphify 自己的产物（路径含 `graphify-out` 段）不算改动，否则新建的 `graphify-out/cache/*` 会把自己判成过期。非 git 目录不查。
- **防循环**：开闸只有两条路——完成一次图查询（正路），或同一命令连续 3 次被拦后自动放行（`MAX_BLOCK = 3`，建图失败逃生口）。不同参数不算重试，无法靠换花样绕过。
- **状态**：`<临时目录>/graphify-gate-<项目路径 md5 前 12 位>/<session_id>.json`。按「项目 + 会话」两层隔离，同仓库开两个会话互不影响；SessionStart 删掉整个项目目录重新武装。
- **写不进去就不拦**：状态落不了盘时直接放行（否则重试计数永远凑不满 3 次，会变成永久拦截）。同理，记不住「已经提醒过」时就不再提醒。
- **逃生开关**：环境变量 `GRAPHIFY_GATE=off`（或 `0` / `false`）时整个插件放行，给 CI / 无头场景用。

## 已知边界

- 黑名单不含 awk/sed/findstr 等替代搜索——目标是路由教育，不是完美强制。
- 只拦「搜索」，不拦 Read（指名读文件永远自由）。
- 图新鲜度只看 git；非 git 目录不查（没有可靠的变更来源）。
- 重命名条目（git R）路径含 `->`，stat 失败按删除处理，偶发误报过期。
- 脏文件逐条比对 mtime 有上限（`SCAN_LIMIT = 500`），巨型脏树只查前 500 条。
- `graph.json` 跨会话复用；代码大改后建议手动重建。
- 巨型仓库（10k+ 文件）每次检索的 git 探测可能变慢；`git status -uall` 在未跟踪文件极多的仓库里开销更明显——届时可加节流或只看提交时间。
- 与 graphify 自带的 Claude Code hook（`graphify claude install`：`Bash|Grep` 软提示、`Read|Glob` 可选 `--strict` 拦第一次读）叠加会双重拦截、提示口径不一致，建议二选一。

## 调参

`search-gate.js` 顶部：

- `MAX_BLOCK`：逃生口阈值，默认 3。
- `SKIP`：资格计数跳过的产物目录，默认 33 个（依赖 / 构建输出 / Python / 缓存 / IDE 五类）。刻意不收 `packages`、`src` 这类常为真实源码的名字。
- `SCAN_LIMIT`：过期检测逐文件比对 mtime 的上限，默认 500。
- `GIT_TIMEOUT` / `GIT_STATUS_TIMEOUT`：git 调用超时，默认 5s / 8s。
- `GRAPHIFY_GATE`（环境变量）：`off` / `0` / `false` 时整个插件放行。

## 测试情况

**本机自检（已入库）：`node test-search-gate.js`**

20 个用例，无框架无依赖（rg 缺失时跳过对应用例）。覆盖：

- 子目录里认得上层/本层的图；`.graphify_root` 指向兄弟目录时不认
- 子目录里的路径基准（建图前的旧改动不误报过期）
- 建图后新增未跟踪源文件报过期；`graphify-out/` 内新增文件不报
- CLI 图查询开闸；`graphify update` 之类的建图命令不开闸
- 两个会话的状态互不影响；状态写不进磁盘时仍放行
- 回归：grep→rg 强制、同参三次被拦后放行、单文件目录不拦

对改动前的版本跑同一套用例：20 条里失败 10 条，每条对应一个已修问题。

**历史记录（测试装置不在本仓库，未入库）**

单元级 8 组 49 用例（全过），以及 headless `claude -p` 实战 3 轮（Windows 11 实机，rg 15.2.0 / node 24.19 / claude 2.1.282）：

- Round 1：首次 Grep 被拦 → 模型当轮转向 graphify skill；暴露「Glob 检查图状态被拦」误伤 → 加元数据豁免。headless 无权限审批者导致建图阻塞（非闸门问题）。
- Round 2（`--dangerously-skip-permissions`）：完整链路走通——Grep 拦截 → 读 SKILL.md → 建图 7 步 → query_graph 开闸 → Grep/rg 放行 → Bash 里 grep 被强制转 rg → 任务完成 `is_error=false`。
- Round 3（git 仓库 modbus_104）：3a 预置图——Grep 拦 → query_graph 开闸 → 完成，5 turns；3b 图 mtime 置 2020 模拟过期——拦 → 开闸 → 新鲜度提醒实战出现 → 重试放行 → 完成，6 turns。

**开发过程中抓出的真实缺陷**（前三条已修复并纳入回归）：

1. 异步 stdin 监听 + `process.exit` 竞争 → 拦截逻辑静默失效。改 `fs.readFileSync(0)` 同步读。
2. 空图查询即可开闸的绕过洞 → 图存在才开闸。
3. `dirty.stdout.trim()` 整串 trim 吃掉 porcelain 行首状态列空格 → 列错位 → 恒报过期。改为行级 split + trimEnd。
4. 提示里的 `query_graph / shortest_path / god_nodes` 是 graphify 内部函数名，CLI 环境下没有这些工具，且 CLI 查询不开闸 → 开闸路径实际只有逃生口。改为同时认 CLI 读命令。
5. 认图只看当前目录、资格判定却向上找 `.git` → 子目录里看不见上层的图，被要求重复建图。改为向上找 + `.graphify_root` 覆盖校验。
6. `git status --porcelain` 的路径是仓库根相对，代码却按当前目录拼 → 子目录里恒报过期。改为先取仓库根再拼。
7. 状态文件只按目录命名 → 同仓库两个会话互相放行、SessionStart 互相重置。改为按「项目 + 会话」隔离。
8. 状态写失败时重试计数永远凑不满 → 永久拦截。改为写不进去直接放行。
