import type { ExpectedRun } from "../../tools/fixture.ts";

// Everything an audit wrote that expected.json can speak about.
export interface AuditRecords {
  report: Record<string, any>;
  roadmap: Record<string, any>;
  audit: Record<string, any>;
  // latest/report.md, for fields about what the reader sees.
  markdown?: string;
}

type Check<K extends keyof ExpectedRun> = (want: Exclude<ExpectedRun[K], undefined>, got: AuditRecords) => string[];

// One entry per field of ExpectedRun, so a field added to expected.json without a check here
// doesn't compile. "input" fields say how the audit was run, not what it should find.
type Checks = { [K in keyof Required<ExpectedRun>]: Check<K> | "input" };

const show = (x: unknown) => JSON.stringify(x);
const same = (a: unknown, b: unknown) => show(sortKeys(a)) === show(sortKeys(b));

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]));
  return x;
}

function differ(what: string, want: unknown, got: unknown): string[] {
  return same(want, got) ? [] : [`${what}: expected ${show(want)}, got ${show(got)}`];
}

export function checkOf(condition: string): string {
  if (condition.startsWith("clean.") || condition === "toolchain" || condition === "lockfile") return "bootstrap.cold_replay";
  if (condition === "commands") return "verify.canonical_interface";
  if (condition === "faults") return "verify.behavioral_oracle";
  if (condition === "instructions") return "context.instructions_verified";
  return "safety.execution_boundary";
}

const notComponent = (u: { reason: string }) => u.reason.startsWith("not a component");
const topOf = (r: AuditRecords["report"]) => (r.actions ?? []).filter((x: { startNow: boolean }) => !x.startNow).map((x: { itemId: string }) => x.itemId);

