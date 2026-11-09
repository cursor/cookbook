import { writeFileSync } from "node:fs";
import { bootstrapDiff, bootstrapMean, kOfN, wilson } from "./stats.ts";
import type { MeanCi, Rate } from "./stats.ts";
import type { Arm, CaseRun } from "./types.ts";

// What produced a baseline. compare() refuses to read a run made with a different one as a trend.
export interface Instrument {
  driverModel: string;
  // Every judge model that scored a run, comma-joined; null when no judge ran.
  judgeModel: string | null;
  driver: string;
  rubric: string | null;
  // A digest of the judge prompts' code, so a prompt change can't pass as a score change.
  judgePrompt: string | null;
  // Which rules and skills the agent could load (isolation.ts); null for runs from before it was recorded.
  isolation: string | null;
}

export interface CaseSummary {
  runs: number;
  // Runs left after dropping those lost to infrastructure; the rates below count only these.
  usable: number;
  infraLost: number;
  gates: Record<string, string>;
  allGatesPass: string;
  judge: number | null;
  page: number | null;
  judgeNulls: number;
  pageNulls: number;
  // Of those, the runs whose judge call failed on infrastructure (a 502, a reset connection).
  // Absent in baselines recorded before it was kept.
  judgeInfra?: number;
  pageInfra?: number;
  holdout?: boolean;
  wallMs: number;
  toolCalls: number;
  tokens: number | null;
}

export interface Totals {
  cases: number;
  allGatesPass: string;
  // Every usable case-run, every gate passing.
  pooled: Rate;
  judge: MeanCi;
  page: MeanCi;
  judgeNulls: number;
  infraLost: number;
}

export interface RunRow {
  id: string;
  repeat: number;
  arm: Arm;
  gates: Record<string, boolean>;
  judge: number | null;
  page: number | null;
  judgeModel: string | null;
  infraLost: boolean;
  error: string | null;
}

export interface Lift {
  // Agent pass rate minus the control's, over every usable case-run.
  pooled: number | null;
  // Per-case mean differences, bootstrapped over cases both arms have.
  judge: MeanCi;
  page: MeanCi;
}

export interface Baseline {
  schema: "agent-readiness/eval-baseline@2";
  recordedAt: string;
  note?: string;
  arm: Arm;
  instrument: Instrument;
  repeats: number;
  cases: Record<string, CaseSummary>;
  // Over the cases that aren't held out; held-out cases are summed separately.
  totals: Totals;
  holdout: Totals | null;
  runs: RunRow[];
  controls?: Partial<Record<Arm, { totals: Totals; lift: Lift }>>;
}

// The pooled all-gates pass rate's 95% lower bound must reach this. With 25 cases × 3 runs, 72
// passes of 75 give 0.89 and 68 give 0.82.
export const POOLED_FLOOR = 0.8;
export const JUDGE_BAR = 0.8;

// The floor only binds a sample big enough to clear it with one failed run (25 runs or more for
// 0.8); a smoke run of 12 can't reach a 0.8 lower bound even when every run passes.
export function floorApplies(runs: number): boolean {
  return runs > 1 && (wilson(runs - 1, runs).lower ?? 0) >= POOLED_FLOOR;
}
// Hill-climb decisions compare two small samples; fewer runs per case than this can't separate a
// real change from a flake (see evals/METHOD.md).
export const HILL_CLIMB_MIN_REPEATS = 5;

// A worker that crashes or times out still leaves a failing run, so a missing repeat can't make a
// case look like it passed every gate.
export function crashedRun(c: { id: string }, repeat: number, model: string, why: string, arm: Arm = "agent"): CaseRun {
  return { id: c.id, repeat, model, driver: arm === "scripted" ? "scripted" : "sdk", arm, workspace: "", grade: { gates: [{ name: "the run finished", pass: false, detail: why }], soft: { judge: null, judgeReasons: [], page: null, pageReasons: [], wallMs: 0, toolCalls: 0, tokens: null } }, error: why };
}

// Errors that say nothing about the agent: the platform, network or worker failed. A turn the
// harness cancelled at its timeout is the agent's.
const INFRA = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network ?error|rate ?limit|\b429\b|\b50[0234]\b|capacity|overloaded|unavailable|resource.?exhausted|try again later|the worker exited|without a result/i;

export function isInfraError(error: string | null): boolean {
  return Boolean(error && !/ended cancelled/.test(error) && INFRA.test(error));
}

// A judge that gave no score because its call failed on infrastructure, not because of its reply.
export function judgeLost(reasons: string[] | undefined): boolean {
  const first = reasons?.[0] ?? "";
  return /^judge call failed/.test(first) && isInfraError(first);
}

