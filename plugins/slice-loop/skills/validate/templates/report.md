# <PASS | FAIL | BLOCKED> — <slice title>

`<slice-id>` · iteration <n> · `<short sha>` · [plan](plan.md) · [verdict.json](verdict.json)

- **Changed:** <one sentence a reviewer can repeat to someone else>
- **Proof:** <N/N acceptance criteria pass; tests X passed, Y failed; E2E flows A/B>
- **Watch:** <the one thing most likely to be wrong, or "Nothing flagged">

<!-- Lead screenshot or recording: the single image that best shows the slice working (or failing). -->
![<what this shows>](artifacts/<lead>.png)

## Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-1 | PASS | `<test name>` · [screenshot](artifacts/AC-1-<state>.png) — <caption> |
| AC-2 | FAIL | [F1](#f1) |

## Gates

| Gate | Result | Excerpt |
| --- | --- | --- |
| lint | pass | [raw](raw/lint.txt) |
| typecheck | pass | [raw](raw/typecheck.txt) |
| test | 41 passed, 1 failed, 0 skipped | [raw](raw/test.txt) |
| e2e | 2/2 flows | [steps](raw/flows.json) |
| contract | intact | no unlogged test changes |

## Flows

### <flow name> — <pass | fail at step k>

[Recording (<s>s)](artifacts/<flow>.mp4) · ![preview](artifacts/<flow>.gif)

<!-- Optional: contact sheet for skimming. -->
![key frames](artifacts/<flow>-sheet.jpg)

## Failures

### F1

**Class:** impl-bug · **AC:** AC-2 · **Route:** implement

<one-sentence diagnosis>

```text
<≤10 lines of the decisive excerpt>
```

[Full excerpt](raw/test.txt)

## Changes

```text
<git diff --stat, trimmed to the touched files>
```

Test changes logged by implement: <none | list>.

## Risks and follow-ups

- <concrete risk or follow-up slice; omit section if none>

## Reproduce

```bash
<exact commands to re-run the failing or key checks>
```
