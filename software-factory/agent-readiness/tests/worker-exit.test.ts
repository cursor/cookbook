import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { resultComplete, supervise, writeResult } from "../support/evals/lib/worker-exit.ts";

const LIB = fileURLToPath(new URL("../support/evals/lib/worker-exit.ts", import.meta.url));
const RESULT = { run: { id: "x", grade: { gates: [{ name: "g", pass: true, detail: "" }] } } };

// A stand-in worker: writes its result, then holds the event loop the way a keep-alive HTTPS
// client does, with an open socket to a local server.
function script(dir: string, body: string): string {
  const f = join(dir, "worker.mjs");
  writeFileSync(f, `import http from "node:http";\nconst lib = await import(${JSON.stringify(LIB)});\nconst out = process.argv[2];\n${body}\n`);
  return f;
}

const HOLD_SOCKET = `const server = http.createServer((_q, r) => r.end("ok")).listen(0);
await new Promise((r) => server.once("listening", r));
const agent = new http.Agent({ keepAlive: true });
await new Promise((r) => http.get({ port: server.address().port, agent }, (res) => { res.resume(); res.on("end", r); }));`;

function start(f: string, out: string) {
  return spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", f, out], { stdio: "ignore" });
}

describe("eval workers exit once their result is written", () => {
  test("writeResult is atomic and resultComplete only accepts a whole result", () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-"));
    const out = join(dir, "r.run.json");
    assert.equal(resultComplete(out), false);
    writeFileSync(out, '{"run": {"grade": {"ga');
    assert.equal(resultComplete(out), false, "half a file");
    writeResult(out, RESULT);
    assert.equal(resultComplete(out), true);
    assert.equal(existsSync(`${out}.partial`), false);
  });

  test("a worker holding a keep-alive socket exits as soon as it calls exitWhenFlushed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-"));
    const out = join(dir, "r.run.json");
    const f = script(dir, `${HOLD_SOCKET}\nlib.writeResult(out, ${JSON.stringify(RESULT)});\nlib.exitWhenFlushed(0);`);
    const started = Date.now();
    const s = await supervise(start(f, out), out, { graceMs: 20000, hardMs: 30000, pollMs: 50 });
    assert.equal(s.code, 0);
    assert.equal(s.stoppedAfterResult, false);
    assert.ok(Date.now() - started < 10000, "it didn't wait on the socket");
    assert.equal(resultComplete(out), true);
  });

  test("the parent stops a worker that wrote a complete result and hangs, and keeps the result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-"));
    const out = join(dir, "r.run.json");
    const f = script(dir, `${HOLD_SOCKET}\nlib.writeResult(out, ${JSON.stringify(RESULT)});`);
    const lines: string[] = [];
    const s = await supervise(start(f, out), out, { graceMs: 300, hardMs: 30000, pollMs: 50, log: (l) => lines.push(l) });
    assert.equal(s.stoppedAfterResult, true);
    assert.equal(s.timedOut, false);
    assert.equal(resultComplete(out), true);
    assert.match(lines.join(), /hadn't exited .* keeping its result/);
  });

  test("a worker with no result is killed at the hard limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-"));
    const out = join(dir, "r.run.json");
    const f = script(dir, HOLD_SOCKET);
    const s = await supervise(start(f, out), out, { graceMs: 300, hardMs: 1500, pollMs: 50 });
    assert.equal(s.timedOut, true);
    assert.equal(s.signal, "SIGKILL");
    assert.equal(existsSync(out), false);
  });
});
