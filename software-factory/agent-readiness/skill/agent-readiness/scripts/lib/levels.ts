import type { Rubric } from "./rubric.ts";
import type { CompStates } from "./score.ts";
import type { CondId, CondState, Component, HistoryLine, Level, OutcomeStats, ScenarioId, ScenarioSpec, Targets } from "./types.ts";

export interface LevelResult {
  level: Level;
  couldBe: Level | null;
  missing: CondId[];
  unknown: CondId[];
}

type StateMap = Partial<Record<CondId, CondState>>;

export function statesOf(detail: CompStates): StateMap {
  const out: StateMap = {};
  for (const [k, v] of Object.entries(detail)) out[k as CondId] = v.state;
  return out;
}

function evaluate(conds: CondId[], states: StateMap): { met: boolean; missing: CondId[]; unknown: CondId[] } {
  const missing = conds.filter((c) => states[c] === "not_met");
  const unknown = conds.filter((c) => (states[c] ?? "unknown") === "unknown" || states[c] === "blocked");
  return { met: missing.length === 0 && unknown.length === 0, missing, unknown };
}

// The standard level by default; a scenario swaps in its own Level 2 bar.
export function componentLevel(rubric: Rubric, states: StateMap, scenarioId?: ScenarioId): LevelResult {
  const level2 = scenarioId ? rubric.scenarios.find((a) => a.id === scenarioId)!.level2 : rubric.level2;
  const l1 = evaluate(rubric.level1, states);
  if (!l1.met) return { level: 0, couldBe: l1.missing.length === 0 ? 1 : null, missing: l1.missing, unknown: l1.unknown };
  const l2 = evaluate(level2, states);
  if (!l2.met) return { level: 1, couldBe: l2.missing.length === 0 ? 2 : null, missing: l2.missing, unknown: l2.unknown };
  return { level: 2, couldBe: null, missing: [], unknown: [] };
}

// Which scenarios apply to a component, in rubric order.
export function scenariosFor(rubric: Rubric, specs: ScenarioSpec[], componentId: string): ScenarioId[] {
  const ids = new Set(specs.filter((s) => s.components.includes("*") || s.components.includes(componentId)).map((s) => s.id));
  return rubric.scenarios.filter((s) => ids.has(s.id)).map((s) => s.id);
}

export function activeComponents(rubric: Rubric, components: Component[], previous: HistoryLine[]): Set<string> {
  const threshold = rubric.repoLevel.activeShare;
  const prev = previous.filter((h) => h.kind === "audit" && !h.noLevel);
  const last = prev[prev.length - 1];
  const active = new Set<string>();
  for (const c of components.filter((x) => x.assessed)) {
    const nowAbove = c.changeShare >= threshold;
    // A component the last audit never saw has no earlier share to wait for.
    if (!last || (rubric.repoLevel.newComponentsJoin && !(c.id in last.shares))) {
      if (nowAbove) active.add(c.id);
      continue;
    }
    const wasActive = last.active.includes(c.id);
    const lastAbove = (last.shares[c.id] ?? 0) >= threshold;
    if (wasActive) {
      if (!nowAbove && !lastAbove) continue;
      active.add(c.id);
    } else if (nowAbove && lastAbove) active.add(c.id);
  }
  if (active.size === 0) {
    const top = components.filter((x) => x.assessed).sort((a, b) => b.changeShare - a.changeShare)[0];
    if (top) active.add(top.id);
  }
  return active;
}

export function repoLevel(levels: Map<string, LevelResult>, active: Set<string>): { level: Level; couldBe: Level | null; setBy: string[] } {
  const rows = [...levels.entries()].filter(([id]) => active.has(id));
  if (rows.length === 0) return { level: 0, couldBe: null, setBy: [] };
  const min = Math.min(...rows.map(([, l]) => l.level)) as Level;
  const setBy = rows.filter(([, l]) => l.level === min).map(([id]) => id);
  const couldBe = rows.filter(([, l]) => l.level === min).every(([, l]) => l.couldBe !== null) ? ((min + 1) as Level) : null;
  return { level: min, couldBe, setBy };
}

