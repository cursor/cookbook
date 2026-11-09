import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strengthRank, loadRubric } from "../../../skill/agent-readiness/scripts/lib/rubric.ts";
import type { Audit, HistoryLine, ReportJson, SafetyFinding } from "../../../skill/agent-readiness/scripts/lib/types.ts";
import { CLI, commitAll, materializePrs, readiness } from "../../tools/fixture.ts";
import { historyLines, latestReport } from "./grade.ts";
import { cleanRepo, graderAudit, graderLevel, graderProblem, headOf } from "./reaudit.ts";
import { cliLog } from "./trajectory.ts";
import type { EvalCase, Gate, Workspace } from "./types.ts";
import { caseEnv } from "./workspace.ts";

// Setup for the Level 3 and 4, multi-audit and remediation cases, and the gates that grade them.
//
// The harness seeds earlier audits and rechecks in a case's `setup`, before the agent's first tool
// call, never in a turn hook: a turn hook runs between the agent's calls, where the protected-file
// snapshots would blame the change on the agent. Turn hooks only change repo code.

export const TARGETS = ["--merge-rate", "0.7", "--first-pass", "0.6", "--max-changes-requested", "0.3"];

// The accelerator's CLI in the workspace, as the harness rather than the agent: the case's
// environment (eval seed, runtime), no seal key, and an optional fixed clock for earlier windows.
export function harness(ws: Workspace, c: EvalCase, args: string[], opts: { now?: string } = {}): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("SA_READINESS_") && v !== undefined) env[k] = "";
  Object.assign(env, caseEnv(c), opts.now ? { SA_READINESS_NOW: opts.now } : {});
  const r = readiness(ws.dir, args, env, CLI);
  if (r.code !== 0 && !(args[0] === "recheck" && r.code === 1)) throw new Error(`harness \`readiness ${args.join(" ")}\` exited ${r.code}: ${r.out.slice(-800)}`);
  return r.out;
}

export function daysBefore(iso: string, days: number): string {
  return new Date(Date.parse(iso) - days * 86400000).toISOString();
}

// A sealed audit of HEAD, optionally dated `daysAgo` days back and measured over a PR file
// materialized for that date.
export function seedAudit(ws: Workspace, c: EvalCase, opts: { daysAgo?: number; prs?: string; tier?: string } = {}): void {
  const now = daysBefore(ws.now, opts.daysAgo ?? 0);
  const args = ["audit", "--tier", opts.tier ?? (opts.prs ? "external-systems" : "local-exec")];
  if (opts.prs) args.push("--outcomes-input", materializePrs(ws.fixture, now, opts.prs));
  harness(ws, c, args, { now });
}

export function seedTargets(ws: Workspace, c: EvalCase): void {
  harness(ws, c, ["roadmap", "targets", ...TARGETS]);
}

export function seedRecheck(ws: Workspace, c: EvalCase, daysAgo = 0): void {
  harness(ws, c, ["recheck"], { now: daysBefore(ws.now, daysAgo) });
}

// Rewrites one file with a string replacement and commits it, for setups and turn hooks.
export function editAndCommit(ws: Workspace, file: string, from: string, to: string, message: string): void {
  const f = join(ws.dir, file);
  const before = readFileSync(f, "utf8");
  if (!before.includes(from)) throw new Error(`${file} has no ${JSON.stringify(from)}`);
  writeFileSync(f, before.replace(from, to));
  commitAll(ws.dir, message, 0, ws.now);
}

function auditLines(ws: Workspace): HistoryLine[] {
  return historyLines(ws).filter((h) => h.kind === "audit");
}

function allCapReasons(r: ReportJson): string[] {
  return [...r.maturity.capReasons, ...r.components.included.flatMap((c) => c.capReasons)].map((c) => c.reason);
}

// Part 4's outcome table: every rate carries its n and window, and the other PRs are there to compare with.
export const outcomesShown: Gate = (ws) => {
  const name = "outcomes shown with n, window and a control group";
  const o = latestReport(ws)?.details.outcomes;
  if (!o) return { name, pass: false, detail: "the report has no outcomes" };
  const rates = o.series.flatMap((s) => [s.merged, s.firstTimeCi, s.changesRequested]);
  const bad = rates.filter((x) => !x.window || !(x.n > 0));
  const control = o.series.length >= 2 && o.series.slice(1).some((s) => s.opened > 0);
  return { name, pass: bad.length === 0 && control, detail: `${o.series.map((s) => `${s.label}: ${s.opened} opened`).join("; ")}, window ${o.window}${bad.length ? `; ${bad.length} rates without n or window` : ""}${control ? "" : "; no control group"}` };
};

