# 编码 Agent CLI

一个小型示例 CLI，在工作区中运行 Cursor SDK Agent。单次提示默认使用本地运行时，交互式 TUI 可在本地和云端执行之间切换。

## 开始使用

需要 Bun 1.3 或更高版本。此 CLI 仅支持 Bun，因为 OpenTUI 的原生渲染器通过 `bun:ffi` 暴露。

安装依赖：

```bash
pnpm install
```

设置 API Key：

```bash
export CURSOR_API_KEY="crsr_..."
```

在当前目录下执行单次任务：

```bash
bun run dev -- "解释一下这个项目的结构"
```

不加提示词启动 TUI：

```bash
bun run dev
```

## 说明

在 TUI 中，输入 `/` 打开命令菜单。你可以在其中切换本地或云端执行、选择模型、重置会话或退出。
