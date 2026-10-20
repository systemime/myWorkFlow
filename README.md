# my-workflow

Claude Code 插件：把「rg 替代 grep」的工具路由纪律从提示词软约束升级为 hook 硬约束。提示词只能「建议」，模型可以在任何一轮违背；本插件在工具调用层直接拦截，确定性保证检索行为。

## 功能

- **rg 强制**：Bash 中的 grep / egrep / fgrep 一律打回改用 rg（含 `/bin/grep`、`sh -c 'grep …'` 等变体，以及 `git grep`、`find -exec grep`）；仅当 rg 不可用时自动放行 grep 兜底。
- **rg 永远放行**：不要求建图、不要求任何前置步骤。文档评审等非编码任务零打扰。
- 命令里的同名词不误拦：`git commit -m "use grep"`、`python grep.py`、`echo rg` 照常执行。

> 1.3.0 起移除「graphify 首搜闸」与「图过期提醒」：不建图就拦 rg 与「rg 优先」的检索约定直接冲突（实测文档评审场景被拦），插件不再要求任何图操作。

## 安装

### 方式一：直接从 GitHub 安装（推荐）

```bash
# Claude Code 会话内执行：
/plugin marketplace add systemime/myWorkFlow
/plugin install my-workflow@my-workflow-marketplace
```

### 方式二：克隆到本地后安装

```bash
git clone https://github.com/systemime/myWorkFlow.git
```

```bash
# Claude Code 会话内执行（把路径换成你的实际克隆位置）：
/plugin marketplace add /path/to/myWorkFlow
/plugin install my-workflow@my-workflow-marketplace
```

装好后重启会话即生效；已安装旧版本时先 `/plugin marketplace update my-workflow-marketplace` 再重装。卸载用 `/plugin uninstall my-workflow`（本地克隆方式可再 `/plugin marketplace remove my-workflow-marketplace`）。CI / 无头场景设环境变量 `GRAPHIFY_GATE=off` 整体关闭。

## 依赖

- node（hook 脚本运行时）
- ripgrep —— 缺失时自动回退 grep

## 自检

```bash
node test-search-gate.js   # 12 个用例，无框架无依赖（rg 缺失时强制类用例跳过）
```

开发细节、行为规格、测试记录见 [CLAUDE.md](CLAUDE.md)。