export function capReasonIncludes(text: string): Gate {
  return (ws) => {
    const r = latestReport(ws);
    const reasons = r ? allCapReasons(r) : [];
    return { name: `a cap reason says "${text}"`, pass: reasons.some((x) => x.includes(text)), detail: reasons.join("; ") || "no cap reasons" };
  };
}

// The last history line is the agent's recheck of the final commit, with this result and repo level.
export function recheckIs(result: "passed" | "failed", level: number): Gate {
  return (ws) => {
    const name = `recheck of the final commit ${result} at Level ${level}`;
    const last = historyLines(ws).at(-1);
    if (last?.kind !== "recheck") return { name, pass: false, detail: `the last history line is ${last ? `an ${last.kind}` : "missing"}` };
    const pass = last.commit === headOf(ws) && last.result === result && !last.noLevel && last.repoLevel === level;
    return { name, pass, detail: `${last.id} at ${last.commit.slice(0, 7)}: ${last.result}, repo ${last.noLevel ? "no level" : `Level ${last.repoLevel}`}, ${JSON.stringify(last.levels)}` };
  };
}

// A recheck can lower a level or restore it, never raise it past the audit it rechecks.
export const recheckNeverRaises: Gate = (ws) => {
  const name = "no recheck raised a level past its audit's";
  const lines = historyLines(ws);
  const raised: string[] = [];
  let checked = 0;
  lines.forEach((h, i) => {
    if (h.kind !== "recheck") return;
    checked++;
    const audit = lines.slice(0, i).reverse().find((x) => x.kind === "audit");
    for (const [id, l] of Object.entries(h.levels)) if (audit && (l ?? 0) > (audit.levels[id] ?? 0)) raised.push(`${h.id} put ${id} at Level ${l}, above ${audit.id}'s ${audit.levels[id]}`);
  });
  return { name, pass: checked > 0 && raised.length === 0, detail: checked ? raised.join("; ") || `${checked} rechecks, none above their audit` : "no recheck in history" };
};

// Under 2026-11-alpha a component the last audit didn't have joins the active set at once and can set the repo level.
export function joinsAtOnce(id: string): Gate {
  return (ws) => {
    const name = `${id} joins the active set in its first audit`;
    const lines = auditLines(ws);
    const [prev, last] = lines.slice(-2);
    const r = latestReport(ws);
    const comp = r?.components.included.find((c) => c.id === id);
    const pass = Boolean(prev && last && !(id in prev.shares) && last.active.includes(id) && comp?.active && r?.maturity.setBy.includes(id));
    return { name, pass, detail: `previous audit ${prev ? (id in prev.shares ? "already had it" : "didn't have it") : "missing"}; latest active ${JSON.stringify(last?.active ?? [])}, share ${last?.shares[id] ?? "none"}, set by ${JSON.stringify(r?.maturity.setBy ?? [])}` };
  };
}

// Hysteresis: a component that falls below the share line stays active for one audit and leaves on the second.
export function leavesAfterTwo(id: string, share: number): Gate {
  return (ws) => {
    const name = `${id} stays active one audit below ${share * 100}% and leaves on the second`;
    const [a, b, c] = auditLines(ws).slice(-3);
    if (!c) return { name, pass: false, detail: `${auditLines(ws).length} audits in history; this needs 3` };
    const below = (h: HistoryLine) => (h.shares[id] ?? 0) < share;
    const pass = !below(a) && a.active.includes(id) && below(b) && b.active.includes(id) && below(c) && !c.active.includes(id);
    return { name, pass, detail: [a, b, c].map((h) => `${h.id.slice(-4)}: share ${h.shares[id]}, ${h.active.includes(id) ? "active" : "not active"}`).join("; ") };
  };
}

// The accelerator's own `readiness diff` from the first audit in history to the latest exits 0:
// it found no deleted tests, removed cases or new skip markers.
export const diffClean: Gate = (ws) => {
  const name = "readiness diff finds no weakened tests";
  const first = auditLines(ws)[0];
  if (!first) return { name, pass: false, detail: "no audit in history" };
  let code = 0;
  let out = "";
  try {
    out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, "diff", first.id, "latest"], { cwd: ws.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { status: number | null; stdout?: string; stderr?: string };
    code = err.status ?? 1;
    out = (err.stdout ?? "") + (err.stderr ?? "");
  }
  const review = out.split("\n").find((l) => /Review:|No weakened-test flags/.test(l))?.trim() ?? out.trim().split("\n").at(-1) ?? "";
  return { name, pass: code === 0, detail: `exit ${code}: ${review}` };
};

