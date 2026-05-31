/**
 * Entry point. Reads a DAG JSON file, runs each task as a Cursor SDK local
 * subagent in topological order, and writes live status into a `.canvas.tsx`.
 *
 * Two modes:
 *
 *   --init-only   Write the initial all-PENDING canvas to disk and exit.
 *                 Use this from the parent agent BEFORE launching the runner
 *                 so the canvas file exists and is clickable in chat.
 *
 *   (default)     Run the DAG end-to-end. Reuses an existing canvas file at
 *                 the same path if one exists, otherwise creates it.
 *
 * Path selection (in order of precedence):
 *   --canvas-path <abs-path>           Full canvas path (preferred for parent-managed flow).
 *   --canvas <name> [--canvases-dir]   Compose path from a name + dir.
 *
 * Other options:
 *   --cwd <dir>            Working dir each subagent operates in (default: process.cwd()).
 *   --models-file <path>   Optional JSON complexity -> model override map.
 *   --debounce <ms>        Canvas write debounce (default: 200).
 *   --task-timeout-ms <ms>   Per-task timeout guard (default: 20m).
 *   --stream-publish-ms <ms> Throttle live stream publishes (default: 500ms).
 */

import { Agent } from "@cursor/sdk";
import { setMaxListeners } from "node:events";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { parseDAG, computeRanks, createModelResolver, validateModelMap } from "./dag.js";
import type { ModelMapOverride, RawTask } from "./dag.js";
import {
  CanvasWriter,
  initialRunState,
  type RunState,
  type TaskState,
} from "./canvas_writer.js";

interface CliArgs {
  dag: string;
  canvasPath: string;
  cwd: string;
  modelsFile?: string;
  debounceMs: number;
  taskTimeoutMs: number;
  streamPublishMs: number;
  streamIdleTimeoutMs: number;
  initOnly: boolean;
}

interface RunnerTaskRun {
  stream: () => AsyncIterable<unknown>;
  wait: () => Promise<{
    status: string;
    durationMs?: number;
    usage?: { inputTokens?: number; outputTokens?: number };
  }>;
  cancel?: () => Promise<void> | void;
  status?: string;
  durationMs?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = "true";
    }
  }
  if (!args.dag) throw new Error("--dag <path> is required");

  const cwd = args.cwd ?? process.cwd();
  let canvasPath = args["canvas-path"];
  if (!canvasPath) {
    if (!args.canvas) {
      throw new Error("Provide either --canvas-path <abs-path> or --canvas <name>");
    }
    const canvasesDir = args["canvases-dir"] ?? defaultCanvasesDir(cwd);
    const stem = args.canvas.replace(/\.canvas\.tsx$/, "");
    canvasPath = join(canvasesDir, `${stem}.canvas.tsx`);
  }
  if (!canvasPath.endsWith(".canvas.tsx")) {
    canvasPath = canvasPath.replace(/\.tsx$/, "") + ".canvas.tsx";
  }

  const debounceMs = parsePositiveInt(args.debounce, 200, "--debounce");
  const taskTimeoutMs = parsePositiveInt(
    args["task-timeout-ms"],
    DEFAULT_TASK_TIMEOUT_MS,
    "--task-timeout-ms",
  );
  const streamPublishMs = parsePositiveInt(
    args["stream-publish-ms"],
    DEFAULT_STREAM_PUBLISH_MS,
    "--stream-publish-ms",
  );
  const streamIdleTimeoutMs = parsePositiveInt(
    args["stream-idle-timeout-ms"],
    DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    "--stream-idle-timeout-ms",
  );
  const initOnly = args["init-only"] === "true";
  return {
    dag: args.dag,
    canvasPath,
    cwd,
    modelsFile: args["models-file"],
    debounceMs,
    taskTimeoutMs,
    streamPublishMs,
    streamIdleTimeoutMs,
    initOnly,
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return n;
}

interface ModelOverrideSources {
  dagModels: ModelMapOverride | undefined;
  fileModels: ModelMapOverride | undefined;
}

