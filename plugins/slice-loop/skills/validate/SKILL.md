---
name: validate
description: Slice Loop step 4 and the loop's quality gate. Independently re-runs static checks, tests, and end-to-end flows against the plan (booting the app and clicking through it for UIs), audits that the test contract was not weakened, looks at the captured evidence, and writes a compressed review packet (verdict, AC table, screenshots, short video, log excerpts) a human can scan in under two minutes. Use for /validate, after /implement, or to produce reviewable evidence for any change.
---

# /validate — prove it, then compress the proof

Validation is the only step whose output a human reads. Two jobs, equally important:

1. **Prove**: every acceptance criterion is shown to work by evidence produced in this step. Claims from `implement` count for nothing.
2. **Compress**: turn that evidence into a packet a reviewer can scan in under two minutes, with every claim one click from its raw proof.

`validate` never edits production code or tests. It writes only to `<run>/validate/`, the scratch dir, and the artifacts export dir.

## Load the loop

1. Read `.cursor/loop/LOOP.md`. If it is missing, run the `create-loop` skill first.
2. If `.cursor/loop/overlays/validate.md` exists, apply its Skip, Replace, and Add entries to the steps below, matched by heading.
3. Read `context/validation.md`, plus `context/review.md` if it exists and `context/testing.md` when parsing test output.
4. Read `<run>/plan.md`, `<run>/scaffold.md`, `<run>/implement.md`, and `<run>/state.json`.
5. Check `## Harness status` in the manifest. A gate that never passed during `create-loop` gets reported as `harness-unproven`, not silently trusted.

Scripts referenced below live in this skill's `scripts/` directory. Resolve their absolute path from this file's location.

## Steps

### 1. Prepare a clean run

- `out=<run>/validate`. Move any previous `out` to `<run>/validate.prev/` so retries can be compared. Then create `out/artifacts/` and `out/raw/`, and copy `<run>/plan.md` to `out/plan.md`: the packet carries the plan it was judged against.
- `scratch_root=<dirs.scratch>` holds shared tooling (Playwright) and `.boot/` PIDs. Never clear it.
- `scratch=<scratch_root>/<slice-id>` holds this run's raw logs and media. Clear only this directory.
- Record `git rev-parse HEAD` and `git status --porcelain`. Uncommitted changes go in the report; they are what is being validated.

### 2. Static gates

Run each of `lint`, `typecheck`, and `build` that appears in `gates`, in order. Do not stop at the first failure; reviewers need the full picture. For each one:

```bash
<cmd> > "$scratch/<gate>.log" 2>&1; echo $? > "$scratch/<gate>.exit"
python3 <scripts>/compress_log.py "$scratch/<gate>.log" --max-lines 80 > "$out/raw/<gate>.txt"
```

### 3. Tests

Run `commands.test`, the full suite, not just the new files. Capture the output the same way. Extract the totals (passed, failed, skipped) and the names of failing tests. Mark failures that also fail on the base commit as `pre-existing` (check with `git stash` or a worktree only if the cause is unclear).

### 4. Contract audit

Find the scaffold commit (`test(<slice-id>): scaffold ...`), or the scaffolded files listed in `scaffold.md`. Then:

- `git diff <scaffold-commit>..HEAD -- <test files> <flow files>`. Flow modules in `.cursor/loop/flows/` are contract files too. Any change not listed under **Test changes** in `implement.md` is a failure of class `contract`.
- Grep the diff for added `.skip`, `.only`, `xit`, `xfail`, `@Ignore`, `t.Skip`, commented-out assertions, or loosened matchers. Each one is a `contract` failure unless it is logged with a reason.
- Confirm every AC in `plan.md` has a test or flow in `scaffold.md`. A missing one is a `spec-gap` failure.

### 5. End-to-end flows

Skip this step only when `surfaces` has no runnable surface, or an overlay says to. Follow `references/surfaces.md` for the surface type.

1. Boot: run `boot.start`, poll `boot.health` until `boot.timeout_s`, and run `boot.seed`. Register teardown first (`trap '<boot.stop>' EXIT`) so a failure never leaves processes behind.
2. Run the new flows from `scaffold.md` and the regression flows named in `plan.md`, resetting state with `boot.seed` between flows when the app keeps state in memory. Prefer the project's own E2E runner. If it has none (`commands.e2e` is `run_flow`), use `scripts/run_flow.mjs` with `--scratch "$scratch_root"` and `--slow-mo 250`, so the recording is watchable. It records video and capture points and logs script console errors, HTTP resource errors, and failed requests separately.
3. Collect per flow: pass or fail, the failing step, screenshots at each capture point, one recording, console errors, and failed network requests (or API transcripts and CLI transcripts for those surfaces). A script error (`console_errors`, `pageerror`) on a changed screen is an `impl-bug`, even when assertions pass. HTTP errors (`resource_errors`, `failed_requests`) are failures unless the plan says the flow triggers that status on purpose, such as a validation 400. List expected ones in the report anyway.
4. Tear down, even on failure.

