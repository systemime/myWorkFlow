# my-workflow

Claude Code 插件：把「graphify 优先、rg 替代 grep」的检索纪律从提示词软约束升级为 hook 硬约束。提示词只能「建议」，模型可以在任何一轮违背；本插件在工具调用层直接拦截，确定性保证检索行为。

## 功能

- **graphify 首搜闸**：在编码目录（git 仓库，或含代码文件的目录）里，本会话第一次代码检索（Grep / Glob / rg）会被拦截，直到完成一次图查询——跑一次 `graphify query` / `path` / `explain` / `affected` / `god-nodes`，或调一次 MCP 图查询（二者等价）。图不存在时先按 graphify skill 建图。纯聊天、媒体/资料目录零开销。
- **rg 强制**：Bash 中的 grep / egrep / fgrep 一律打回改用 rg；仅当 rg 不可用时自动放行 grep 兜底。
- **图过期提醒**：图过期（git 提交或改动晚于 `graph.json`）时拦截一次提醒重建，重试同一检索即放行，每次对话最多提醒一次。

## 安装

```bash
# Claude Code 会话内执行：
/plugin marketplace add F:\Project\MyTool\myWorkFlow
/plugin install my-workflow@my-workflow-marketplace
```

装好后重启会话即生效。卸载用 `/plugin uninstall my-workflow`。CI / 无头场景设环境变量 `GRAPHIFY_GATE=off` 整体关闭。

## 依赖

- node（hook 脚本运行时）
- ripgrep —— 缺失时自动回退 grep
- graphify skill（`~/.claude/skills/graphify/SKILL.md`）—— 建图与查询

## 自检

```bash
node test-search-gate.js   # 27 个用例，无框架无依赖（git / rg 缺失时跳过对应用例）
```

开发细节、行为规格、调参、测试记录见 [CLAUDE.md](CLAUDE.md)。