function mergeModelOverrides({ dagModels, fileModels }: ModelOverrideSources): ModelMapOverride {
  return { ...(dagModels ?? {}), ...(fileModels ?? {}) };
}

/** Mirrors the canvas skill's path scheme. */
function defaultCanvasesDir(cwd: string): string {
  const slug = cwd
    .replace(/^\//, "")
    .replace(/\/+$/, "")
    .split("/")
    .map((seg) => seg.replace(/[^A-Za-z0-9._-]/g, "-"))
    .join("-");
  return join(homedir(), ".cursor", "projects", slug, "canvases");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.initOnly && !process.env.CURSOR_API_KEY) {
    throw new Error(
      "CURSOR_API_KEY is not set. Export it or `set -a && source .env && set +a` first.",
    );
  }

  // The SDK may legitimately attach many AbortSignal listeners for concurrent local runs.
  // Raising the process default prevents noisy MaxListenersExceeded warnings.
  setMaxListeners(ABORT_SIGNAL_LISTENER_LIMIT);

  const raw = JSON.parse(await readFile(args.dag, "utf8"));
  const dag = parseDAG(raw);
  const fileModels =
    args.modelsFile === undefined
      ? undefined
      : validateModelMap(
          JSON.parse(await readFile(args.modelsFile, "utf8")),
          `--models-file ${args.modelsFile}`,
        );
  const modelForComplexity = createModelResolver(
    mergeModelOverrides({ dagModels: dag.models, fileModels }),
  );
  const ranks = computeRanks(dag);

  const state = initialRunState(dag, modelForComplexity);
  const stateById = new Map<string, TaskState>(
    state.tasks.map((t) => [t.id, t]),
  );

  const writer = new CanvasWriter(args.canvasPath, args.debounceMs);
  let finalized = false;
  let interrupting = false;

  console.log(`[dag-runner] DAG "${dag.title}" — ${dag.tasks.length} tasks across ${ranks.length} rank(s)`);
  console.log(`[dag-runner] canvas → ${args.canvasPath}`);

  // Always write the initial all-PENDING canvas first. This is what the parent
  // agent surfaces as a clickable path before any subagent runs.
  writer.schedule(structuredCloneState(state));
  await writer.flush();

  if (args.initOnly) {
    console.log("[dag-runner] --init-only: initial canvas written, exiting");
    return;
  }

  // The Cursor SDK fires background unawaited promises during agent init
  // (e.g. team-repo lookup); when one of those rejects (auth, network) it
  // would otherwise crash the runner before per-task error handling fires.
  // Convert them to a log line so the runner can still mark the task as
  // ERROR, finalize the canvas, and exit cleanly.
  const onUnhandledRejection = (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`[dag-runner] (suppressed unhandled SDK rejection) ${msg}`);
  };
  const onUncaughtException = (err: Error): void => {
    const msg = err?.stack ?? err?.message ?? String(err);
    console.error(`[dag-runner] uncaught exception: ${msg}`);
    void failAndExit(1, "FAILED", `Runner crashed: ${err.message}`);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    const exitCode = signal === "SIGINT" ? 130 : 143;
    console.error(`[dag-runner] received ${signal}; finalizing canvas before exit`);
    void failAndExit(exitCode, "INTERRUPTED", `Runner interrupted by ${signal}`);
  };

  async function failAndExit(
    exitCode: number,
    outcome: "FAILED" | "INTERRUPTED",
    message: string,
  ): Promise<void> {
    if (interrupting) return;
    interrupting = true;
    try {
      await markRunTerminated(state, message, outcome);
      writer.schedule(structuredCloneState(state));
      await writer.flush();
    } catch (flushErr) {
      const flushMsg = flushErr instanceof Error ? flushErr.message : String(flushErr);
      console.error(`[dag-runner] failed to flush canvas during shutdown: ${flushMsg}`);
    } finally {
      finalized = true;
      process.exit(exitCode);
    }
  }

  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

  try {
    for (let rankIdx = 0; rankIdx < ranks.length; rankIdx++) {
      const rank = ranks[rankIdx];
      console.log(
        `[dag-runner] rank ${rankIdx + 1}/${ranks.length}: ${rank.map((t) => t.id).join(", ")}`,
      );
      await Promise.all(
        rank.map((task) => {
          const failedDeps = task.depends_on.filter((depId) => {
            const dep = stateById.get(depId);
            return dep !== undefined && dep.status === "ERROR";
          });
          if (failedDeps.length > 0) {
            skipTask(task, stateById, state, writer, failedDeps);
            return Promise.resolve();
          }
          return runTask(
            task,
            stateById,
            state,
            writer,
            args.cwd,
            {
              taskTimeoutMs: args.taskTimeoutMs,
              streamPublishMs: args.streamPublishMs,
              streamIdleTimeoutMs: args.streamIdleTimeoutMs,
            },
          );
        }),
      );
    }

    state.finishedAt = Date.now();
    const errors = state.tasks.filter((t) => t.status === "ERROR");
    state.runOutcome = errors.length > 0 ? "FAILED" : "SUCCESS";
    if (errors.length > 0) {
      state.runMessage = `Some tasks failed: ${errors.map((e) => e.id).join(", ")}`;
    }
    writer.schedule(structuredCloneState(state));
    await writer.flush();
    finalized = true;

    console.log(
      `[dag-runner] done — ${state.tasks.length - errors.length}/${state.tasks.length} succeeded in ${formatMs(state.finishedAt - state.startedAt)}`,
    );
    if (errors.length > 0) {
      console.log(`[dag-runner] errors: ${errors.map((e) => e.id).join(", ")}`);
      process.exitCode = 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markRunTerminated(state, `Runner failed: ${msg}`, "FAILED");
    writer.schedule(structuredCloneState(state));
    await writer.flush();
    finalized = true;
    throw err;
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    if (!finalized && !interrupting) {
      // Defensive fallback: if control flow exits unexpectedly, reflect this in-canvas.
      await markRunTerminated(state, "Runner exited before finalization", "FAILED");
      writer.schedule(structuredCloneState(state));
      await writer.flush();
    }
  }
}

