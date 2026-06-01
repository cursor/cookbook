# Prompt design playground

A web app for composing agent instructions and user prompts, running them against a local Cursor agent, and iterating on the response.

## What it does

- **Agent instructions** — a persistent preamble prepended to every run, like a system prompt for your agent
- **User prompt** — the task you want the agent to perform
- **Working directory** — the local folder the agent operates in
- **Model selector** — pick from your available Cursor models
- **Streaming response** — see text, thinking blocks, tool calls, and status in real time

## Running it

Set your Cursor API key (from the [Cursor integrations dashboard](https://cursor.com/dashboard/integrations)) as `CURSOR_API_KEY`, or enter it in the app's setup form on first launch.

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

The API key is saved to `~/.prompt-design/settings.json` after validation.

## Project structure

```
src/
├── app/
│   ├── api/
│   │   ├── run/route.ts              # POST → SSE stream of agent events
│   │   ├── models/route.ts           # GET available models
│   │   └── settings/api-key/route.ts # GET/POST/DELETE API key
│   └── page.tsx
├── components/
│   └── prompt-design-app.tsx         # Main playground UI
└── lib/
    └── prompt-design/
        └── server.ts                 # Cursor SDK integration
```
