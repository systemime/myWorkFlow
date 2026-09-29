# my-workflow

Claude Code 插件：把「graphify 优先、rg 替代 grep」的检索纪律从提示词软约束升级为 hook 硬约束。提示词只能「建议」，模型可以在任何一轮违背；本插件在工具调用层直接拦截，确定性保证检索行为。

## 安装方式

```bash
# Claude Code 会话内执行：
/plugin marketplace add F:\Project\MyTool\myWorkFlow
/plugin install my-workflow@my-workflow-marketplace
```

装好后重启会话即生效。卸载用 `/plugin uninstall my-workflow`。

依赖：

- node（hook 脚本运行时）
- ripgrep（rg）——缺失时自动回退 grep
- graphify skill（`~/.claude/skills/graphify/SKILL.md`）——建图与查询

## 原理

单脚本 `search-gate.js` 四个模式，由 4 个 hook 触发：

| 模式 | 触发 | 职责 |
|------|------|------|
| bash | PreToolUse(Bash) | grep/egrep/fgrep 打回换 rg（rg 缺失时放行兜底）；拦截未完成首搜的 rg 搜索；`graphify query\|path\|explain\|affected\|god-nodes` 视为完成首搜并开闸 |
| file | PreToolUse(Grep\|Glob) | 拦截未完成首搜的内置搜索工具（Read 不拦，指名读文件自由）；pattern 含 graphify-out 的元数据检查豁免 |
| graphify | PreToolUse(mcp__graphify.*) | 图存在时的 MCP 图查询 = 首搜完成 → 开闸；图不存在时放行调用但不开闸（防空图绕过） |
| session | SessionStart | 清状态目录，新会话重新武装 |

**首搜闸**：可拦范围 = `.git` 存在于本目录或任一父目录（向上查找），或本目录 ≥2 个真实源码文件（跳过 node_modules、dist、.venv 等 33 类产物目录）。范围内任何检索动作在会话首次被拦截，直到完成一次图查询——需求触发，纯聊天零开销。放行两条等价的路径：graphify 的 CLI 读命令，或 MCP 图查询。

**认图**：从当前目录逐级向上找**最近的**一张图，非 git 目录同样适用。同级有 `graphify-out/.graphify_root`（建图时记下的扫描根）时，要求当前目录在该根之下才算数，避免把兄弟目录的图认成自己的；文件缺失时退回「存在即认」。

**参数指纹**：每次拦截对 `tool_input` 做 MD5 指纹。同指纹连续重试才计入逃生口（同一命令连续 3 次被拦 → 自动放行，建图失败兜底）；换参数 = 新尝试，计数重置——无法靠换花样绕过。开闸只有两条路：graphify 查询（正路）、同参卡死重试 3 次（真故障）。

**图过期检测**：每次检索触发时顺带探测（git 最后提交时间 / 逐 dirty 文件 mtime vs `graph.json` mtime；建图前的旧改动不误报，删除文件视为过期，建图后新增的未跟踪文件也算，`graphify-out/` 里的产物不算）。路径基准统一用仓库根——git 给的路径是根相对，用当前目录拼会在子目录里 stat 全部失败、恒报过期。过期则拦截一次提醒重建——block-once，重试即放行，本次对话结束前不再提醒。非 git 目录不查。

**状态**：`%TMP%/graphify-gate-<项目路径md5前12位>/<session_id>.json`，不污染仓库，按「项目 + 会话」两层隔离（同仓库开两个会话互不影响），SessionStart 删掉整个项目目录重新武装。状态写不进磁盘时直接放行，不会变成永久拦截。

**逃生开关**：`GRAPHIFY_GATE=off`（或 `0` / `false`）时整个插件放行，给 CI / 无头场景用。

**自检**：`node test-search-gate.js`（20 个用例，无依赖）。

详细行为规格、已知边界、调参、测试情况见 [info.md](info.md)。