async function runTask(
  task: RawTask,
  stateById: Map<string, TaskState>,
  state: RunState,
  writer: CanvasWriter,
  cwd: string,
  options: RunTaskOptions,
): Promise<void> {
  const { taskTimeoutMs, streamPublishMs, streamIdleTimeoutMs } = options;
  const ts = stateById.get(task.id)!;
  ts.status = "RUNNING";
  ts.startedAt = Date.now();
  writer.schedule(structuredCloneState(state));

  const upstreamContext = buildUpstreamContext(task, stateById);
  const stitched = upstreamContext
    ? `${upstreamContext}\n\n---\n\n${task.subtask_prompt}`
    : task.subtask_prompt;

  const agent = await Agent.create({
    apiKey: process.env.CURSOR_API_KEY!,
    model: { id: ts.model },
    local: { cwd },
  });

  let run: RunnerTaskRun | undefined;
  const buffer = new BoundedTextBuffer(STREAM_CAP);
  let lastPublishAt = 0;
  const publishIfDue = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastPublishAt < streamPublishMs) return;
    const text = buffer.render();
    if (text.trim()) ts.resultText = text;
    writer.schedule(structuredCloneState(state));
    lastPublishAt = now;
  };
  const deadline = Date.now() + taskTimeoutMs;

  try {
    run = (await agent.send(stitched)) as RunnerTaskRun;
    const iterator = run.stream()[Symbol.asyncIterator]();
    while (true) {
      const timeoutForNext = Math.min(deadline - Date.now(), streamIdleTimeoutMs);
      if (timeoutForNext <= 0) {
        throw new TimeoutError(`Task ${task.id} exceeded deadline of ${formatMs(taskTimeoutMs)}`);
      }
      const next = await withTimeout(
        iterator.next(),
        timeoutForNext,
        streamWaitTimeoutMessage({
          taskId: task.id,
          timeoutMs: timeoutForNext,
          streamIdleTimeoutMs,
        }),
      );
      if (next.done) break;
      const event = next.value as {
        type?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };
      if (event.type === "assistant") {
        let appended = false;
        const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
        for (const block of blocks) {
          if (block.type === "text" && typeof block.text === "string") {
            buffer.append(block.text);
            appended = true;
          }
        }
        if (appended) {
          publishIfDue();
        }
      }
    }
    let result:
      | {
          status: string;
          durationMs?: number;
          usage?: { inputTokens?: number; outputTokens?: number };
        }
      | undefined;
    const waitGraceMs = Math.min(deadline - Date.now(), WAIT_AFTER_STREAM_GRACE_MS);
    if (waitGraceMs <= 0) {
      throw new TimeoutError(`Task ${task.id} exceeded deadline of ${formatMs(taskTimeoutMs)}`);
    }
    try {
      result = await withTimeout(
        run.wait(),
        waitGraceMs,
        `Task ${task.id} did not finalize within ${formatMs(waitGraceMs)} after stream completion`,
      );
    } catch (waitErr) {
      if (
        isTimeoutError(waitErr) &&
        run.status !== "running" &&
        run.status !== undefined
      ) {
        // Fallback for cases where run stream is done but wait() is stuck on local executor close.
        result = {
          status: run.status,
          durationMs: run.durationMs,
        };
      } else {
        throw waitErr;
      }
    }
    if (!result) {
      throw new Error(`Task ${task.id} completed without a result`);
    }

    ts.finishedAt = Date.now();
    ts.durationMs = result.durationMs ?? ts.finishedAt - (ts.startedAt ?? ts.finishedAt);
    ts.inputTokens = result.usage?.inputTokens;
    ts.outputTokens = result.usage?.outputTokens;
    const rendered = buffer.render().trim();
    if (rendered) ts.resultText = rendered;

    if (result.status === "finished") {
      ts.status = "FINISHED";
    } else {
      ts.status = "ERROR";
      ts.errorMessage = `Run ${result.status}`;
    }
  } catch (err) {
    if (run && isTimeoutError(err)) {
      await bestEffortCancel(run, task.id);
    }
    ts.finishedAt = Date.now();
    ts.durationMs = ts.finishedAt - (ts.startedAt ?? ts.finishedAt);
    ts.status = "ERROR";
    ts.errorMessage = err instanceof Error ? err.message : String(err);
    const rendered = buffer.render().trim();
    if (rendered) ts.resultText = rendered;
  } finally {
    if (run && run.status === "running") {
      await bestEffortCancel(run, task.id);
    }
    publishIfDue(true);
    try {
      await (agent as unknown as AsyncDisposable)[Symbol.asyncDispose]();
    } catch {
      // ignore dispose errors
    }
    writer.schedule(structuredCloneState(state));
  }
}

