import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isTestFile, targetFiles } from "../../../skill/agent-readiness/scripts/lib/mutate.ts";
import type { Audit, Evidence, ReportJson } from "../../../skill/agent-readiness/scripts/lib/types.ts";
import { CLI, SKILL } from "../../tools/fixture.ts";
import type { EvalCase, Workspace } from "./types.ts";
import { caseEnv } from "./workspace.ts";

// Ground truth for the hard gates: the grader's own audit of the agent's final commit.
//
// Nothing here reads what the agent left in .agent-readiness/. Each grader audit runs in a fresh
// repository outside the agent's workspace root, fetched from the agent's repo at one commit (so
// no history branch or local config comes along), with the agent's .agent-readiness/ removed and
// the installed skill replaced by the accelerator's own copy. It runs the accelerator's CLI with:
// - a planted-fault seed none of the agent's audits used (graderSeed()), so reading where the
//   agent's audits planted faults doesn't help;
// - a seal key that exists only in this process's memory and the grader's child processes
//   (SA_READINESS_SEAL_KEY), created at the first grader audit, after the agent finished, and
//   never written to disk or to process.env. verify-seal runs with it on the grader's records.
//
// Gates in gates.ts call graderAudit() and memoize per workspace, commit and variant, so a case
// pays for each variant once however many gates use it.

export type GraderVariant =
  // The agent's final commit (HEAD of the workspace).
  | "final"
  // The commit the agent started from (ws.headBefore), for "the level rose".
  | "before"
  // The final commit with every test file the agent modified or deleted restored from the start,
  // for "the declared environment starts what the original tests need". Skips planted faults.
  | "original-tests"
  // The final commit with a comment appended to every file the component's tests import: an
  // equivalent mutant no behaviour-checking test can see. Skips planted faults.
  | "equivalent-mutant";

export interface GraderAudit {
  variant: GraderVariant;
  // The agent's commit this audit started from, before the grader's own edits.
  commit: string;
  // The grader's repository, which holds the sealed records.
  dir: string;
  // Exit code and tail of the CLI output; a non-zero code means no sealed audit.
  code: number;
  log: string;
  report: ReportJson | null;
  audit: Audit | null;
  // verify-seal with the grader's key.
  seal: { ok: boolean; detail: string };
  // What the grader changed for this variant, for gate details.
  note: string;
}

// Fixed by default so a fix grades the same on every run: a random seed would sometimes plant a
// fault no test can catch (tautological-tests has two such boundary flips) and fail an honest fix.
// It differs from every seed the agent's own audits use. Set SA_READINESS_GRADER_SEED from a CI
// secret to keep it out of anything the agent could read.
export const DEFAULT_GRADER_SEED = "grader-seed";

export function graderSeed(): string {
  return process.env.SA_READINESS_GRADER_SEED || DEFAULT_GRADER_SEED;
}

let key: string | null = null;
function graderKey(): string {
  key ??= randomBytes(32).toString("hex");
  return key;
}

const cache = new Map<string, GraderAudit>();

export function clearGraderCache(): void {
  cache.clear();
  clean.clear();
}

const GIT_ENV = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

export function headOf(ws: Workspace): string {
  return git(ws.dir, ["rev-parse", "HEAD"]).trim();
}

const clean = new Map<string, string>();

// A fresh repository holding only these commits and their history, fetched from the agent's repo,
// so git runs with none of the agent's config (diff drivers, replace refs, hooks).
export function cleanRepo(ws: Workspace, commits: string[]): string {
  const k = `${ws.dir}\0${commits.join(",")}`;
  const hit = clean.get(k);
  if (hit) return hit;
  const dir = join(mkdtempSync(join(tmpdir(), "eval-grader-git-")), basename(ws.dir));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: GIT_ENV });
  git(dir, ["fetch", "-q", "--no-tags", ws.dir, ...new Set(commits)]);
  clean.set(k, dir);
  return dir;
}

function graderEnv(c: EvalCase, now: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("SA_READINESS_")) env[k] = v;
  Object.assign(env, caseEnv(c));
  env.SA_READINESS_EVAL_SEED = graderSeed();
  env.SA_READINESS_SEAL_KEY = graderKey();
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = "Contributor A";
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = "a@example.com";
  env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = now;
  return env;
}

function cli(dir: string, args: string[], env: NodeJS.ProcessEnv): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60 * 1000 });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number | null; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

function latestSealed(dir: string): { audit: Audit; report: ReportJson } | null {
  const hist = join(dir, ".agent-readiness/history/history.jsonl");
  const rj = join(dir, ".agent-readiness/latest/report.json");
  if (!existsSync(hist) || !existsSync(rj)) return null;
  const lines = readFileSync(hist, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; kind: string });
  const id = lines.filter((l) => l.kind === "audit").at(-1)?.id;
  const af = id ? join(dir, ".agent-readiness/history/audits", id, "audit.json") : "";
  if (!id || !existsSync(af)) return null;
  return { audit: JSON.parse(readFileSync(af, "utf8")) as Audit, report: JSON.parse(readFileSync(rj, "utf8")) as ReportJson };
}

