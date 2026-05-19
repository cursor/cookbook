# Cursor SDK Agent 看板

一个 Linear 风格的 Cursor Cloud Agents 面板。它使用 Cursor SDK 列出云端 Agent，将其分组为看板列，在卡片上预览制品，并支持从仓库和提示词创建新的云端 Agent。

本示例演示了：

- API Key 接入流程（加载云端 Agent 数据前必需）
- 云端 Agent 列表展示，支持按状态、仓库、分支或创建日期分组
- Agent 卡片，包含状态、仓库/分支元数据、最新活动、PR 链接和制品预览
- 基于 `Agent.create({ cloud: { repos } })` 的创建 Agent 流程
- 通过本地 API 路由代理的身份验证制品媒体预览

## 开始使用

```bash
pnpm install
pnpm dev
```

打开本地 Next.js URL，然后从 [Cursor 集成面板](https://cursor.com/dashboard/integrations) 输入 Cursor API Key 完成接入。如果勾选了"记住此 Key"，API Key 将存储在 `~/.agent-kanban/settings.json`；否则仅保存在内存会话中。

## 说明

仓库列表受 Cloud Agents API 的速率限制，并在内存中进行短期缓存。制品预览通过经过身份验证的本地 API 路由获取，如果预览停止加载请刷新面板。
