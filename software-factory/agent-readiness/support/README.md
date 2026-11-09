# Maintainer support

This folder is for people who change the agent-readiness skill and need to validate those changes. End users only need the skill under `../skill/agent-readiness/` and the example reports under `../examples/`.

| Path | Purpose |
|---|---|
| `evals/` | Skill evals against `@cursor/sdk`, negative cases, baseline, METHOD.md, goldens and labels |
| `fixtures/` | Tiny repos with planted defects and `expected.json` (diagnostic ground truth) |
| `tools/` | Sample-report generator, fixture helpers, release-manifest writer, env-prefix scanner |
| `examples/github-workflows/` | Example CI for static checks, scheduled recheck and skill evals |
| `AGENTS.md`, `PRODUCT.md`, `RELEASE.md` | Rules for changing the accelerator, product notes and release-gate policy |

## Commands (from the example root)

```bash
npm ci
npm run check
npm run evals -- --tag smoke
npm run evals -- --tag negative
npm run goldens
npm run sample
npm run release-manifest   # after changing skill scripts, rubric, schemas or templates
npm run evals -- --release-check support/evals/runs/result.json
```

`npm run evals` needs a `CURSOR_API_KEY` for agent arms. Compare against `support/evals/baseline.json`. See [evals/README.md](evals/README.md) and [RELEASE.md](RELEASE.md).