### 6. Look at the evidence

Tests can pass on a broken screen. **Open every screenshot you will cite** (read the image file) and check it against the AC it claims to prove: correct content, no error overlay, no blank page, no layout collapse, readable at the captured viewport. If the plan requires mobile, check the mobile capture too. Write one line per image saying what it shows. Those lines become the captions.

If a computer-use subagent is available and the surface is a web UI, you may run a short exploratory pass over the changed screens. Treat its findings as evidence like any other, and include only what it actually captured.

### 7. Acceptance-criteria audit

For every AC, assign one result:

- `PASS`: the named test passed, **and** (for e2e or visual proofs) a cited screenshot or transcript shows the behavior.
- `FAIL`: a test or flow failed, or the evidence contradicts the claim.
- `UNVERIFIED`: no evidence was produced. This counts as a failure.

### 8. Classify failures and choose the verdict

Give each failure a class. The class decides where the loop goes next:

| Class | Meaning | Route |
| --- | --- | --- |
| `impl-bug` | Code does not meet a clear AC | back to `implement` |
| `contract` | Tests weakened, or test changes not logged | back to `implement`, with the revert named |
| `spec-gap` | AC is ambiguous, contradictory, or missing coverage | back to `plan-tasks` |
| `regression` | A previously passing test or flow now fails | back to `implement` |
| `env` | Harness, flake, port, or install problem | retry once; then `blocked` |
| `harness-unproven` | A gate never passed during create-loop | report; do not route |

Verdict: `pass` (every AC passes and no required gate fails) · `fail` (any routable failure) · `blocked` (only `env` or `harness-unproven` failures remain after one retry).

Write `out/verdict.json`:

```json
{
  "verdict": "fail",
  "head": "<sha>",
  "gates": { "lint": "pass", "typecheck": "pass", "test": "fail", "e2e": "pass", "contract": "pass" },
  "acceptance": { "AC-1": "PASS", "AC-2": "FAIL" },
  "failures": [{ "id": "F1", "class": "impl-bug", "ac": "AC-2", "summary": "empty title accepted", "evidence": "raw/test.txt#L12" }],
  "route": "implement"
}
```

### 9. Compress the evidence

Budgets: report ≤ `limits.report_max_lines` lines; each video ≤ `limits.video_max_seconds`; total `artifacts/` ≤ 25 MB.

```bash
S=<scripts>
bash $S/compress_media.sh image  "$scratch/shots/AC-1-populated.png" "$out/artifacts/AC-1-populated.png"
bash $S/compress_media.sh video  "$scratch/video/flow-create-task.webm" "$out/artifacts/flow-create-task.mp4" <video_max_seconds>
bash $S/compress_media.sh gif    "$scratch/video/flow-create-task.webm" "$out/artifacts/flow-create-task.gif" 12
bash $S/compress_media.sh sheet  "$scratch/video/flow-create-task.webm" "$out/artifacts/flow-create-task-sheet.jpg" 6
```

- Cite one screenshot per AC: the single state that proves it. Put other captures in `artifacts/` without citing them.
- Use one recording per new flow. The GIF preview and contact sheet let a reviewer skim without playing it.
- Logs: only `compress_log.py` excerpts go in `raw/`. The report quotes at most 10 lines per failure and links the rest.
- Never put secrets, tokens, or real PII into artifacts. Fixtures should be synthetic. Scrub anything else.

### 10. Write the report

Fill `templates/report.md` into `out/report.md`, then apply `context/review.md` preferences: lead with what the reviewer asked for. Writing rules:

- The first line is the verdict. The next three bullets say what changed, what proves it, and what to worry about.
- Use relative links (`artifacts/...`, `raw/...`) so the packet renders anywhere it is copied.
- Write in complete sentences. Don't use invented shorthand, and don't narrate your process.
- If it is over budget, cut detail, not evidence links.

### 11. Export

If `dirs.artifacts_export` exists, copy `out/report.md`, `out/verdict.json`, `out/plan.md`, `out/artifacts/`, and `out/raw/` to `<artifacts_export>/<slice-id>/`, keeping relative paths intact, so every link in the report resolves. Also copy the lead screenshot and the main recording to the export root as `<slice-id>-<name>.<ext>`, so they surface directly in the cloud agent's artifact view without colliding across slices. If `review.persist_reports` is `commit`, stage `out/report.md` and `out/artifacts/`.

## Finish

Update `state.json`: set `phase` to `validate`, set `status` to `done`, set `verdict`, and append to `history`. Return the verdict, the route, and the path to `report.md`.