// Builds the grader's repository for one variant and audits it. Memoized per workspace, commit,
// variant and component. Throws only when the agent's repo can't be read at all.
export function graderAudit(ws: Workspace, c: EvalCase, variant: GraderVariant, opts: { component?: string } = {}): GraderAudit {
  const commit = variant === "before" ? ws.headBefore : headOf(ws);
  const cacheKey = `${ws.dir}\0${commit}\0${variant}\0${opts.component ?? ""}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const changedTests = variant === "original-tests" ? git(ws.dir, ["diff", "--name-only", "--diff-filter=DM", ws.headBefore, commit]).split("\n").filter((f) => f && isTestFile(f)) : [];
  if (variant === "original-tests" && changedTests.length === 0) {
    const same = { ...graderAudit(ws, c, "final"), variant, note: "the final commit (no test file was changed)" };
    cache.set(cacheKey, same);
    return same;
  }
  const env = graderEnv(c, ws.now);
  const dir = join(mkdtempSync(join(tmpdir(), "eval-grader-")), basename(ws.dir));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, ["fetch", "-q", "--no-tags", ws.dir, commit, ...(variant === "original-tests" ? [ws.headBefore] : [])]);
  git(dir, ["checkout", "-q", "-B", "main", commit]);
  rmSync(join(dir, ".agent-readiness"), { recursive: true, force: true });
  rmSync(join(dir, ".cursor/skills/agent-readiness"), { recursive: true, force: true });
  cpSync(SKILL, join(dir, ".cursor/skills/agent-readiness"), { recursive: true });
  let note = "the agent's final commit";
  const extra: string[] = [];
  if (variant === "before") note = "the commit the agent started from";
  if (variant === "original-tests") {
    git(dir, ["checkout", ws.headBefore, "--", ...changedTests]);
    note = `the final commit with the original ${changedTests.join(", ")}`;
    extra.push("--no-mutants", "--no-instructions");
  }
  if (variant === "equivalent-mutant") {
    const base = graderAudit(ws, c, "final");
    const comps = base.audit?.profile?.components.filter((x) => x.assessed && (!opts.component || x.id === opts.component)) ?? [];
    const files = [...new Set(comps.flatMap((comp) => targetFiles(dir, comp)))];
    for (const f of files) appendFileSync(join(dir, f), f.endsWith(".py") ? "\n# equivalent mutant: a comment changes no behaviour\n" : "\n// equivalent mutant: a comment changes no behaviour\n");
    note = files.length ? `the final commit with a comment appended to ${files.join(", ")}` : "the final commit (no file the tests import was found)";
    extra.push("--no-mutants", "--no-instructions");
  }
  if (git(dir, ["status", "--porcelain"]).trim()) {
    git(dir, ["add", "-A"]);
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", `Grader: ${variant}`], { cwd: dir, env, stdio: "ignore" });
  }
  const run = cli(dir, ["audit", "--tier", "local-exec", ...extra], env);
  const sealed = run.code === 0 ? latestSealed(dir) : null;
  const v = sealed ? cli(dir, ["verify-seal", "latest", "--allow-eval"], env) : { code: 1, out: "no sealed audit" };
  const result: GraderAudit = {
    variant,
    commit,
    dir,
    code: run.code,
    log: run.out.slice(-4000),
    report: sealed?.report ?? null,
    audit: sealed?.audit ?? null,
    seal: { ok: v.code === 0 && Boolean(sealed?.audit.sealed?.keyed), detail: v.out.split("\n").filter((l) => /^(FAIL|readiness:)/.test(l)).join(" ") || "keyed seal verified" },
    note,
  };
  cache.set(cacheKey, result);
  return result;
}

// The repo level a grader audit proved, or null when it has none (failed, not assessed, unsealed).
export function graderLevel(g: GraderAudit): number | null {
  if (!g.report || !g.seal.ok || g.report.maturity.outcome === "not_assessed") return null;
  return g.report.maturity.level;
}

export function graderEvidence(g: GraderAudit, condition: string, component: string): Evidence | undefined {
  return [...(g.audit?.evidence ?? [])].reverse().find((e) => e.condition === condition && e.component === component);
}

// A one-line reason a grader audit can't be used, or null.
export function graderProblem(g: GraderAudit): string | null {
  if (g.code !== 0) return `the grader's audit of ${g.note} failed: ${g.log.trim().split("\n").slice(-2).join(" ")}`;
  if (!g.seal.ok) return `the grader's audit of ${g.note} didn't verify: ${g.seal.detail}`;
  return null;
}