function avg(xs: number[]): number | null {
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null;
}

const allPass = (r: CaseRun) => r.grade.gates.every((g) => g.pass);
const usable = (r: CaseRun) => !r.infra?.lost;
const joinSet = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))].sort().join(",") || null;

function byCase(runs: CaseRun[]): Map<string, CaseRun[]> {
  const m = new Map<string, CaseRun[]>();
  for (const r of runs) m.set(r.id, [...(m.get(r.id) ?? []), r]);
  return new Map([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function totalsOf(groups: Map<string, CaseRun[]>): Totals {
  const list = [...groups.values()];
  const runs = list.flat();
  const ok = runs.filter(usable);
  const scores = (k: "judge" | "page") => list.map((g) => g.filter(usable).map((r) => r.grade.soft[k]).filter((x): x is number => typeof x === "number"));
  const casesAllPass = list.filter((g) => g.filter(usable).length > 0 && g.filter(usable).every(allPass)).length;
  return {
    cases: list.length,
    allGatesPass: `${casesAllPass}/${list.length}`,
    pooled: wilson(ok.filter(allPass).length, ok.length),
    judge: bootstrapMean(scores("judge")),
    page: bootstrapMean(scores("page")),
    judgeNulls: ok.filter((r) => r.grade.soft.judge === null).length,
    infraLost: runs.length - ok.length,
  };
}

export interface SummaryOptions {
  model: string;
  driver: string;
  repeats: number;
  note?: string;
  arm?: Arm;
  holdout?: Set<string>;
  judgePrompt?: string | null;
}

export function summarize(runs: CaseRun[], o: SummaryOptions): Baseline {
  const groups = byCase(runs);
  const cases: Record<string, CaseSummary> = {};
  for (const [id, list] of groups) {
    const ok = list.filter(usable);
    const gateNames = [...new Set(list.flatMap((r) => r.grade.gates.map((g) => g.name)))];
    const gates: Record<string, string> = {};
    for (const g of gateNames) gates[g] = `${ok.filter((r) => r.grade.gates.find((x) => x.name === g)?.pass).length}/${ok.length}`;
    const js = ok.map((r) => r.grade.soft.judge).filter((x): x is number => x !== null);
    const ps = ok.map((r) => r.grade.soft.page).filter((x): x is number => x !== null && x !== undefined);
    cases[id] = {
      runs: list.length,
      usable: ok.length,
      infraLost: list.length - ok.length,
      gates,
      allGatesPass: `${ok.filter(allPass).length}/${ok.length}`,
      judge: avg(js),
      page: avg(ps),
      judgeNulls: ok.length - js.length,
      pageNulls: ok.length - ps.length,
      judgeInfra: ok.filter((r) => r.grade.soft.judge === null && judgeLost(r.grade.soft.judgeReasons)).length,
      pageInfra: ok.filter((r) => r.grade.soft.page === null && judgeLost(r.grade.soft.pageReasons)).length,
      ...(o.holdout?.has(id) ? { holdout: true } : {}),
      wallMs: Math.round(avg(list.map((r) => r.grade.soft.wallMs)) ?? 0),
      toolCalls: Math.round(avg(list.map((r) => r.grade.soft.toolCalls)) ?? 0),
      tokens: avg(list.map((r) => r.grade.soft.tokens).filter((x): x is number => x !== null)),
    };
  }
  const inSample = new Map([...groups].filter(([id]) => !o.holdout?.has(id)));
  const heldOut = new Map([...groups].filter(([id]) => o.holdout?.has(id)));
  return {
    schema: "agent-readiness/eval-baseline@2",
    recordedAt: new Date().toISOString(),
    note: o.note,
    arm: o.arm ?? "agent",
    instrument: { driverModel: o.model, judgeModel: joinSet(runs.filter((r) => r.grade.soft.judge !== null || r.grade.soft.page !== null).map((r) => r.judgeModel)), driver: o.driver, rubric: joinSet(runs.map((r) => r.rubric)), judgePrompt: o.judgePrompt ?? null, isolation: joinSet(runs.map((r) => r.isolation)) },
    repeats: o.repeats,
    cases,
    totals: totalsOf(inSample),
    holdout: heldOut.size ? totalsOf(heldOut) : null,
    runs: runs.map((r) => ({ id: r.id, repeat: r.repeat, arm: r.arm ?? "agent", gates: Object.fromEntries(r.grade.gates.map((g) => [g.name, g.pass])), judge: r.grade.soft.judge, page: r.grade.soft.page, judgeModel: r.judgeModel ?? null, infraLost: Boolean(r.infra?.lost), error: r.error })),
  };
}

// What the agent arm adds over a control arm on the same cases.
export function lift(agent: CaseRun[], control: CaseRun[]): Lift {
  const scores = (runs: CaseRun[], k: "judge" | "page") => {
    const m = new Map<string, number[]>();
    for (const r of runs.filter(usable)) if (typeof r.grade.soft[k] === "number") m.set(r.id, [...(m.get(r.id) ?? []), r.grade.soft[k] as number]);
    return m;
  };
  const a = totalsOf(byCase(agent)).pooled.rate;
  const c = totalsOf(byCase(control)).pooled.rate;
  return { pooled: a === null || c === null ? null : Math.round((a - c) * 1000) / 1000, judge: bootstrapDiff(scores(agent, "judge"), scores(control, "judge")), page: bootstrapDiff(scores(agent, "page"), scores(control, "page")) };
}

export function withControls(base: Baseline, agent: CaseRun[], controls: Partial<Record<Arm, CaseRun[]>>, holdout?: Set<string>): Baseline {
  const out: Baseline["controls"] = {};
  for (const [arm, runs] of Object.entries(controls) as [Arm, CaseRun[]][]) {
    if (!runs.length) continue;
    const ids = new Set(runs.map((r) => r.id));
    out[arm] = { totals: totalsOf(new Map([...byCase(runs)].filter(([id]) => !holdout?.has(id)))), lift: lift(agent.filter((r) => ids.has(r.id)), runs) };
  }
  return Object.keys(out).length ? { ...base, controls: out } : base;
}

function ratio(s: string): number {
  const [a, b] = s.split("/").map(Number);
  return b ? a / b : 0;
}

function counts(s: string): { k: number; n: number } {
  const [k, n] = s.split("/").map(Number);
  return { k, n };
}

const INSTRUMENT_FIELDS: [keyof Instrument, string][] = [
  ["driverModel", "driver model"],
  ["judgeModel", "judge model"],
  ["driver", "driver kind"],
  ["rubric", "rubric"],
  ["judgePrompt", "judge prompt"],
  ["isolation", "agent isolation"],
];

export interface CompareOptions {
  // The case ids this run was asked for. A baseline case among them with no result is missing; a
  // baseline case outside them (a smoke run against the full baseline) isn't compared.
  selected?: string[];
}

export function compare(current: Baseline, base: Baseline, opts: CompareOptions = {}): { regressions: string[]; flags: string[] } {
  const regressions: string[] = [];
  const flags: string[] = [];
  if ((base as { schema: string }).schema !== "agent-readiness/eval-baseline@2" || !base.instrument) {
    return { regressions: [`the baseline is ${(base as { schema: string }).schema}, which records no driver model, judge model, rubric or per-run results; re-record it with --write-baseline`], flags };
  }
  // A judge that didn't run (no key) isn't a different judge; one that ran as another model is.
  const mismatched = INSTRUMENT_FIELDS.filter(([k]) => !(k === "judgeModel" && current.instrument.judgeModel === null) && current.instrument[k] !== base.instrument[k]);
  if (mismatched.length) {
    return { regressions: mismatched.map(([k, label]) => `the ${label} differs from the baseline's: ${base.instrument[k] ?? "none"} in the baseline, ${current.instrument[k] ?? "none"} in this run. Re-record the baseline with this instrument, or rerun with --model and --judge-model set to the baseline's`), flags };
  }
  const selected = new Set(opts.selected ?? Object.keys(base.cases));
  for (const id of Object.keys(base.cases)) if (selected.has(id) && !current.cases[id]) regressions.push(`${id}: in the baseline but no run left a result`);
  for (const [id, c] of Object.entries(current.cases)) {
    if (c.runs < current.repeats) regressions.push(`${id}: only ${c.runs} of ${current.repeats} repeats left a result`);
    if (c.infraLost && c.usable === 0) regressions.push(`${id}: every run was lost to infrastructure errors, so nothing was measured`);
    else if (c.infraLost) flags.push(`${id}: ${c.infraLost} of ${c.runs} runs lost to infrastructure errors after retries`);
    const b = base.cases[id];
    if (!b) {
      flags.push(`${id}: new case with no baseline`);
      continue;
    }
    const verdict = (what: string, now: string, then: string) => {
      const { k, n } = counts(now);
      const v = kOfN(k, n, ratio(then));
      if (v === "regression") regressions.push(`${id}: ${what} ${then} -> ${now}`);
      else if (v === "flag") flags.push(`${id}: ${what} ${then} -> ${now} (one run short; a flag, not a regression)`);
    };
    verdict("all gates", c.allGatesPass, b.allGatesPass);
    for (const [g, then] of Object.entries(b.gates)) {
      if (c.gates[g] === undefined) regressions.push(`${id}: gate "${g}" is in the baseline but not in this run (renamed or removed: re-record the baseline)`);
      else verdict(`"${g}"`, c.gates[g], then);
    }
    for (const g of Object.keys(c.gates)) if (b.gates[g] === undefined) flags.push(`${id}: new gate "${g}" has no baseline`);
    for (const [label, nulls, infra, baseNulls, baseInfra, had] of [
      ["headline judge", c.judgeNulls, c.judgeInfra ?? 0, b.judgeNulls ?? 0, b.judgeInfra ?? 0, b.judge !== null],
      ["page judge", c.pageNulls, c.pageInfra ?? 0, b.pageNulls ?? 0, b.pageInfra ?? 0, b.page !== null],
    ] as const) {
      if (!had || nulls === 0) continue;
      // No score at all measures nothing, whatever the reason.
      if (nulls >= c.usable) {
        regressions.push(`${id}: the ${label} gave no score in any of ${c.usable} runs`);
        continue;
      }
      // A judge call lost to infrastructure is like a run lost to it: flagged, not counted.
      if (infra) flags.push(`${id}: the ${label} call failed on infrastructure in ${infra} of ${c.usable} runs`);
      // Other missing scores are misses, held to the baseline's own scored rate by k-of-n.
      const n = c.usable - infra;
      const baseN = b.usable - baseInfra;
      const v = kOfN(n - (nulls - infra), n, baseN > 0 ? (baseN - (baseNulls - baseInfra)) / baseN : 1);
      if (v === "regression") regressions.push(`${id}: the ${label} gave no score in ${nulls - infra} of ${n} runs`);
      else if (v === "flag") flags.push(`${id}: the ${label} gave no score in ${nulls - infra} of ${n} runs (one run short; a flag, not a regression)`);
    }
    if (b.judge !== null && c.judge !== null && b.judge - c.judge > 0.1) flags.push(`${id}: judge ${b.judge} -> ${c.judge}`);
    if (b.page != null && c.page != null && b.page - c.page > 0.1) flags.push(`${id}: page judge ${b.page} -> ${c.page}`);
  }
  const t = current.totals;
  const bt = base.totals;
  if (t.pooled.upper !== null && bt.pooled.rate !== null && t.pooled.upper < bt.pooled.rate) regressions.push(`pooled all-gates pass rate ${t.pooled.passed}/${t.pooled.runs} (95% CI ${t.pooled.lower} to ${t.pooled.upper}) is below the baseline's ${bt.pooled.rate}`);
  if (t.pooled.lower !== null && floorApplies(t.pooled.runs) && t.pooled.lower < POOLED_FLOOR) regressions.push(`pooled all-gates pass rate ${t.pooled.passed}/${t.pooled.runs} has a 95% lower bound of ${t.pooled.lower}, under the floor of ${POOLED_FLOOR}`);
  for (const [k, label] of [["judge", "headline judge"], ["page", "page judge"]] as const) {
    const now = t[k];
    const then = bt[k];
    if (now.high !== null && then.mean !== null && now.high < then.mean) regressions.push(`${label} mean ${now.mean} (95% CI ${now.low} to ${now.high}, bootstrapped over cases) is below the baseline's ${then.mean}`);
  }
  if (t.judge.high !== null && t.judge.high < JUDGE_BAR) flags.push(`headline judge mean ${t.judge.mean} (95% CI ${t.judge.low} to ${t.judge.high}) is below the bar of ${JUDGE_BAR}`);
  return { regressions, flags };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function writeJunit(path: string, runs: CaseRun[]): void {
  const cases = runs.flatMap((r) => r.grade.gates.map((g) => ({ name: `${r.id} #${r.repeat}${r.arm && r.arm !== "agent" ? ` [${r.arm}]` : ""} ${g.name}`, g, r })));
  const failures = cases.filter((c) => !c.g.pass && !c.r.infra?.lost).length;
  const body = cases
    .map((c) => `  <testcase classname="agent-readiness.${esc(c.r.id)}" name="${esc(c.name)}" time="${(c.r.grade.soft.wallMs / 1000).toFixed(1)}">${c.r.infra?.lost ? `<skipped message="${esc(`lost to infrastructure: ${c.r.error ?? ""}`)}"/>` : c.g.pass ? "" : `<failure message="${esc(c.g.detail)}"/>`}</testcase>`)
    .join("\n");
  writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="agent-readiness skill evals" tests="${cases.length}" failures="${failures}">\n${body}\n</testsuite>\n`);
}