export function partialCoverage(rubric: Rubric, components: Component[]): { partial: boolean; unassessedShare: number } {
  const unassessedShare = components.filter((c) => !c.assessed).reduce((s, c) => s + c.changeShare, 0);
  return { partial: unassessedShare > rubric.repoLevel.partialCoverageShare, unassessedShare };
}

// Levels 3 and 4 are measured per component, on the agent PRs that touch it, against the same
// control group of other PRs.
export interface OutcomeLevelInput {
  level2: boolean;
  targets: Targets | null;
  outcomes: { agent: OutcomeStats; control: OutcomeStats; truncated?: boolean; windowDays?: number } | null;
  // The agent PRs of the last audit where this component was at Level 3 or above.
  previousAtLevel3: OutcomeStats | null;
  // The unbroken run of earlier audits at Level 3 or above, oldest first, for the streak rule.
  level3Run?: OutcomeStats[];
}

export function targetsMet(rubric: Rubric, targets: Targets, outcomes: { agent: OutcomeStats; control: OutcomeStats }): { met: boolean; reasons: string[] } {
  const a = outcomes.agent;
  const floor = Math.max(rubric.level3.absoluteMinAgentPRs, targets.minAgentPrs);
  const reasons: string[] = [];
  if (a.opened < floor) reasons.push(`only ${a.opened} agent PRs in the window; at least ${floor} are needed`);
  if (outcomes.control.opened === 0) reasons.push("no other PRs in the window to compare with");
  // Under a measured window a first-time CI rate needs as many finished CI runs as any other rate.
  if (rubric.level3.rule === "measured-window" && a.firstTimeCiKnown < rubric.outcomes.minRateN) reasons.push(`only ${a.firstTimeCiKnown} agent PRs have a finished first CI run; at least ${rubric.outcomes.minRateN} are needed for a rate`);
  const merge = a.opened ? a.merged / a.opened : 0;
  const first = a.firstTimeCiKnown ? a.firstTimeCiPass / a.firstTimeCiKnown : 0;
  const cr = a.opened ? a.changesRequested / a.opened : 1;
  if (merge < targets.mergeRate) reasons.push(`merge rate ${Math.round(merge * 100)}% is below the target ${Math.round(targets.mergeRate * 100)}%`);
  if (first < targets.firstPass) reasons.push(`first-time CI pass rate ${Math.round(first * 100)}% is below the target ${Math.round(targets.firstPass * 100)}%`);
  if (cr > targets.maxChangesRequested) reasons.push(`change requests on ${Math.round(cr * 100)}% of agent PRs is above the target ${Math.round(targets.maxChangesRequested * 100)}%`);
  return { met: reasons.length === 0, reasons };
}

export function outcomeLevel(rubric: Rubric, input: OutcomeLevelInput): { level: Level | null; reasons: string[] } {
  if (!input.level2) return { level: null, reasons: [] };
  if (!input.targets) return { level: null, reasons: ["no Level 3 targets are recorded"] };
  if (!input.outcomes) return { level: null, reasons: ["outcomes weren't measured in this audit"] };
  if (input.outcomes.truncated) return { level: null, reasons: ["the PR window held more PRs than gh returns at once, so Level 3 isn't measured from a partial window"] };
  const days = input.outcomes.windowDays;
  if (rubric.level3.rule === "measured-window" && days !== undefined && days !== rubric.outcomes.windowDays) return { level: null, reasons: [`Level 3 is measured over a ${rubric.outcomes.windowDays}-day window; this one was ${days} days`] };
  const t = targetsMet(rubric, input.targets, input.outcomes);
  if (!t.met) return { level: null, reasons: t.reasons };
  if (rubric.level4.rule === "streak") return streakLevel(rubric, input.outcomes.agent, input.level3Run ?? []);
  const prev = input.previousAtLevel3;
  if (prev) {
    const grew = input.outcomes.agent.opened >= rubric.level4.volumeMultiplier * prev.opened;
    const prevCr = prev.opened ? prev.changesRequested / prev.opened : 0;
    const nowCr = input.outcomes.agent.opened ? input.outcomes.agent.changesRequested / input.outcomes.agent.opened : 0;
    if (grew && nowCr <= prevCr) return { level: 4, reasons: [] };
  }
  return { level: 3, reasons: [] };
}

