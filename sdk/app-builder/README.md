# Cursor SDK App Builder

This is a small showcase of what can be built with the Cursor SDK. It starts a local Cursor agent session, scaffolds a hot-reloading React preview app, and lets you iterate on that app from a chat UI.

The goal is to demonstrate an end-to-end app-building loop:

- collect a Cursor API key locally,
- create an isolated preview workspace,
- stream agent responses and tool activity,
- preview generated UI in an iframe,
- manage multiple app-building conversations.

## Getting Started

Install dependencies and start the Next.js host app:

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

On first launch, paste a Cursor API key. The app stores it locally in `~/.app-builder/settings.json` and uses it to create local agent sessions.

Optional environment variables:

- `CURSOR_MODEL`: model id for the builder sessions (default `composer-2`).
- `CURSOR_PROJECT_NAME_MODEL`: model id used to generate project names (default `composer-2`).
- `CURSOR_PROJECT_NAME_TIMEOUT_MS`: timeout for project-name generation in milliseconds (default `15000`).

## Notes

This app is intended as a local Cursor SDK demo. Do not deploy it as a shared public service without adding authentication, per-user storage, and stronger secret handling.