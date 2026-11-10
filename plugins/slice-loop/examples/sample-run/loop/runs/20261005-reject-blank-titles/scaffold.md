# Scaffold: contract

| AC | Test / flow | Red reason (one line) |
| --- | --- | --- |
| AC-1 | `test/api.test.js` › "AC-1: rejects an empty title with 400 and creates no task" | status 201, expected 400 |
| AC-2 | `test/api.test.js` › "AC-2: rejects a whitespace-only title with 400 and creates no task" | status 201, expected 400 |
| AC-3 | `test/api.test.js` › "AC-3: rejects a missing title with 400 and creates no task" | status 201, expected 400 |
| AC-4 | `.cursor/loop/flows/blank-title.mjs` › steps "AC-4: submit empty title", "AC-4: submit whitespace-only title" | "Title is required" never becomes visible (3 s timeout) |
| AC-5 | `.cursor/loop/flows/blank-title.mjs` › steps "AC-5: submit a valid title", "AC-5: message cleared" | not reached; flow stops at AC-4 |

Guard test (already green, must stay green): `test/api.test.js` › "still creates a task from a valid title".

## Mocks, fixtures, stubs

- `test/api.test.js` spawns the real `server.js` as a child process on an OS-assigned free port with `SEED=0`. No mocks; there are no external services.
- Flow fixtures: unique titles built from `Date.now()`, so reruns against one boot never collide. Assertions compare counts before and after, never absolute counts.
- No interface stubs: the route, page, and input already exist.

## Reproduce red

```bash
node --test test/api.test.js
.cursor/loop/scripts/boot.sh
node <validate-skill>/scripts/run_flow.mjs .cursor/loop/flows/blank-title.mjs \
  --base-url http://127.0.0.1:4319 --out /tmp/slice-loop/scaffold-red/blank-title --scratch /tmp/slice-loop --timeout 3000
.cursor/loop/scripts/teardown.sh
```

Existing suite: `node --test test/tasks.test.js` still passes 2/2.
