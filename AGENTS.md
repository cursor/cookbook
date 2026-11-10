# AGENTS.md

## Cursor Cloud specific instructions

This repo (the **Cursor Cookbook**) is a collection of independent examples, not a
unified monorepo. Runnable code lives under `sdk/`; `hooks/` are event scripts and
`self-hosted-cloud-agent/` is deployment/infra (Docker/Terraform/Helm), neither of
which is a local dev service.

### Layout & tooling
- Each `sdk/<example>` is its own pnpm workspace (own `pnpm-lock.yaml`). Install and
  run **per-directory** — there is no root `package.json`.
- Node 22 and pnpm are preinstalled. The update script runs `pnpm install` in every
  `sdk/*` example.
- `sdk/coding-agent-cli` requires **Bun** (uses `bun:ffi`); the others run on Node.
  Bun is installed at `~/.bun/bin` (added to `~/.bashrc` PATH by the installer). If
  `bun` is not found in a non-interactive shell, use `export PATH="$HOME/.bun/bin:$PATH"`.
- `node_modules/`, `dist/`, and `.canvas/` are gitignored (generated output).

### API key requirement (important gotcha)
- Every SDK example needs a **valid `CURSOR_API_KEY`** (`crsr_...`, from
  https://cursor.com/dashboard/integrations) to do real agent work. The CLIs read it
  from the env; the two web apps collect it via onboarding UI (stored under
  `~/.app-builder/settings.json` / `~/.agent-kanban/settings.json`).
- The env var `FE_ADM_API_KEY` present in this environment is **NOT** a valid Cursor
  SDK key — the SDK rejects it with "Invalid API key". To run agent flows end-to-end,
  add a real `CURSOR_API_KEY` secret.
- Without a valid key you can still verify: install, lint, typecheck, `next build`,
  dev servers booting + onboarding UI, and `sdk/dag-task-runner`'s `pnpm init-canvas`
  (the only agent-free action — writes a `.canvas.tsx` file).

### Per-example commands (see each `package.json` / `README.md`)
- `sdk/quickstart` (Node CLI): `pnpm dev` (needs key), `pnpm build`, `pnpm typecheck`.
- `sdk/dag-task-runner` (Node CLI): `pnpm init-canvas` (no key), `pnpm example` (needs
  key), `pnpm build`, `pnpm typecheck`.
- `sdk/coding-agent-cli` (Bun TUI): `pnpm typecheck`; run with `bun run dev`.
- `sdk/app-builder` (Next.js web): `pnpm dev`, `pnpm build`, `pnpm lint`.
- `sdk/agent-kanban` (Next.js web): `pnpm dev`, `pnpm build`, `pnpm lint`.

### Running the web apps
- Both `app-builder` and `agent-kanban` default to **port 3000** — run one at a time,
  or pass `pnpm dev -- -p <port>`.
- `agent-kanban` install ignores optional build scripts (`sharp`, `msw`,
  `unrs-resolver`) via `onlyBuiltDependencies`; dev still works (Next falls back to a
  non-native image optimizer).