const CHECKS: Checks = {
  name: "input",
  registryEnv: "input",
  runtime: "input",
  scenarios: "input",
  level: (want, { report }) => differ("repo level", want, report.maturity?.level),
  levels: (want, { report }) => differ("component levels", want, Object.fromEntries((report.components?.included ?? []).map((c: { id: string; level: number }) => [c.id, c.level]))),
  scenarioLevels: (want, { report }) => {
    const got: Record<string, Record<string, number>> = {};
    for (const c of report.components?.included ?? []) if (c.scenarios?.length) got[c.id] = Object.fromEntries(c.scenarios.map((s: { id: string; level: number }) => [s.id, s.level]));
    return differ("scenario levels", want, got);
  },
  top: (want, { report, roadmap }) => {
    const top = topOf(report);
    const problems = differ("top items in order", want, top);
    const passed = new Set((report.details?.checks ?? []).filter((c: { ok: boolean | null }) => c.ok === true).map((c: { id: string }) => c.id));
    for (const t of top) {
      const item = (roadmap.items ?? []).find((i: { id: string }) => i.id === t);
      if (!item) problems.push(`top item ${t} isn't in roadmap.json`);
      else for (const f of item.fixes) if (passed.has(checkOf(f.condition))) problems.push(`top item ${t} names ${checkOf(f.condition)}, which passed`);
    }
    return problems;
  },
  startNow: (want, { report }) => differ("can-start-now item", want, (report.actions ?? []).find((x: { startNow: boolean }) => x.startNow)?.itemId ?? null),
  noBlocker: (want, { report }) => differ("no-blocker result", want, report.executive?.noBlocker),
  safety: (want, { report }) => {
    const s = (report.details?.checks ?? []).find((c: { id: string }) => c.id === "safety.execution_boundary");
    return differ("safety check", want, s ? (s.ok ? "pass" : "fail") : "missing");
  },
  notAssessed: (want, { report }) => differ("not assessed", want, (report.components?.excluded ?? []).filter((u: { reason: string }) => !notComponent(u)).map((u: { id: string }) => u.id)),
  waiting: (want, { roadmap }) => want.flatMap((w) => differ(`${w} status`, "waiting", (roadmap.items ?? []).find((i: { id: string }) => i.id === w)?.status ?? "missing")),
  diagnosis: (want, { report }) => ((report.details?.evidence ?? []).some((e: { summary: string }) => e.summary.includes(want)) ? [] : [`no evidence says "${want}"`]),
  outcome: (want, { report }) => differ("outcome", want, report.maturity?.outcome),
  shares: (want, { report }) => {
    const all = [...(report.components?.included ?? []), ...(report.components?.excluded ?? []).filter((c: { reason: string }) => !notComponent(c))];
    return differ("change shares", want, Object.fromEntries(all.filter((c: { id: string }) => c.id in want).map((c: { id: string; changeShare: number }) => [c.id, c.changeShare])));
  },
  satellites: (want, { report }) => differ("satellites", want, (report.components?.excluded ?? []).filter(notComponent).map((c: { path: string }) => c.path)),
  assets: (want, { report }) => Object.entries(want).flatMap(([path, ok]) => differ(`asset ${path} ok`, ok, (report.details?.assets ?? []).find((x: { path: string }) => x.path === path)?.ok ?? "missing")),
  listed: (want, { audit }) => differ("safety findings listed for review", [...want].sort(), [...new Set((audit.safety ?? []).filter((s: { blocking: boolean }) => !s.blocking).map((s: { kind: string }) => s.kind))].sort()),
  signals: (want, { report }) => differ("signals", want, Object.fromEntries((report.details?.signals ?? []).filter((s: { id: string }) => s.id in want).map((s: { id: string; found: boolean | null }) => [s.id, s.found]))),
  coverage: (want, { report }) => (new RegExp(want).test(report.executive?.coverage ?? "") ? [] : [`coverage line doesn't match /${want}/: ${report.executive?.coverage}`]),
  contract: (want, { audit }) => Object.entries(want).flatMap(([id, command]) => differ(`contract ${id} command`, command, (audit.contract ?? []).find((c: { id: string }) => c.id === id)?.command ?? "missing")),
  neverRan: (want, { audit }) => {
    const ran: string[] = (audit.evidence ?? []).map((e: { command?: string }) => e.command ?? "").filter(Boolean);
    return want.flatMap((text) => ran.filter((c) => c.includes(text)).map((c) => `the audit ran "${c}", which contains ${text}`));
  },
  unassessed: (want, { report, markdown }) => {
    const u = report.executive?.unassessed;
    const problems = differ("part 1's not-assessed line", want, u ? { share: u.share, supportLink: u.supportDoc !== null } : null);
    if (want?.supportLink && !/\*\*Not assessed:\*\* .*What the audit supports/.test(markdown ?? "")) problems.push("part 1 doesn't link the support list");
    return problems;
  },
  absent: (want, { report, audit, markdown }) => {
    const places: [string, string][] = [["report.md", markdown ?? ""], ["report.json", JSON.stringify(report)], ["audit.json", JSON.stringify(audit)]];
    return want.flatMap((value) => places.filter(([, text]) => text.includes(value)).map(([what]) => `${what} echoes a value that must be absent (${value.slice(0, 6)}…)`));
  },
  skipped: (want, { audit }) => differ("instruction commands listed as skipped", want, (audit.instructions ?? []).filter((i: { category: string }) => i.category === "skipped").length),
};

export const INPUT_FIELDS = Object.entries(CHECKS).filter(([, v]) => v === "input").map(([k]) => k);
export const CHECKED_FIELDS = Object.entries(CHECKS).filter(([, v]) => v !== "input").map(([k]) => k);

// Every way the audit's records differ from one expected.json run. Fields the run leaves out
// aren't checked, except scenarioLevels, which must be empty when the run adds no scenarios.
export function expectedProblems(want: ExpectedRun, got: AuditRecords): string[] {
  const problems: string[] = [];
  for (const [key, check] of Object.entries(CHECKS) as [keyof ExpectedRun, Checks[keyof ExpectedRun]][]) {
    if (check === "input") continue;
    const value = key === "scenarioLevels" ? (want.scenarioLevels ?? {}) : want[key];
    if (value === undefined) continue;
    try {
      problems.push(...(check as Check<typeof key>)(value as never, got));
    } catch (e) {
      problems.push(`${key}: couldn't be checked: ${(e as Error).message}`);
    }
  }
  return problems;
}

export function unknownFields(run: Record<string, unknown>): string[] {
  return Object.keys(run).filter((k) => !(k in CHECKS));
}
