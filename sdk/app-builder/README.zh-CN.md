# Cursor SDK App Builder

这是一个展示 Cursor SDK 构建能力的小型示例。它启动一个本地 Cursor Agent 会话，搭建一个支持热重载的 React 预览应用，并让你通过聊天界面在该应用上迭代。

目标是演示一个完整的端到端应用构建循环：

- 在本地收集 Cursor API Key
- 创建隔离的预览工作区
- 流式输出 Agent 响应和工具活动
- 在 iframe 中预览生成的 UI
- 管理多个应用构建对话

## 开始使用

安装依赖并启动 Next.js 宿主应用：

```bash
pnpm install
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000)。

首次启动时，粘贴你的 Cursor API Key。应用会将其存储在本地 `~/.app-builder/settings.json` 中，并用于创建本地 Agent 会话。

## 说明

此应用旨在作为本地 Cursor SDK 演示。请不要在没有添加身份验证、用户独立存储以及更强的密钥保护措施的情况下，将其部署为公开共享服务。
