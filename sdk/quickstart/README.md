# Cursor SDK Quickstart

A minimal local Cursor SDK example. It creates one agent, sends a hard-coded prompt, streams assistant text to stdout, and waits for the run to finish.

## Getting Started

Use Node.js 22 or newer.

Install dependencies:

```bash
pnpm install
```

Set a Cursor API key:

```bash
export CURSOR_API_KEY="crsr_..."
```

The example uses `composer-2`; set `CURSOR_MODEL` to run it with another model id.

Run the quickstart:

```bash
pnpm dev
```

Build and run the compiled example:

```bash
pnpm build
pnpm start
```

## Notes

For a more complete terminal app with arguments, cloud mode, model selection, and an interactive TUI, see [Coding Agent CLI](../coding-agent-cli).