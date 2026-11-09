import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// An eval worker can write its result and still never exit: the SDK and judge clients leave
// keep-alive HTTPS sockets open, which hold Node's event loop. The worker exits as soon as its
// result is on disk, and the parent stops waiting for a worker whose result is complete.

// Written to a temporary file and renamed, so a reader never sees half a result.
export function writeResult(path: string, data: unknown): void {
  const tmp = `${path}.partial`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

// A result the parent can use: it parses and holds a run with its gates.
export function resultComplete(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as { run?: { grade?: { gates?: unknown } } };
    return Array.isArray(saved.run?.grade?.gates);
  } catch {
    return false;
  }
}

// Exits once stdout and stderr have drained, whatever sockets or timers are still open.
export function exitWhenFlushed(code: number): void {
  let pending = 2;
  const done = () => {
    if (--pending === 0) process.exit(code);
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
}

export interface Supervision {
  code: number | null;
  signal: NodeJS.Signals | null;
  // The worker was stopped after its result was complete; the result stands.
  stoppedAfterResult: boolean;
  // The worker was killed at the hard limit with no complete result.
  timedOut: boolean;
}

export interface SuperviseOptions {
  // How long a worker may run on after its result is complete.
  graceMs: number;
  // The hard limit for the whole worker.
  hardMs: number;
  pollMs?: number;
  log?: (line: string) => void;
}

// Waits for a worker to exit. Once its result file is complete, it gets graceMs more to exit on
// its own, then is stopped and its result kept; with no complete result, it's killed at hardMs.
export function supervise(child: ChildProcess, out: string, o: SuperviseOptions): Promise<Supervision> {
  return new Promise((done) => {
    let stoppedAfterResult = false;
    let timedOut = false;
    let completeAt: number | null = null;
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"), 5000).unref();
    };
    const poll = setInterval(() => {
      if (completeAt === null && resultComplete(out)) completeAt = Date.now();
      if (completeAt !== null && !stoppedAfterResult && Date.now() - completeAt >= o.graceMs) {
        stoppedAfterResult = true;
        o.log?.(`the worker wrote ${out} but hadn't exited ${Math.round(o.graceMs / 1000)}s later; stopping it and keeping its result`);
        stop();
      }
    }, o.pollMs ?? 2000);
    const hard = setTimeout(() => {
      if (stoppedAfterResult) return;
      timedOut = !resultComplete(out);
      stoppedAfterResult = !timedOut;
      child.kill("SIGKILL");
    }, o.hardMs);
    child.on("close", (code, signal) => {
      clearInterval(poll);
      clearTimeout(hard);
      done({ code, signal, stoppedAfterResult, timedOut });
    });
  });
}
