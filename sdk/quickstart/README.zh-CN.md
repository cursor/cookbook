# Cursor SDK 快速开始

一个极简的本地 Cursor SDK 示例：创建一个 Agent，发送一条硬编码的提示词，将助手回复流式输出到标准输出，并等待运行完成。

## 开始使用

需要 Node.js 22 或更高版本。

安装依赖：

```bash
pnpm install
```

设置 Cursor API Key：

```bash
export CURSOR_API_KEY="crsr_..."
```

运行快速开始：

```bash
pnpm dev
```

编译并运行：

```bash
pnpm build
pnpm start
```

## 说明

如需更完整的终端应用（支持参数、云模式、模型选择和交互式 TUI），请参见[编码 Agent CLI](../coding-agent-cli)。
