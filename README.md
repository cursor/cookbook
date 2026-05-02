# Cursor Cookbook

This repo contains small examples for building with Cursor.

## Cursor SDK

The Cursor SDK is the TypeScript API for running Cursor's coding agent from your own apps, scripts, and workflows. It supports the same agent across local workspaces and cloud runtimes, streams agent events as runs progress, and lets you manage prompts, models, cancellation, artifacts, and conversation state from code.

To run the SDK examples, create a Cursor API key from the [Cursor integrations dashboard](https://cursor.com/dashboard/integrations), then set it as `CURSOR_API_KEY`.

### [Quickstart](sdk/quickstart)

A minimal Node.js example that creates a local agent, sends one prompt, and streams the response.

### [Prototyping tool](sdk/app-builder)

A web app for spinning up agents to scaffold new projects and iterate on ideas in a sandboxed cloud environment.

### [Kanban board](sdk/agent-kanban)

A kanban board for viewing Cursor Cloud Agents, grouping them by status or repository, previewing artifacts, and creating new cloud agents from a repository and prompt.

### [Coding agent CLI](sdk/coding-agent-cli)

A minimal command-line interface that lets you spawn Cursor agents from your terminal.

### [DAG task runner](sdk/dag-task-runner)

Decompose a task into a JSON DAG, fan it out across local subagents, and stream live status into a Cursor Canvas that hot-reloads on every state change. Ships as both a runnable example and a copyable Cursor skill at [`.cursor/skills/dag-task-runner`](.cursor/skills/dag-task-runner).

### [Sverklo (code intelligence over MCP)](sdk/sverklo-mcp)

Wire [sverklo](https://github.com/sverklo/sverklo) — a local-first MCP code-intelligence server (MIT) — into your Cursor SDK agent. The agent gets 37 extra tools alongside Cursor's built-ins: hybrid semantic search ranked by PageRank, recursive blast-radius analysis, symbol graph, bi-temporal memory pinned to git SHAs, and a code-quality audit. Demonstrates the canonical pattern for adding any third-party MCP server to a programmatic Cursor agent.

Learn more in the [Cursor SDK TypeScript docs](https://cursor.com/docs/api/sdk/typescript).
