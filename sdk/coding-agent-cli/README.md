# Coding Agent CLI

A small example CLI that runs a Cursor SDK agent against a workspace. One-shot prompts use the local runtime by default, while the interactive TUI can switch between local and cloud execution.

## Getting Started

Use Node.js 22 or newer.

Install dependencies:

```bash
pnpm install
```

Set an API key:

```bash
export CURSOR_API_KEY="crsr_..."
```

Ask for a one-shot task in the current directory:

```bash
pnpm dev -- "Explain how this project is structured"
```

Start the TUI by omitting the prompt:

```bash
pnpm dev
```

## Notes

Inside the TUI, type `/` to open the command menu. You can switch between local and cloud execution, choose a model, reset the session, or exit from there.

Cloud execution expects the current workspace to be a git repository with `remote.origin.url` set to a GitHub remote.