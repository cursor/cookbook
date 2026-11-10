# Sample run

The output of one autonomous dry run against [`../tasks-app`](../tasks-app). `/create-loop` ran in autonomous mode, then `implement-slice` took one slice through plan, scaffold, implement, and validate, and stopped at review.

**Requirement:** reject blank task titles: the API returns 400 `{ "error": "Title is required" }`, and the UI shows the message inline and clears it after a successful add.

**Result:** PASS on the first iteration. All 5 criteria pass, with lint, tests, both E2E flows, and the contract audit green.

| What | Where |
| --- | --- |
| Review packet (start here) | [`loop/runs/20261005-reject-blank-titles/validate/report.md`](loop/runs/20261005-reject-blank-titles/validate/report.md) |
| Generated manifest | [`loop/LOOP.md`](loop/LOOP.md) |
| Generated context, harness, flows | [`loop/context/`](loop/context), [`loop/scripts/`](loop/scripts), [`loop/flows/`](loop/flows) |
| Plan, scaffold contract, iteration log | [`loop/runs/20261005-reject-blank-titles/`](loop/runs/20261005-reject-blank-titles) |
| Code change the loop produced | [`slice.diff`](slice.diff) |

In a real repo, `loop/` lives at `.cursor/loop/`. This run used plugin v0.1.0, when `/create-loop` and `/plan-tasks` were still called `/nudge` and `/plan` (the generated files use the old names) and before the dry-run fixes landed, so the packet predates two changes: export now copies `plan.md` into the packet, and HTTP errors are reported separately from script console errors.