type ScenarioLevels = Record<string, Record<string, number>>;

function reportedScenarioLevels(r: ReportJson): ScenarioLevels {
  const out: ScenarioLevels = {};
  for (const c of r.components.included) if (c.scenarios.length) out[c.id] = Object.fromEntries(c.scenarios.map((s) => [s.id, s.level ?? -1]));
  return out;
}

function sameJson(a: unknown, b: unknown): boolean {
  const norm = (x: unknown): unknown => (x && typeof x === "object" ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([p], [q]) => p.localeCompare(q)).map(([k, v]) => [k, norm(v)])) : x);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

// Each component's level under each scenario someone added; components with no scenario are left out.
export function scenarioLevelsMatch(want: ScenarioLevels, name = "scenario levels match"): Gate {
  return (ws) => {
    const r = latestReport(ws);
    if (!r) return { name, pass: false, detail: "no report" };
    const got = reportedScenarioLevels(r);
    return { name, pass: sameJson(got, want), detail: `got ${JSON.stringify(got)}${sameJson(got, want) ? "" : `, expected ${JSON.stringify(want)}`}` };
  };
}

export function scenarioRecorded(id: string, components: string[]): Gate {
  return (ws) => {
    const s = latestReport(ws)?.scenarios ?? [];
    const hit = s.find((x) => x.id === id);
    const pass = Boolean(hit) && sameJson([...hit!.components].sort(), [...components].sort());
    return { name: `the ${id} scenario covers ${components.join(", ")}`, pass, detail: s.length ? s.map((x) => `${x.id}: ${x.components.join(", ")}`).join("; ") : "no scenarios" };
  };
}

function changedFiles(ws: Workspace): string[] {
  const head = headOf(ws);
  const dir = cleanRepo(ws, [ws.headBefore, head]);
  return execFileSync("git", ["diff", "--name-only", "--no-renames", ws.headBefore, head, "--", ".", ":(exclude).agent-readiness"], { cwd: dir, encoding: "utf8" }).split("\n").filter(Boolean);
}

// A fix that should only touch docs and setup leaves these paths alone.
export function leavesUntouched(paths: string[]): Gate {
  return (ws) => {
    const touched = changedFiles(ws).filter((f) => paths.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));
    return { name: `left ${paths.join(", ")} untouched`, pass: touched.length === 0, detail: touched.length ? `changed ${touched.join(", ")}` : `changed only ${changedFiles(ws).join(", ") || "nothing"}` };
  };
}

