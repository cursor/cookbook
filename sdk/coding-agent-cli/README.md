# Coding Agent CLI

A small example CLI that runs a Cursor SDK agent against a workspace. One-shot prompts use the local runtime by default, while the interactive TUI can switch between local and cloud execution.

## Getting Started

Use Bun 1.3 or newer. OpenTUI's native renderer is exposed through `bun:ffi`,
so the interactive CLI must run on Bun.

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
bun run dev -- "Explain how this project is structured"
```

Start the TUI by omitting the prompt:

```bash
bun run dev
```

## Notes

Inside the TUI, type `/` to open the command menu. You can switch between local and cloud execution, choose a model, reset the session, or exit from there.