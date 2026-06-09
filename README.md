# Cursor Cookbook

This repo contains small examples for building with Cursor.

## Cursor Hooks

Cursor Hooks let you run custom checks and workflows around agent events such as prompt submission, shell commands, file edits, and agent completion.

### [Hooks examples](hooks)

A guided project hook setup for audit logging, sensitive prompt guards, and follow-up checks that keep Cursor skills aligned with code changes.

## Cloud Agents

### [Self-hosted Cloud Agents lab](cloud-agent)

Run Cursor Cloud Agent workers on customer-managed AWS infrastructure with examples for EC2 + Docker, ECS/Fargate, and EKS + Helm.

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

Learn more in the [Cursor SDK TypeScript docs](https://cursor.com/docs/api/sdk/typescript).