const crRate = (s: OutcomeStats) => (s.opened ? s.changesRequested / s.opened : 0);

// Level 4: this window and the run before it make at least consecutiveWindows back-to-back windows
// that met the targets, and agent volume grew by volumeMultiplier over the run's first window
// without the change-request rate rising. A Level 4 window stays in the run, so holding the
// volume keeps Level 4, and a window below Level 3 starts the count again.
function streakLevel(rubric: Rubric, now: OutcomeStats, run: OutcomeStats[]): { level: Level; reasons: string[] } {
  const need = rubric.level4.consecutiveWindows;
  const windows = run.length + 1;
  if (windows < need) return { level: 3, reasons: [`Level 4 needs ${need} back-to-back windows that meet the targets; this is window ${windows}`] };
  const first = run[0];
  const target = rubric.level4.volumeMultiplier * first.opened;
  if (now.opened < target) return { level: 3, reasons: [`Level 4 needs at least ${target} agent PRs in a window, ${rubric.level4.volumeMultiplier} times the ${first.opened} of the first window at Level 3; this window has ${now.opened}`] };
  if (crRate(now) > crRate(first)) return { level: 3, reasons: [`Level 4 needs change requests to stay at or below the first window's ${Math.round(crRate(first) * 100)}%; they rose to ${Math.round(crRate(now) * 100)}%`] };
  return { level: 4, reasons: [] };
}

export interface RunOptions {
  // A production audit counts only windows read from GitHub by production audits.
  production?: boolean;
  // Where this audit's window starts; each earlier window must end by the start of the next one.
  from?: string;
  // Every window in the run must itself have had enough agent PRs for Level 3.
  minOpened?: number;
}

// The unbroken run of earlier windows at Level 3 or above, oldest first. An audit that gave no
// level, a failed recheck, an overlapping window, or an eval window in a production audit ends it.
export function level3Run(history: HistoryLine[], componentId: string, opts: RunOptions = {}): OutcomeStats[] {
  const run: OutcomeStats[] = [];
  let nextFrom = opts.from;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.kind === "recheck") {
      if (h.result === "failed" && !h.noLevel && (h.levels[componentId] ?? 0) < 3) break;
      continue;
    }
    const s = h.outcomes?.byComponent?.[componentId];
    if (h.noLevel || !s || (h.levels[componentId] ?? 0) < 3) break;
    if (opts.production && (h.seedPinned || h.outcomes?.source === "file")) break;
    if ((opts.minOpened ?? 0) > s.opened) break;
    // A re-audit inside a window isn't a window of its own: skip it rather than end the run.
    const [from, to] = (h.outcomes?.window ?? "").split(" to ");
    if (nextFrom && to && to > nextFrom) continue;
    nextFrom = from;
    run.unshift(s);
  }
  return run;
}

export function previousAtLevel3(history: HistoryLine[], componentId: string): OutcomeStats | null {
  const prev = [...history].reverse().find((h) => h.kind === "audit" && h.outcomes?.byComponent?.[componentId] && (h.levels[componentId] ?? 0) >= 3);
  return prev?.outcomes?.byComponent[componentId] ?? null;
}

export function recheckStates(base: StateMap, failedKinds: Set<string>): StateMap {
  const out: StateMap = { ...base };
  if (failedKinds.has("install")) out["clean.install"] = "not_met";
  if (failedKinds.has("build")) {
    out["clean.build"] = "not_met";
    out.commands = "not_met";
  }
  if (failedKinds.has("test")) {
    out["clean.test"] = "not_met";
    out.commands = "not_met";
  }
  if (failedKinds.has("lint") || failedKinds.has("typecheck")) out.commands = "not_met";
  return out;
}

export function capAt(level: Level, cap: Level): Level {
  return (level > cap ? cap : level) as Level;
}
