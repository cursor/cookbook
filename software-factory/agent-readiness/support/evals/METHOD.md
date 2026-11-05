# Eval method

Each round names one failure mode, changes one lever and remeasures the same cases with the same repeats. A change is kept only if its target improves and no hard gate regresses, and every kept change adds a case that would have failed before it. Scoring rules, level rules and each fixture's `expected.json` are frozen during a round.

## Round rules

- **Repeats.** At least 5 per case. Run `npm run evals -- --hill-climb --repeats 5 ...`, which refuses fewer.
- **Report the interval.** Every round gives its before and after with the pooled pass rate's Wilson interval and the judge's bootstrap interval, from the run summary. A change is kept only if the after interval doesn't overlap the before one on its target, and no gate drops by two runs or more in any case.
- **Held-out fixtures.** `standalone-nested-mixed`, `vendored-skill` and `write-mode-lint` are left out of every round (`--hill-climb` drops them). Report them once per release with `--include-holdout`, separately.
- **One instrument.** Before and after use the same driver model, judge model, driver, judge prompt and agent isolation. The baseline's `instrument` records these. Agents run with only the repo's rules and skills (see the [evals README](README.md#isolation)).
- **Lift.** A round that changes narration or SKILL.md also reports the lift over `--arm scripted`. When the lift is zero, the narration change added nothing measurable.
- **Judge prompts.** When the judge prompts change, older judge scores aren't comparable with later ones. The [evals README](README.md#measurement) has the details.

## Baseline

`baseline.json` is a full-set recording used by CI `compare()`: agent and scripted arms, 5 repeats, Docker, isolated agents. Re-record it when the driver model, judge model, driver, rubric version or judge prompts change. Record before/after numbers for a kept change in the PR description; do not append a private development log here.
