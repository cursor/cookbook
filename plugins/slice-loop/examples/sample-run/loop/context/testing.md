# Testing

## Frameworks

- Unit/integration: `node:test` + `node:assert/strict`, run with `node --test test/*.test.js`, single file with `node --test {file}`. `npm test` (`node --test test/`) is broken on Node 22.
- E2E: none in the project — see `validation.md` (flow modules run by `run_flow.mjs`).

## Layout

- New tests go in `test/`. Name them `<area>.test.js`. Test names start with the AC id: `test("AC-2: ...")`.
- HTTP-level tests cannot import `server.js` (it listens on import). Spawn it as a child process with `SEED=0` and use global `fetch`. `PORT=0` is not supported (the server logs the requested port, not the bound one), so pick an OS-assigned free port first with a `node:net` probe; never hard-code a test port. See `test/api.test.js`.

## Fixtures and mocks

- No helpers exist yet. Fixtures are literal strings passed to `createStore([...])`.
- Network mocking: not needed; there are no external services.
- Never: add npm dependencies for testing.
