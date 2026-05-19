# Cursor Cookbook

本仓库包含使用 Cursor 构建应用的小型示例集合。

## Cursor SDK

Cursor SDK 是 TypeScript API，让你能以自己的应用、脚本和工作流运行 Cursor 的编码 Agent。它支持跨本地工作区和云端运行时的同一 Agent，以流式方式返回 Agent 事件，并允许你通过代码管理提示词、模型选择、取消操作、制品和对话状态。

要运行 SDK 示例，请先从 [Cursor 集成面板](https://cursor.com/dashboard/integrations) 创建一个 Cursor API Key，然后将其设置为环境变量 `CURSOR_API_KEY`。

### [快速开始](sdk/quickstart)

一个极简的 Node.js 示例，创建一个本地 Agent，发送一条提示，并以流式方式获取响应。

### [原型构建工具](sdk/app-builder)

一个 Web 应用，用于快速启动 Agent 来搭建新项目并在沙盒云环境中迭代创意。

### [看板面板](sdk/agent-kanban)

一个看板面板，用于查看 Cursor Cloud Agents，按状态或仓库分组，预览制品，并基于仓库和提示创建新的云端 Agent。

### [编码 Agent CLI](sdk/coding-agent-cli)

一个极简的命令行界面，让你从终端启动 Cursor Agent。

### [DAG 任务编排器](sdk/dag-task-runner)

将任务拆解为 JSON DAG（有向无环图），在本地子 Agent 之间分发执行，并将实时状态流式输出到 Cursor Canvas，每次状态变更时 Canvas 会自动热重载。既可以作为可运行的示例使用，也可以作为可复制的 Cursor Skill 使用，位于 [`.cursor/skills/dag-task-runner`](.cursor/skills/dag-task-runner)。

了解更多请参阅 [Cursor SDK TypeScript 文档](https://cursor.com/docs/api/sdk/typescript)。
