# Cursor SDK + sverklo (code intelligence over MCP)

A Cursor SDK agent with **sverklo** wired in as an MCP server. The agent gets 37 extra tools — semantic search ranked by PageRank, blast-radius analysis, symbol graph, bi-temporal memory pinned to git SHAs, and a code-quality audit — alongside Cursor's built-in `semSearch`, `glob`, `grep`, etc.

[Sverklo](https://github.com/sverklo/sverklo) is a local-first MCP code-intelligence server. MIT-licensed, runs on your laptop, no cloud, no API keys.

## Why this example

The Cursor SDK doesn't expose a custom-tool registration API or a context-provider plug point — extension goes through MCP. This example shows the canonical pattern: declare an MCP server inline in `Agent.create()` and the agent picks the new tools when they fit the task.

The same wiring works for any MCP server (filesystem, github, postgres, etc.). Sverklo is a useful one to start with because it's the difference between an agent that grep-searches your repo and one that understands its symbol graph.

## Getting Started

Use Node.js 22 or newer.

Install sverklo globally (one-time):

```bash
npm install -g sverklo
```

This pulls a small ONNX embedding model (~90 MB) on first run.

Install dependencies:

```bash
pnpm install
```

Set a Cursor API key:

```bash
export CURSOR_API_KEY="crsr_..."
```

Run the example against the cookbook itself:

```bash
pnpm dev
```

Or point it at a specific repository (and override the prompt if you want):

```bash
pnpm dev /path/to/your/project
pnpm dev /path/to/your/project "Find every caller of UserService.validate. Use sverklo_impact for the blast radius."
```

Build and run the compiled example:

```bash
pnpm build
pnpm start
```

## What you'll see

The default prompt asks the agent to build a mental model of the project using `sverklo_overview` (PageRank-ranked) and then run `sverklo_audit`. Output is streamed as the agent decides which tools to call. Every tool call is logged so you can see when the agent reaches for sverklo vs. Cursor's built-ins.

Example trimmed output:

```
[tool] sverklo_overview
[tool] sverklo_audit

This codebase is 12 TypeScript packages organized as a pnpm workspace.
The structurally most important files (PageRank) are:
  • sdk/quickstart/src/index.ts
  • sdk/coding-agent-cli/src/agent.ts
  ...
sverklo_audit found 2 medium-severity findings:
  • Possible god class: sdk/coding-agent-cli/src/repl.ts (12 methods)
  • Hub file: sdk/dag-task-runner/src/runner.ts (8 importers)
```

The agent doesn't call sverklo for every question — it picks the right tool. Ask it "what does this project do?" and it may use Cursor's built-in `semSearch`. Ask it "what breaks if I rename X?" and it'll reach for `sverklo_impact` because the symbol graph is the right substrate.

## File-based variant (`.cursor/mcp.json`)

If your project already has a `.cursor/mcp.json` (because you also use the Cursor IDE on the same project), the SDK can read it directly. Replace the inline `mcpServers` block with `local.settingSources`:

```ts
const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY,
  name: "Cursor SDK + sverklo",
  model: { id: "composer-2" },
  local: {
    cwd: projectPath,
    settingSources: ["project"], // load .cursor/mcp.json from the project
  },
})
```

The IDE and the SDK agent then share one MCP config — no drift.

## Notes

- Sverklo's MCP server is local-first; the cloud agent path doesn't apply unless you run sverklo on a host the cloud agent can reach. For cloud-mode agents that need code intelligence, run the SDK locally and use the `local` runtime.
- `npx -y sverklo <path>` is the stdio-mode entrypoint. For long-lived sessions, install sverklo globally (`npm i -g sverklo`) and use `command: "sverklo"` directly to skip the `npx` resolve step on every spawn.
- The Cursor SDK's tool-call event payload schemas are not yet stable; treat tool calls as opaque and don't parse `args` / `result` internals.

## See also

- [Sverklo on GitHub](https://github.com/sverklo/sverklo) — the MCP server (MIT)
- [Sverklo + Cursor SDK recipe (long-form)](https://sverklo.com/recipes/cursor-sdk/)
- [Sverklo's 60-task retrieval benchmark](https://sverklo.com/bench)
- [Cursor SDK TypeScript docs](https://cursor.com/docs/sdk/typescript)
