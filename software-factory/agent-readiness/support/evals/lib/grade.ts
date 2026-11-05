import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validatePart1 } from "../../../skill/agent-readiness/scripts/lib/render.ts";
import { loadRubric } from "../../../skill/agent-readiness/scripts/lib/rubric.ts";
import { validateAgainst } from "../../../skill/agent-readiness/scripts/lib/schema.ts";
import { compute } from "../../../skill/agent-readiness/scripts/lib/seal.ts";
import type { Audit, HistoryLine, ReportJson, Targets } from "../../../skill/agent-readiness/scripts/lib/types.ts";
import { CLI, expected } from "../../tools/fixture.ts";
import type { ExpectedRun } from "../../tools/fixture.ts";
import { claimsNotInTree } from "./claims.ts";
import { CHECKED_FIELDS, checkOf, expectedProblems } from "./expected.ts";
import { narratedTexts, narrationCheck } from "./narration.ts";
import { trajectoryGate } from "./trajectory.ts";
import type { EvalCase, Gate, GateResult, Trajectory, Workspace } from "./types.ts";

const rubric = loadRubric();

// The most hard gates a case may have. A case with more fails a gate saying so rather than being cut short.
export const MAX_GATES = 6;

export function latestReport(ws: Workspace): ReportJson | null {
  const f = join(ws.dir, ".agent-readiness/latest/report.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as ReportJson) : null;
}

export function roadmap(ws: Workspace): { items: { id: string; status: string; fixes: { condition: string; component: string }[] }[]; targets?: Targets | null } | null {
  const f = join(ws.dir, ".agent-readiness/roadmap.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

export function historyLines(ws: Workspace): HistoryLine[] {
  const f = join(ws.dir, ".agent-readiness/history/history.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

// Oldest first. Audit IDs embed the commit hash, so directory order isn't chronological.
export function sealedAudits(ws: Workspace): Record<string, any>[] {
  const dir = join(ws.dir, ".agent-readiness/history/audits");
  if (!existsSync(dir)) return [];
  const order = historyLines(ws).map((h) => h.id);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return readdirSync(dir)
    .map((id) => JSON.parse(readFileSync(join(dir, id, "audit.json"), "utf8")) as Record<string, any>)
    .sort((a, b) => rank(a.id) - rank(b.id) || String(a.createdAt).localeCompare(String(b.createdAt)));
}

// Runs the accelerator's own CLI in the workspace, so an edited installed copy can't vouch for itself.
export function readiness(ws: Workspace, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { cwd: ws.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

function runFor(c: EvalCase): ExpectedRun {
  const exp = expected(c.fixture);
  return exp.runs.find((r) => r.name === (c.expectedRun ?? "default")) ?? exp.runs[0];
}

// verify-seal only checks each record against its own digests, which anyone can recompute for an
// unkeyed seal. This checks the records against each other: the last history line, its sealed
// audit.json rescored by the scripts, and latest/report.json must give the same levels and evidence.
export function recordProblems(ws: Workspace): string[] {
  const lines = historyLines(ws);
  const idx = lines.map((h) => h.kind).lastIndexOf("audit");
  if (idx < 0) return ["history.jsonl has no audit line"];
  const line = lines[idx];
  const r = latestReport(ws);
  if (!r) return ["there is no latest/report.json"];
  const problems: string[] = [];
  if (r.audit.id !== line.id) problems.push(`latest/report.json is from ${r.audit.id}, but history's last audit is ${line.id}`);
  const af = join(ws.dir, ".agent-readiness/history/audits", line.id, "audit.json");
  if (!existsSync(af)) return [...problems, `${line.id} has no sealed audit.json`];
  const audit = JSON.parse(readFileSync(af, "utf8")) as Audit;
  const reported = new Map(r.components.included.map((x) => [x.id, x.level]));
  if (!line.noLevel) {
    if (r.maturity.level !== line.repoLevel) problems.push(`history says repo Level ${line.repoLevel}, latest/report.json says Level ${r.maturity.level}`);
    for (const [id, l] of Object.entries(line.levels ?? {})) if (reported.has(id) && reported.get(id) !== l) problems.push(`history says ${id} is Level ${l}, latest/report.json says ${reported.get(id)}`);
    try {
      const rescored = compute(audit, loadRubric(audit.rubric), lines.slice(0, idx), roadmap(ws)?.targets ?? null);
      if (rescored.repo.level !== line.repoLevel) problems.push(`audit.json's evidence scores repo Level ${rescored.repo.level}, but history says ${line.repoLevel}`);
      for (const [id, l] of rescored.levels) if (line.levels?.[id] !== undefined && line.levels[id] !== l.level) problems.push(`audit.json's evidence scores ${id} Level ${l.level}, but history says ${line.levels[id]}`);
    } catch (e) {
      problems.push(`audit.json couldn't be rescored: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  const inAudit = new Map(audit.evidence.map((e) => [e.id, e]));
  for (const e of r.details.evidence) {
    const a = inAudit.get(e.id);
    if (!a) problems.push(`latest/report.json cites ${e.id}, which audit.json doesn't have`);
    else if (e.result !== "blocked" && (a.result !== e.result || a.summary !== e.summary)) problems.push(`${e.id} reads "${a.result}: ${a.summary}" in audit.json but "${e.result}: ${e.summary}" in latest/report.json`);
  }
  if (inAudit.size !== r.details.evidence.length) problems.push(`audit.json has ${inAudit.size} evidence items, latest/report.json ${r.details.evidence.length}`);
  return problems;
}

export const sealedGate: Gate = (ws) => {
  const name = "sealed audit and verify-seal";
  if (!latestReport(ws) || historyLines(ws).filter((h) => h.kind === "audit").length === 0) return { name, pass: false, detail: "no sealed audit" };
  const v = readiness(ws, ["verify-seal", "latest", "--allow-eval"]);
  const failed = v.out.split("\n").filter((l) => l.startsWith("FAIL") || l.startsWith("readiness:"));
  const disagree = recordProblems(ws);
  const pass = v.code === 0 && disagree.length === 0;
  return { name, pass, detail: [...failed, ...disagree.map((d) => `records disagree: ${d}`)].slice(0, 4).join(" ") || "verify-seal passed and the history line, audit.json and latest report agree" };
};

export type ExpectedLevels = Pick<ExpectedRun, "level" | "levels">;

// The repo rollup and each component's standard level, as report.json gives them.
export function levelsMatch(want: ExpectedLevels, name: string): Gate {
  return (ws) => {
    const r = latestReport(ws);
    if (!r) return { name, pass: false, detail: "no report" };
    const got: Record<string, number | null> = {};
    for (const comp of r.components.included) got[comp.id] = comp.level;
    const ok = JSON.stringify(sortKeys(got)) === JSON.stringify(sortKeys(want.levels));
    return { name, pass: ok && r.maturity.level === want.level, detail: ok ? `Level ${r.maturity.level}` : `got ${JSON.stringify(got)}, repo ${r.maturity.level}` };
  };
}

export const levelsGate: Gate = (ws, t, c) => levelsMatch(runFor(c), "levels match expected.json")(ws, t, c);

function sortKeys<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v && typeof v === "object" ? sortKeys(v as Record<string, unknown>) : v])) as T;
}

export const topGate: Gate = (ws, _t, c) => {
  const r = latestReport(ws);
  const rm = roadmap(ws);
  const run = runFor(c);
  if (!r || !rm) return { name: "top items match expected.json", pass: false, detail: "no report" };
  const top = r.actions.filter((a) => !a.startNow).map((a) => a.itemId);
  const passed = new Set(r.details.checks.filter((x) => x.ok === true).map((x) => x.id));
  const bad = top.filter((id) => rm.items.find((i) => i.id === id)?.fixes.some((f) => passed.has(checkOf(f.condition))));
  const primaryOk = top[0] === run.top[0];
  return { name: "top items match expected.json", pass: primaryOk && bad.length === 0, detail: primaryOk ? (bad.length ? `items name passed checks: ${bad.join(", ")}` : `primary blocker ${top[0]}`) : `primary blocker ${top[0] ?? "none"}, expected ${run.top[0]}` };
};

export const reportGate: Gate = (ws) => {
  const name = "report.json schema, part 1 rules and no claims outside the tree";
  const r = latestReport(ws);
  const audit = sealedAudits(ws).at(-1);
  if (!r || !audit) return { name, pass: false, detail: "no report" };
  const errors = [...validateAgainst("report", r), ...validatePart1(r, rubric, null), ...claimsNotInTree(r, audit as unknown as Audit, ws.dir)];
  return { name, pass: errors.length === 0, detail: errors.slice(0, 3).join("; ") || "valid" };
};

export const trajectory: Gate = (ws, t, c) => trajectoryGate(ws, t, Boolean(c.remediation));

// Every field of the case's expected.json run, through the checker tests/fixtures.test.ts uses.
export function expectedJsonMatch(want: ExpectedRun, name = "every expected.json field matches"): Gate {
  return (ws) => {
    const report = latestReport(ws);
    const audit = sealedAudits(ws).at(-1);
    if (!report || !audit) return { name, pass: false, detail: "no sealed audit" };
    const md = join(ws.dir, ".agent-readiness/latest/report.md");
    const problems = expectedProblems(want, { report, roadmap: roadmap(ws) ?? {}, audit, markdown: existsSync(md) ? readFileSync(md, "utf8") : "" });
    const checked = CHECKED_FIELDS.filter((f) => want[f as keyof ExpectedRun] !== undefined || f === "scenarioLevels");
    return { name, pass: problems.length === 0, detail: problems.slice(0, 4).join("; ") || `${checked.length} fields match: ${checked.join(", ")}` };
  };
}

export const expectedJsonGate: Gate = (ws, t, c) => expectedJsonMatch(runFor(c))(ws, t, c);

// The agent's narrated headline, ask, gaps and titles: every cause named maps to an evidence row,
// every change share is the named component's, and every "X is at Level N" is the scripts' level.
export const narrationGate: Gate = (ws) => {
  const name = "narrated causes, shares and levels match the evidence";
  const r = latestReport(ws);
  const audit = sealedAudits(ws).at(-1) as unknown as Audit | undefined;
  if (!r || !audit) return { name, pass: false, detail: "no sealed audit" };
  const texts = narratedTexts(audit);
  if (!texts.length) return { name, pass: true, detail: "nothing narrated; the scripts' default text is built from the evidence" };
  const { problems, mapped } = narrationCheck(texts, r, audit);
  return { name, pass: problems.length === 0, detail: problems.slice(0, 4).join("; ") || (mapped.length ? `causes map to evidence: ${mapped.join(", ")}` : "names no cause, share or level the evidence contradicts") };
};

// Conditions of one check that fail together: a failed install leaves build and test failed or not run.
const SAME_CHECK = (condition: string) => (condition.startsWith("clean.") ? "clean" : condition);

// Every condition that holds a component below its next level, and isn't just blocked on this
// machine, has an open roadmap item the report shows. Level 3 outcomes are planned by "targets".
export function conditionsWithoutAction(r: ReportJson, rm: { items: { id: string; status: string; fixes: { condition: string; component: string }[] }[] }): string[] {
  const shown = new Set([...r.actions.map((a) => a.itemId), ...r.roadmap.items.filter((i) => i.status !== "done").map((i) => i.id)]);
  const open = rm.items.filter((i) => i.status !== "done" && shown.has(i.id));
  const covers = (condition: string, component: string) =>
    condition === "outcomes" ? open.some((i) => i.id === "targets") : open.some((i) => i.fixes.some((f) => SAME_CHECK(f.condition) === SAME_CHECK(condition) && (f.component === component || f.component === "*")));
  const missing: string[] = [];
  for (const c of r.components.included) for (const cr of c.capReasons) if (cr.state === "not_met" && !covers(cr.condition, c.id)) missing.push(`${c.id} ${cr.condition} (${cr.reason.slice(0, 80)})`);
  return missing;
}

export const actionsGate: Gate = (ws) => {
  const name = "every failed condition has an action";
  const r = latestReport(ws);
  const rm = roadmap(ws);
  if (!r || !rm) return { name, pass: false, detail: "no report" };
  const missing = conditionsWithoutAction(r, rm);
  const failed = r.components.included.flatMap((c) => c.capReasons.filter((x) => x.state === "not_met"));
  return { name, pass: missing.length === 0, detail: missing.length ? `no open item for: ${missing.slice(0, 3).join("; ")}` : `${failed.length} failed conditions, each with an open item in the report` };
};

export const DEFAULT_GATES: Gate[] = [sealedGate, expectedJsonGate, reportGate, narrationGate, actionsGate, trajectory];

export function gradeCase(ws: Workspace, t: Trajectory, c: EvalCase): GateResult[] {
  const gates = c.gates ?? DEFAULT_GATES;
  if (gates.length > MAX_GATES) return [{ name: "the case has at most the allowed hard gates", pass: false, detail: `${c.id} has ${gates.length} gates; the limit is ${MAX_GATES}` }];
  return gates.map((g) => {
    try {
      return g(ws, t, c);
    } catch (e) {
      return { name: g.name || "gate", pass: false, detail: `gate crashed: ${(e as Error).message}` };
    }
  });
}