interface RunTaskOptions {
  taskTimeoutMs: number;
  streamPublishMs: number;
  streamIdleTimeoutMs: number;
}

/** Cap on per-task `resultText` size — applies to live streaming and final state. */
const STREAM_CAP = 4000;
/** Hard timeout per task to prevent stale RUNNING tasks. */
const DEFAULT_TASK_TIMEOUT_MS = 20 * 60 * 1000;
/** Throttle live state writes to avoid excessive full-state cloning churn. */
const DEFAULT_STREAM_PUBLISH_MS = 500;
/** Detect stalled stream consumption before full deadline. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** Avoid hanging indefinitely in wait() when stream is already done. */
const WAIT_AFTER_STREAM_GRACE_MS = 15 * 1000;
/** Chars of each parent's output included in the child prompt. */
const UPSTREAM_SNIPPET_CAP = 2000;
/** Raised listener ceiling to avoid false-positive AbortSignal warnings from SDK internals. */
const ABORT_SIGNAL_LISTENER_LIMIT = 100;

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof TimeoutError;
}

interface StreamWaitTimeoutMessageOptions {
  taskId: string;
  timeoutMs: number;
  streamIdleTimeoutMs: number;
}

function streamWaitTimeoutMessage({
  taskId,
  timeoutMs,
  streamIdleTimeoutMs,
}: StreamWaitTimeoutMessageOptions): string {
  const effectiveTimeout = formatMs(timeoutMs);
  if (timeoutMs < streamIdleTimeoutMs) {
    return `Task ${taskId} produced no stream events within ${effectiveTimeout} before the task deadline (configured stream idle timeout: ${formatMs(streamIdleTimeoutMs)})`;
  }
  return `Task ${taskId} produced no stream events within ${effectiveTimeout}`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function bestEffortCancel(
  run: { cancel?: () => Promise<void> | void },
  taskId: string,
): Promise<void> {
  if (typeof run.cancel !== "function") return;
  try {
    await run.cancel();
  } catch (cancelErr) {
    const msg = cancelErr instanceof Error ? cancelErr.message : String(cancelErr);
    console.error(`[dag-runner] failed to cancel timed-out task ${taskId}: ${msg}`);
  }
}

class BoundedTextBuffer {
  private data = "";
  private droppedChars = 0;

  constructor(private readonly cap: number) {}

  append(chunk: string): void {
    if (!chunk) return;
    this.data += chunk;
    if (this.data.length <= this.cap) return;
    const overflow = this.data.length - this.cap;
    this.droppedChars += overflow;
    this.data = this.data.slice(overflow);
  }

  render(): string {
    if (this.droppedChars === 0) return this.data;
    return `[...truncated ${this.droppedChars} earlier chars...]\n${this.data}`;
  }
}

function skipTask(
  task: RawTask,
  stateById: Map<string, TaskState>,
  state: RunState,
  writer: CanvasWriter,
  failedDeps: string[],
): void {
  const ts = stateById.get(task.id)!;
  const now = Date.now();
  ts.status = "ERROR";
  ts.finishedAt = now;
  ts.durationMs = 0;
  ts.errorMessage = `Skipped: upstream task(s) ${failedDeps.join(", ")} failed`;
  console.log(`[dag-runner] skipping ${task.id} — upstream ${failedDeps.join(", ")} failed`);
  writer.schedule(structuredCloneState(state));
}

async function markRunTerminated(
  state: RunState,
  message: string,
  outcome: "FAILED" | "INTERRUPTED",
): Promise<void> {
  const now = Date.now();
  state.runOutcome = outcome;
  state.runMessage = message;
  state.finishedAt = now;
  for (const task of state.tasks) {
    if (task.status === "FINISHED" || task.status === "ERROR") continue;
    task.status = "ERROR";
    task.errorMessage = outcome === "INTERRUPTED" ? "Runner interrupted" : "Runner terminated";
    task.finishedAt = now;
    if (task.startedAt !== undefined) {
      task.durationMs = now - task.startedAt;
    } else {
      task.durationMs = 0;
    }
  }
}

function buildUpstreamContext(
  task: RawTask,
  stateById: Map<string, TaskState>,
): string {
  if (task.depends_on.length === 0) return "";
  const lines: string[] = ["Upstream task results (for context — do not re-do this work):", ""];
  for (const depId of task.depends_on) {
    const dep = stateById.get(depId);
    if (!dep) continue;
    const status = dep.status;
    const snippet = dep.resultText
      ? truncate(dep.resultText, UPSTREAM_SNIPPET_CAP)
      : dep.errorMessage
        ? `(failed: ${dep.errorMessage})`
        : "(no output)";
    lines.push(`### ${depId} [${status}]`);
    lines.push(snippet);
    lines.push("");
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

/** Defensive deep clone — defends against mid-write mutation in the writer queue. */
function structuredCloneState(state: RunState): RunState {
  return JSON.parse(JSON.stringify(state)) as RunState;
}

main().catch((err) => {
  console.error(`[dag-runner] fatal: ${err instanceof Error ? err.stack ?? err.message : err}`);
  process.exit(1);
});
