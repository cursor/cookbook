# Discovery checklist

Read in this order. Stop digging into an area once it is answered. For each answer, note the source file and whether it was verified by running it.

## Ground truth sources (highest trust first)

1. Commands you ran successfully during discovery.
2. CI config: `.github/workflows/*`, `.gitlab-ci.yml`, `.circleci/`, `buildkite`, `Jenkinsfile`, `azure-pipelines.yml`.
3. Task runners: `package.json` scripts, `Makefile`, `justfile`, `Taskfile.yml`, `pyproject.toml` (`[tool.*]`, scripts), `Cargo.toml`, `go.mod` plus `magefile`, `build.gradle`, `pom.xml`, `mix.exs`, `Gemfile` plus `Rakefile`.
4. Agent and contributor docs: `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`, `.cursor/skills/`, `CONTRIBUTING.md`, `docs/`.
5. README.

## What to extract

| Area | Look for | Feeds |
| --- | --- | --- |
| Stack and package manager | lockfiles (`pnpm-lock.yaml`, `uv.lock`, `poetry.lock`, `Cargo.lock`), runtime version files (`.nvmrc`, `.tool-versions`, `.python-version`) | `commands.install` |
| Layout | monorepo markers (`pnpm-workspace.yaml`, `turbo.json`, `nx.json`, Cargo/Go workspaces), app vs. library packages | overlays, `architecture.md` |
| Surfaces | web UI (pages/routes, `next.config`, `vite.config`), HTTP API (route handlers, OpenAPI), CLI (bin entries, `argparse`/`clap`/`cobra`), library (exports only), worker/queue, data job, mobile, infra | `surfaces`, `validation.md` |
| Commands | lint, format, typecheck, unit test, single-file test, E2E, build, dev server | `commands.*` |
| Test setup | frameworks, test dir conventions, fixtures, factories, snapshot usage, coverage config, existing mocks (`msw`, `nock`, `responses`, `vcr`, testcontainers) | `testing.md` |
| E2E tooling | Playwright, Cypress, Selenium, Detox, Maestro, `httpie`/`hurl` collections, Postman | `validation.md`, `commands.e2e` |
| Boot | dev server port, required sidecars (DB, Redis, queues), `docker-compose.yml`, `Procfile`, health endpoints | `boot.*` |
| Config and secrets | `.env.example`, `config/*.example`, secret managers referenced in code, feature flags | mock policy, `validation.md` |
| External services | third-party SDK imports (Stripe, OpenAI, S3, auth providers) | mock policy |
| Data | ORMs, migrations dirs, seed scripts, fixture data | `seed`, `implement` overlay |
| Codegen | GraphQL/OpenAPI/protobuf generators, Prisma, `go generate` | `implement` overlay |
| Conventions | lint config, formatter, naming, error-handling patterns, class joiners, design tokens | `architecture.md` |
| Domain | glossary in docs, core entities, invariants enforced in validators, business rules in tests | `domain.md` |

## Signals that demand an overlay

- No unit-test runner at all.
- Tests need a live service that cannot run locally.
- E2E needs auth: plan a mock session or a seeded test user, never real credentials.
- Generated artifacts are committed, such as HTML output or client SDKs. Edit the source, regenerate, never hand-edit output.
- Commands must run per package rather than at the root.
- Non-web surfaces where "click through the app" means something else: CLI transcripts, API request logs, notebook outputs, rendered PDFs.

## Running things during discovery

Allowed: install, lint, typecheck, one fast test file, `--help` on CLIs, booting the dev server briefly.
Not allowed: migrations against shared databases, deploys, anything that needs real credentials. The full suite runs once, in the harness smoke step, not during discovery.
