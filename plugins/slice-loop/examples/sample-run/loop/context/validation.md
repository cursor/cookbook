# Validation

## Boot

1. `.cursor/loop/scripts/boot.sh`; it waits for `http://127.0.0.1:4319/api/tasks`. Logs go to `/tmp/slice-loop/.boot/server.log`, PID to `/tmp/slice-loop/.boot/server.pid`.
2. Seed: none. The server boots with two fixed tasks ("Draft the quarterly report", "Book venue for offsite"). `SEED=0 .cursor/loop/scripts/boot.sh` boots empty.
3. Stop: `.cursor/loop/scripts/teardown.sh` (kills the PID and anything still listening on 4319).

Data is in memory and shared by every flow in one boot. Flows must assert relative changes (count before vs. after), not absolute counts, or the order flows run in will matter.

## Driving the app

- Tool: `run_flow.mjs` from the `validate` skill's `scripts/` dir, with `--scratch /tmp/slice-loop` so it finds Playwright. Uses system Chrome at `/usr/local/bin/google-chrome` when Playwright's bundled browser is absent.
- `@playwright/test` is not installed, so flows get the runner's fallback `expect`: only `toBeVisible`, `toBeHidden`, `toHaveText`, `toHaveCount`. No `.not`, no `toHaveValue`. Use `locator.count()` / `inputValue()` with `node:assert` for anything else.
- Auth: none.
- Stable selectors: `getByLabel("Task title")` (input), `getByRole("button", { name: "Add" })`, `getByRole("list", { name: "Tasks" })` and its `listitem`s. The empty state ("No tasks yet…") is also an `li`, so item counts are only meaningful with the default seed.

## Canonical flows

### create-task (`flows/create-task.mjs`)

1. Open `/`.
2. Count list items.
3. Type a unique title, click Add.
Expected: the new title is visible and the list grew by one.

## Capture

- Screenshots: viewport 1280×800; capture the landing state and the state after each user action an AC names.
- Recording: one per new flow, well under 60 s (flows here take ~2 s).
- Mobile viewport: no; the page is a single centered column.