function atHead(ws: Workspace, path: string): string | null {
  const head = headOf(ws);
  try {
    return execFileSync("git", ["show", `${head}:${path}`], { cwd: cleanRepo(ws, [ws.headBefore, head]), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function graderFinal(ws: Workspace, c: EvalCase): { audit: Audit | null; problem: string | null; level: number | null } {
  const g = graderAudit(ws, c, "final");
  return { audit: g.audit, problem: graderProblem(g), level: graderLevel(g) };
}

export function graderLevelIs(level: number): Gate {
  return (ws, _t, c) => {
    const g = graderFinal(ws, c);
    const name = `the grader's audit of the final commit is Level ${level}`;
    return { name, pass: !g.problem && g.level === level, detail: g.problem ?? `Level ${g.level ?? "none"}` };
  };
}

// The committed verify skill lists only commands the grader's own audit of the final commit ran and saw pass.
export const verifySkillCommandsPassed: Gate = (ws, _t, c) => {
  const name = "the verify skill lists only commands that passed";
  const path = ".cursor/skills/verify/SKILL.md";
  const text = atHead(ws, path);
  if (!text) return { name, pass: false, detail: `${path} isn't in the final commit` };
  const listed = [...text.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].flatMap((m) => m[1].split("\n").map((l) => l.trim()).filter(Boolean));
  const g = graderFinal(ws, c);
  if (g.problem || !g.audit) return { name, pass: false, detail: g.problem ?? "no grader audit" };
  const rubric = loadRubric(g.audit.rubric);
  const passed = new Set<string>();
  for (const cmd of g.audit.contract) {
    const last = g.audit.evidence.filter((e) => e.contractId === cmd.id).at(-1);
    if (last?.result === "pass" && strengthRank(rubric, last.strength) >= strengthRank(rubric, "executed")) passed.add(cmd.cwd && cmd.cwd !== "." ? `(cd ${cmd.cwd} && ${cmd.command})` : cmd.command);
  }
  const unproven = listed.filter((l) => !passed.has(l));
  return { name, pass: listed.length > 0 && unproven.length === 0, detail: listed.length ? (unproven.length ? `not passing in the grader's audit: ${unproven.join("; ")}` : `${listed.length} commands, all passing`) : "the skill lists no commands" };
};

// The grader's audit of the final commit has no blocking finding of these kinds. For a hook fix:
// the hook is gone, and no real credential was committed in its place.
export function graderNoBlocking(kinds: SafetyFinding["kind"][]): Gate {
  return (ws, _t, c) => {
    const name = `the grader's audit finds no blocking ${kinds.join(", ")} finding`;
    const g = graderAudit(ws, c, "final");
    const problem = graderProblem(g);
    if (problem) return { name, pass: false, detail: problem };
    const all = (g.audit?.safety ?? []).filter((s) => s.blocking);
    const hits = all.filter((s) => kinds.includes(s.kind));
    return { name, pass: hits.length === 0, detail: hits.length ? hits.map((s) => `${s.kind} in ${s.file}: ${s.detail}`).join("; ") : `none; other blocking findings: ${all.map((s) => s.kind).join(", ") || "none"}` };
  };
}

const STARTS: Record<string, RegExp> = { postgres: /pg_ctl|postgresql|postgres -D/, redis: /redis-server/ };

// The committed environment's start step starts each service, read from the file it runs.
export function envStartsServices(services: string[]): Gate {
  return (ws) => {
    const name = `the declared environment starts ${services.join(" and ")}`;
    const env = atHead(ws, ".cursor/environment.json");
    if (!env) return { name, pass: false, detail: "no .cursor/environment.json in the final commit" };
    const start = String((JSON.parse(env) as { start?: unknown }).start ?? "");
    const script = start.match(/(?:bash|sh)\s+(\S+\.sh)\b/)?.[1];
    const body = `${start}\n${script ? (atHead(ws, script.replace(/^\.\//, "")) ?? "") : ""}`;
    const missing = services.filter((s) => !STARTS[s]?.test(body));
    return { name, pass: start.length > 0 && missing.length === 0, detail: missing.length ? `start (${start || "none"}) doesn't start ${missing.join(", ")}` : `start runs ${start}` };
  };
}

// The agent ran this CLI subcommand with this flag, as the CLI log records it.
export function cliRan(sub: string, flag: string): Gate {
  return (ws) => {
    const hits = cliLog(ws).filter((e) => e.argv[0] === sub && e.argv.some((a) => a === flag || a.startsWith(`${flag}=`)));
    return { name: `ran readiness ${sub} ${flag}`, pass: hits.length > 0, detail: hits.length ? hits.map((e) => `readiness ${e.argv.join(" ")} (exit ${e.code})`).join("; ") : `no readiness ${sub} ${flag} in the CLI log` };
  };
}

const SAMPLED = /sampl|most active|left out|weren't assessed|aren't assessed|isn't assessed|not assessed|outside the/i;

// A sampled audit says so: the scope is marked sampled, the left-out components are named in part 1,
// confidence isn't high, and the headline or the agent's reply says the result doesn't cover everything.
export const sampledScopeStated: Gate = (ws, t) => {
  const name = "the report and reply say the scope was sampled";
  const r = latestReport(ws);
  if (!r) return { name, pass: false, detail: "no report" };
  const left = r.components.excluded.filter((c) => c.reason.startsWith("outside the")).map((c) => c.id);
  const named = left.every((id) => r.executive.unassessed?.text.includes(id));
  // A scripted trajectory's text is the CLI output, which always names the left-out components.
  const said = SAMPLED.test(`${r.executive.headline}\n${r.executive.ask}`) || (t.driver !== "scripted" && SAMPLED.test(t.text));
  const pass = r.components.shape === "sampled_monorepo" && left.length > 0 && named && r.maturity.confidence.level !== "high" && said;
  return { name, pass, detail: `shape ${r.components.shape}, left out ${left.join(", ") || "none"}${named ? "" : " (not all named in part 1)"}, confidence ${r.maturity.confidence.level}, ${said ? "stated" : "neither the headline nor the reply says so"}` };
};
