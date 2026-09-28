# my-workflow 详细信息

## 行为规格

- **首搜闸**：在 git 仓库（含子目录）或 ≥2 个真实源码文件的目录内，任何代码检索（Grep / Glob / rg）在会话内首次被拦截，直到完成一次 graphify 查询（`query_graph` / `shortest_path` / `god_nodes`）。图不存在时先按 graphify skill 建图，再查询一次。纯聊天零开销。
- **rg 强制**：Bash 中的 grep/egrep/fgrep 一律打回并要求改用 rg；仅当 rg 不可用时放行 grep 兜底（自动判定，无需配置）。
- **图新鲜度**：过期则拦截一次，提醒重建；重试同一检索即放行，本次对话结束前不再提醒。非 git 目录跳过探测。
- **防循环**：开闸只有两条路——完成一次 graphify 查询（正路），或同一命令连续 3 次被拦后自动放行（`MAX_BLOCK = 3`，建图失败逃生口）。不同参数不算重试，无法靠换花样绕过。

## 已知边界

- 黑名单不含 awk/sed/findstr 等替代搜索——目标是路由教育，不是完美强制。
- 闸门只拦「搜索」，不拦 Read（指名读文件永远自由）。
- graph.json 跨会话复用；代码大改后建议手动重建。
- 重命名条目（git R）可能偶发误报过期。
- 巨型仓库（10k+ 文件）每次检索的 git 探测可能变慢——届时可加节流或只看提交时间。

## 调参

`search-gate.js` 顶部：

- `MAX_BLOCK`：逃生口阈值，默认 3。
- `SKIP`：资格计数跳过的产物目录，默认 33 个（依赖 / 构建输出 / Python / 缓存 / IDE 五类）。刻意不收 `packages`、`src` 这类常为真实源码的名字。

## 测试情况

**单元级 8 组 49 用例（全过）**：

- S1 资格分支：git 父目录向上查找 / 非 git ≥2 文件 / 单文件豁免
- S2 bash 词法：grep/egrep/fgrep/管道拦截；`mygrep`、`nrg`、`cargo run` 不误伤；`command rg` 设闸；绝对路径 rg = 设计内已知绕过洞
- S3 参数指纹：同参三拦逃生口、degraded 标记落盘、五个不同参数仍拦截、换参重算指纹
- S4 graphify 开闸：无图查询不开闸；query_graph / shortest_path / get_node 均开闸
- S5 file 模式：Grep 指纹逃生口、graphify-out 元数据豁免、仅 path 含 graphify-out 仍设闸
- S6 rg 缺失模拟（PATH 剥离）：grep 落到闸门消息；闸开时 grep 兜底放行
- S7 新鲜度全分支：提交晚于建图 / 建图后修改 / 建图前旧改动不误报 / 建图后删除 / 图新鲜 / 非 git 跳过 / staleNagged 对话级粘性
- S8 session 重置

**headless `claude -p` 实战 3 轮（Windows 11 实机，rg 15.2.0 / node 24.19 / claude 2.1.282）**：

- Round 1：首次 Grep 被拦 → 模型当轮转向 graphify skill；暴露「Glob 检查图状态被拦」误伤 → 加元数据豁免。headless 无权限审批者导致建图阻塞（非闸门问题）。
- Round 2（`--dangerously-skip-permissions`）：完整链路走通——Grep 拦截 → 读 SKILL.md → 建图 7 步 → query_graph 开闸 → Grep/rg 放行 → Bash 里 grep 被强制转 rg → 任务完成 `is_error=false`。
- Round 3（git 仓库 modbus_104）：3a 预置图——Grep 拦 → query_graph 开闸 → 完成，5 turns；3b 图 mtime 置 2020 模拟过期——闸关拦 → 开闸 → 新鲜度 block-once 消息实战出现 → 重试放行 → 完成，6 turns。

**开发过程中抓出的真实缺陷**（均已修复并纳入回归）：

1. 异步 stdin 监听 + `process.exit` 竞争 → 拦截逻辑静默失效。改 `fs.readFileSync(0)` 同步读。
2. 空图查询即可开闸的绕过洞 → 图存在才开闸。
3. `dirty.stdout.trim()` 整串 trim 吃掉 porcelain 行首状态列空格 → 列错位 → 恒报过期。改为行级 split + trimEnd。
