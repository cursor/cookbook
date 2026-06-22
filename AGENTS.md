# AGENTS.md

## Cursor Cloud specific instructions

This repo (the **Cursor Cookbook**) is a collection of independent example projects, not one app.
Each lives in its own directory with its own `pnpm-lock.yaml`; there is no root workspace and there
are **no automated tests**. Standard per-project commands live in each project's `package.json`
(`dev`/`build`/`start`/`lint`/`typecheck`) and in the top-level `README.md`.

Projects:
- `sdk/quickstart` — Node/tsx CLI; runs one local agent and streams the reply.
- `sdk/dag-task-runner` — Node/tsx CLI; decomposes a task into a DAG of subagents and renders a Cursor Canvas.
- `sdk/coding-agent-cli` — terminal TUI; **must run with Bun** (its renderer uses `bun:ffi`).
- `sdk/app-builder` — Next.js web app (App Router).
- `sdk/agent-kanban` — Next.js web app; lists/creates Cursor Cloud Agents.
- `hooks/` and `self-hosted-cloud-agent/` — Cursor Hooks scripts and AWS IaC (Docker/Terraform/Helm); optional, no build.

### Non-obvious gotchas

- **API key**: every SDK example needs a Cursor API key (`crsr_...`). The SDK and both web apps read
  `process.env.CURSOR_API_KEY`, which is **not** set in this environment. A valid key is available as
  `CURSOR_SERVICE_ACCOUNT_KEY`, so run the SDK examples with `CURSOR_API_KEY="$CURSOR_SERVICE_ACCOUNT_KEY"`.
  This service-account key authenticates and lists cloud agents/models, but has **no GitHub repository
  integration**, so repository pickers in the web apps come back empty (expected, not a bug).
- **Bun** is required only by `sdk/coding-agent-cli`. It is installed at `~/.local/bin/bun` and added to
  `PATH` via `~/.bashrc`. `bun.sh`'s install script is blocked by egress; if Bun is ever missing,
  reinstall with `npm i -g bun` (the npm package downloads the binary from the registry). The TUI needs a
  real TTY — run it in a tmux/interactive shell, not as a piped background process.
- **Web apps default to port 3000.** To run `app-builder` and `agent-kanban` at the same time, give one a
  different port, e.g. `PORT=3001 pnpm dev`.
- The web apps persist their key to `~/.app-builder/settings.json` / `~/.agent-kanban/settings.json`. You
  can seed `{"cursorApiKey": "<crsr_...>"}` there to skip the in-UI key prompt; the app validates it via
  `Cursor.me()` on load.
