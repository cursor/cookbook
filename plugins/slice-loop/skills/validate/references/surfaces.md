# Validation by surface

"End-to-end" means: drive the system the way its real user or caller does, and capture what they would see. Pick the section matching each surface the slice touches.

## Web UI

**Drive:** the project's E2E suite (Playwright, Cypress) if it has one. Otherwise use `scripts/run_flow.mjs` with a flow module:

```js
// .cursor/loop/flows/create-task.mjs
export default async function ({ page, step, capture, baseURL, expect }) {
  await step("open board", () => page.goto(baseURL + "/"));
  await capture("AC-3-empty");
  await step("add task", async () => {
    await page.getByLabel("Task title").fill("Write report");
    await page.getByRole("button", { name: "Add" }).click();
  });
  await expect(page.getByText("Write report")).toBeVisible();
  await capture("AC-1-populated");
}
```

```bash
node <scripts>/run_flow.mjs .cursor/loop/flows/create-task.mjs \
  --base-url "$BOOT_URL" --out "$scratch/flows/create-task" \
  --scratch "$scratch_root" --slow-mo 250 [--mobile] [--timeout 3000]
```

The runner writes `steps.json` (each step's status and timing, script `console_errors`, HTTP `resource_errors`, `failed_requests`), `shots/<name>.png` for each capture, and `video/*.webm`. It resolves Playwright from the project first and then from `<scratch_root>/node_modules`. If Playwright is missing, install it into the scratch root (never the per-slice dir, which validate clears) rather than the project: `npm i --prefix "$scratch_root" playwright`, then `npx --prefix "$scratch_root" playwright install ffmpeg` (video recording needs it even with system Chrome) and `... install chromium` unless a system Chrome exists. Install `@playwright/test` alongside it for the full `expect` API; without it, flows get a minimal fallback (`toBeVisible`, `toBeHidden`, `toHaveText`, `toHaveCount`). Without ffmpeg the runner still passes or fails the flow and captures screenshots, but records no video and adds a warning to `steps.json`.

**Capture:**

- One screenshot per AC capture point, at a 1280×800 viewport.
- Mobile at 390×844 when the plan requires it, using `--mobile`.
- One recording per new flow.
- Console output is evidence. A new script error on a changed screen is an `impl-bug`, even when assertions pass. HTTP errors the plan expects (a validation 400, say) are listed but are not failures.

**Common traps:** animations caught mid-transition (wait for the network to go idle or for an element, not a timeout); dev overlays hiding the page (Next.js and Vite error overlays mean failure); stale servers from a previous run (always tear down, and use the fixed port from the manifest).

## HTTP API

**Drive:** real HTTP against the booted server, using the project's API tests, `hurl`, or `curl`. Never call handlers in-process for the E2E step; that is a unit test.

**Capture:** a transcript per AC, `raw/api-AC-n.txt`, containing the method, path, the relevant headers (redact auth), the request body, the status, and the response body trimmed to the asserted fields. The report cites the transcript and quotes the status line plus the key field.

**Also check:** the error shape for unhappy paths, the status codes, and that the OpenAPI/schema matches when one exists.

## CLI

**Drive:** run the built binary or entrypoint in a temp working dir (`$scratch/cli`) with fixture inputs.

**Capture:** a transcript per AC with the command, exit code, and stdout/stderr, passed through `compress_log.py` when long. For interactive or TUI programs, record with `asciinema` or `script` when available, and attach the cast or a GIF.

**Also check:** `--help` still renders, exit codes on bad input, and no writes outside the working dir.

## Library / SDK

**Drive:** a consumer-style script in `$scratch/consumer` that imports the package the way users do (from the built output or a packed tarball, not from source paths).

**Capture:** the script and its output. For typed languages, a compile check of the consumer against the public types.

## Worker, queue, cron, or data job

**Drive:** run the job once against seeded local inputs (fixture files, a local queue or emulator, or a throwaway DB in scratch).

**Capture:** a before/after summary of the outputs (row counts, sample rows, files written, messages emitted) plus the job log excerpt. For data jobs, include a small sample table in the report, never the full output.

## Mobile (React Native, Flutter, native)

**Drive:** prefer a web build or component harness when one exists (Expo web, Storybook, Flutter web). Use simulator automation (Detox, Maestro) only if the project already has it set up.

**Capture:** the same as Web UI, at device viewport sizes.

## Infra / IaC

**Drive:** `plan` or `diff` only (`terraform plan`, `cdk diff`, `helm template`, `kubectl --dry-run=server`). Never apply.

**Capture:** the plan output passed through `compress_log.py`, with the resources-changed summary quoted in the report.
