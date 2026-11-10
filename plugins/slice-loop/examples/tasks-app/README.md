# tasks-app

A deliberately small task list (Node standard library only) used as a fixture for the Slice Loop plugin: `tests/test_run_flow.py` drives it with `run_flow.mjs`, and it is the target for end-to-end dry runs of `/create-loop` and `implement-slice`.

```bash
npm start   # http://127.0.0.1:4317 (PORT and SEED=0 env vars supported)
npm test
npm run lint
```
