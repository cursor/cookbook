# Cursor SDK Test Generator

A local Cursor SDK example that points an agent at source files, generates unit tests, runs them, and feeds failures back into the agent until the tests pass or the iteration limit is reached.

This example demonstrates:

- TypeScript/JavaScript test generation for Vitest or Jest projects,
- Python test generation for Pytest projects,
- deterministic test execution outside the agent loop,
- an Ink TUI with file selection, live progress, model selection, cancellation, and diff review.

## Getting Started

Use Node.js 22 or newer.

Install dependencies:

```bash
pnpm install
```

Set a Cursor API key:

```bash
export CURSOR_API_KEY="crsr_..."
```

Generate tests for a TypeScript file and auto-accept the result:

```bash
pnpm dev -- examples/sample.ts --yes
```

Generate tests for a Python file:

```bash
pnpm dev -- examples/sample.py --lang python --yes
```

Start the interactive TUI by omitting files:

```bash
pnpm dev
```

## CLI Options

```bash
test-gen [files...|globs...] [options]

  -C, --cwd <path>          Workspace root. Defaults to cwd.
      --lang <ts|js|python> Override language detection.
      --framework <name>    Override framework detection: vitest, jest, pytest.
      --max-iters <n>       Test repair iterations. Defaults to 3.
      --allow-source-edits  Let the agent fix source bugs during repair.
      --overwrite           Overwrite existing test files.
  -y, --yes                 Auto-accept generated test files.
  -m, --model <id>          Model id. Defaults to CURSOR_MODEL or composer-2.
```

## Notes

The agent writes or repairs tests, but this app runs the tests itself with the detected framework. That keeps the pass/fail signal deterministic and makes it easy to stream test output into the TUI.

If your package manager ignores native dependency build scripts and the SDK reports a missing `sqlite3` binding, approve or rebuild the native dependency before running the agent loop.

Cloud execution, coverage-guided test generation, mutation testing, and languages beyond TypeScript/JavaScript/Python are intentionally out of scope for this example.
