# Cursor Cookbook

This repo contains small examples for building with Cursor.

## Cursor Hooks

Cursor Hooks let you run custom checks and workflows around agent events such as prompt submission, shell commands, file edits, and agent completion.

### [Hooks examples](hooks)

A guided project hook setup for audit logging, sensitive prompt guards, and follow-up checks that keep Cursor skills aligned with code changes.

## Cloud Agents

### [Self-hosted Cloud Agents lab](cloud-agent)

Run Cursor Cloud Agent workers on customer-managed AWS infrastructure with examples for EC2 + Docker and ECS/Fargate.

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

### [Test generator](sdk/test-generator)

A CLI that points a Cursor agent at your source files, generates unit tests, runs them, and iterates until they pass. Supports TypeScript/JavaScript (Vitest or Jest) and Python (Pytest), with an interactive Ink TUI.

### [Perl bridge adapter](sdk/perl-bridge-adapter)

A miniature Cursor SDK in Perl on the open [`sdk.v1` bridge](https://github.com/cursor/sdk-bridge). Shows how to spawn `cursor-sdk-bridge`, speak Connect JSON, and run one local agent turn without a first-party SDK.

Learn more in the [Cursor SDK TypeScript docs](https://cursor.com/docs/sdk/typescript) and the [SDK Bridge docs](https://cursor.com/docs/sdk/bridge).

## xAI API

### [Grok Coding Agent CLI](sdk/grok-coding-agent-cli)

An educational Python coding-agent loop that uses an xAI Console API key,
defaults to `grok-4.6`, and provides workspace-scoped file and shell tools.

### [Grok Voice Patient Intake](voice-agents/grok-patient-intake)

A LiveKit voice agent that uses xAI's native realtime speech-to-speech model
for a fictional family-medicine intake and appointment workflow.
