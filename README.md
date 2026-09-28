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
| bash | PreToolUse(Bash) | grep/egrep/fgrep 打回换 rg（rg 缺失时放行兜底）；闸门未开时拦截 rg 搜索 |
| file | PreToolUse(Grep\|Glob) | 闸门未开时拦截内置搜索工具（Read 不拦，指名读文件自由）；pattern 含 graphify-out 的元数据检查豁免 |
| graphify | PreToolUse(mcp__graphify.*) | 图存在时的图查询 = 首搜完成 → 开闸；图不存在时放行调用但不开闸（防空图绕过） |
| session | SessionStart | 清状态文件，新会话重新武装闸门 |

**首搜闸**：闸门资格 = `.git` 存在于本目录或任一父目录（向上查找），或本目录 ≥2 个真实源码文件（跳过 node_modules、dist、.venv 等 33 类产物目录）。资格满足时，任何检索动作在会话首次被拦截，直到一次 graphify 查询发生——需求触发，纯聊天零开销。

**参数指纹**：每次拦截对 `tool_input` 做 MD5 指纹。同指纹连续重试才计入逃生口（同一命令连续 3 次被拦 → 自动放行，建图失败兜底）；换参数 = 新尝试，计数重置——无法靠换花样绕过。开闸只有两条路：graphify 查询（正路）、同参卡死重试 3 次（真故障）。

**图新鲜度**：每次检索触发时顺带探测（git 最后提交时间 / 逐 dirty 文件 mtime vs `graph.json` mtime；建图前的旧改动不误报，删除文件视为过期）。过期则拦截一次提醒重建——block-once，重试即放行，本次对话结束前不再提醒。非 git 目录跳过。

**状态**：`%TMP%\graphify-gate-<项目路径md5前12位>.json`，不污染仓库、按项目隔离，SessionStart 自动清除。

详细行为规格、已知边界、调参、测试情况见 [info.md](info.md)。
