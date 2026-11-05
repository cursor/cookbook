import type { LevelResult } from "./levels.ts";
import { describeRate, rate, windowLabel } from "./outcomes.ts";
import { watchFor } from "./roadmap.ts";
import type { Rubric } from "./rubric.ts";
import type { CompStates } from "./score.ts";
import { sampledScope } from "./scope.ts";
import { blockedBy, checkCounts } from "./score.ts";
import type { ComponentResult } from "./seal.ts";
import { NOT_SUPPORTED, SUPPORTED_DOC } from "./support.ts";
import type { Asset, Audit, CondId, Component, ComponentLevel, HistoryLine, Level, OutcomeStats, OutcomesSnapshot, ReportAction, ReportChanges, ReportJson, Roadmap, RoadmapItem, ScenarioId } from "./types.ts";
import { EMOJI, fmtDate, fmtShortDate, pct, wordCount } from "./util.ts";
import { serviceLabel } from "./diagnose.ts";

export interface RenderInput {
  audit: Audit;
  rubric: Rubric;
  components: Component[];
  states: Map<string, CompStates>;
  levels: Map<string, ComponentResult>;
  scenarioLevels: Map<string, Map<ScenarioId, LevelResult>>;
  rollup: { level: Level; couldBe: Level | null; setBy: string[]; outcomeReasons: string[] };
  active: Set<string>;
  roadmap: Roadmap;
  top: RoadmapItem[];
  startNow: RoadmapItem | null;
  history: HistoryLine[];
  currentLine: HistoryLine;
  previousOutcomes: { window: string; agent: OutcomeStats } | null;
  weakening: string | null;
  sealStatus: string;
  staleCopy: string | null;
  storedAt: string;
  partial: { partial: boolean; unassessedShare: number };
  // Why the audit has no real check results to give a level from, or null when it has some.
  noResults?: string | null;
  // references/supported.md as a repo-relative path when the skill is installed in the repo.
  supportDoc?: string | null;
  // The previous audit's sealed report, for what changed since; null on a first audit or when it can't be read.
  previousReport?: ReportJson | null;
}

const STATUS_TEXT: Record<RoadmapItem["status"], string> = { done: "done", in_progress: "in progress", next: "next", start_now: "can start now", waiting: "waiting", later: "later" };

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function condLabel(rubric: Rubric, c: CondId): string {
  return rubric.conditions[c].label;
}

// The rubric's labels name every command kind; say only what these components' contracts run.
function condPhrase(input: RenderInput, c: CondId, comps: string[]): string | null {
  const has = (kind: string) => input.audit.contract.some((k) => k.kind === kind && comps.includes(k.component));
  if (c === "clean.build" && !has("build")) return null;
  if (c === "commands") {
    const kinds = ["build", "lint", "typecheck", "test"].filter(has);
    if (kinds.length > 0 && kinds.length < 4) return `${list(kinds.map((k) => (k === "typecheck" ? "type-check" : k)))} commands pass`;
  }
  return condLabel(input.rubric, c);
}

function statusText(item: RoadmapItem, roadmap: Roadmap): string {
  if (item.status === "done") return item.closedAt ? `done ${fmtShortDate(item.closedAt)}` : "done";
  if (item.status === "waiting") {
    const orders = item.dependsOn.map((d) => roadmap.items.find((i) => i.id === d)?.order).filter((x): x is number => typeof x === "number");
    return orders.length ? `waiting on step ${list(orders.map(String))}` : "waiting";
  }
  return STATUS_TEXT[item.status];
}

function researchFor(rubric: Rubric, item: RoadmapItem): string | null {
  const cond = item.fixes[0]?.condition;
  if (!cond) return null;
  const checkId = rubric.templates[item.template]?.researchCheck ?? rubric.conditions[cond].check;
  const check = rubric.checks.find((c) => c.id === checkId);
  const src = check?.sources[0];
  return src ? `${src.claim} ${src.caveat} ${src.url}` : null;
}

function metricLabel(metric: string, scope = "repo"): string {
  const [m, pattern] = metric.split(":");
  const prs = scope === "repo" ? "agent PRs" : `agent PRs touching ${scope}`;
  if (m === "first_time_ci_pass") return `Share of ${prs} that pass CI the first time`;
  if (m === "changes_requested") return `Share of ${prs} where a reviewer requested changes`;
  if (m === "prs_adding_path") return `${prs.charAt(0).toUpperCase() + prs.slice(1)} that add a stray ${pattern}`;
  return `Merged ${prs}`;
}

function watchLine(item: RoadmapItem, rubric: Rubric, outcomes: OutcomesSnapshot | null): string {
  const w = item.expected.watch;
  const label = metricLabel(w.metric, w.scope);
  const [metric, pattern] = w.metric.split(":");
  const now = outcomes ? watchFor(metric, w.scope, outcomes, rubric, pattern) : null;
  const baseline = `${w.baseline}${w.window ? `, ${w.window}` : ""}`;
  if (!now || (now.window === w.window && now.baseline === w.baseline)) return `${label}. Now: ${baseline}.`;
  return `${label}. Baseline: ${baseline}. Now: ${now.baseline}, ${now.window}.`;
}

function action(item: RoadmapItem, rank: number, rubric: Rubric, roadmap: Roadmap, startNow: boolean, outcomes: OutcomesSnapshot | null): ReportAction {
  return {
    rank,
    itemId: item.id,
    title: item.title,
    startNow,
    why: item.why,
    movesTheNeedle:
      item.kind === "fix"
        ? `${item.impact > 0 ? `Takes ${item.unlocks}, covering ${pct(item.impact, 1)}% of recent changes` : item.unlocks.includes(" together with ") ? `Takes ${item.unlocks}` : `Changes no level on its own: ${item.unlocks}`}. ${item.expected.outcome}`
        : `Unlocks ${item.unlocks}. ${item.expected.outcome}`,
    watch: watchLine(item, rubric, outcomes),
    research: researchFor(rubric, item),
    effortAndOwner: `${item.size}. ${item.ownerRole}.`,
    decision: item.decision,
    doneWhen: item.doneWhen,
    dependsOn: item.dependsOn.map((d) => roadmap.items.find((i) => i.id === d)?.title ?? d),
    impact: item.impact,
    effort: item.effort,
    evidence: item.evidence,
  };
}

// The level of the scale a roadmap step is part of reaching: the lowest level whose conditions it
// fixes. Steps such as naming an owner serve every level.
function itemLevel(rubric: Rubric, item: RoadmapItem): Level | null {
  // Targets define Level 3, and giving agents work is what produces the PRs it is measured on.
  if (item.template === "targets" || item.kind === "rollout") return 3;
  const conds = item.fixes.map((f) => f.condition);
  if (conds.some((c) => rubric.level1.includes(c))) return 1;
  if (conds.some((c) => rubric.level2.includes(c))) return 2;
  return null;
}

// A not-assessed reason reads after "because": "outside the 6 most active components" needs a subject.
function becauseOf(reason: string): string {
  return /^outside /.test(reason) ? `it's ${reason}` : reason;
}

function compLevel(input: RenderInput, id: string): ComponentResult | undefined {
  return input.levels.get(id);
}

// With nothing assessed, every level rule is vacuously met and every count is 0 of 0.
function noneAssessed(input: RenderInput): boolean {
  return !input.components.some((c) => c.assessed);
}

// No real results, no level: the report says why and plans nothing.
function notAssessed(input: RenderInput): boolean {
  return noneAssessed(input) || Boolean(input.noResults);
}

function nextConds(input: RenderInput): CondId[] {
  const L = input.rollup.level;
  return L === 0 ? input.rubric.level1 : L === 1 ? input.rubric.level2 : [];
}

function capComps(input: RenderInput): string[] {
  return input.rollup.setBy.length ? input.rollup.setBy : [...input.active];
}

function outcomeOf(input: RenderInput): ReportJson["maturity"]["outcome"] {
  if (notAssessed(input)) return "not_assessed";
  const blocked = capComps(input).some((id) => nextConds(input).some((c) => input.states.get(id)?.[c].state === "blocked"));
  return blocked ? "blocked" : "proven";
}

// Each condition that holds the level where it is, by name, so nobody has to infer what stopped it.
function capReasons(input: RenderInput): ReportJson["maturity"]["capReasons"] {
  if (notAssessed(input)) return [];
  const { rubric, rollup } = input;
  if (rollup.level >= 2) return rollup.level < 4 ? rollup.outcomeReasons.map((r) => ({ component: "*", condition: "outcomes", label: outcomeLabel(rollup.level), state: "not_met" as const, reason: r })) : [];
  const out: ReportJson["maturity"]["capReasons"] = [];
  for (const id of capComps(input)) {
    for (const c of nextConds(input)) {
      const s = input.states.get(id)?.[c];
      if (!s || s.state === "met") continue;
      const component = rubric.conditions[c].scope === "repo" ? "*" : id;
      if (out.some((x) => x.component === component && x.condition === c)) continue;
      out.push({ component, condition: c, label: condLabel(rubric, c), state: s.state, reason: s.reason });
    }
  }
  return out;
}

function confidenceOf(input: RenderInput, outcome: ReportJson["maturity"]["outcome"]): ReportJson["maturity"]["confidence"] {
  const { audit } = input;
  const low: string[] = [];
  const medium: string[] = [];
  if (outcome === "not_assessed") low.push(noneAssessed(input) ? "no component could be assessed" : input.noResults!);
  if (outcome === "blocked") low.push(`a check that decides Level ${input.rollup.level + 1} was blocked on this machine`);
  if (outcome !== "not_assessed" && audit.tier === "read-only") low.push("the read-only tier runs no repo code");
  if (outcome === "proven" && audit.tier !== "read-only" && !audit.environment.containerRuntime) low.push("setup ran in a fresh copy on the host, not in a clean container");
  if (input.partial.partial) medium.push(`${pct(input.partial.unassessedShare, 1)}% of recent changes aren't assessed`);
  const sampled = input.components.filter((c) => c.notAssessedReason?.startsWith("outside the "));
  if (sampled.length) medium.push(`${sampled.length} supported ${sampled.length === 1 ? "component was" : "components were"} left out to keep the audit short`);
  if (outcome === "proven" && input.rollup.couldBe !== null) medium.push("a check that decides the next level couldn't run");
  const level = low.length ? "low" : medium.length ? "medium" : "high";
  return { level, reasons: [...low, ...medium].length ? [...low, ...medium] : ["every check that decides the level ran"] };
}

// Only the steps a level depends on: a refused start command doesn't explain a missing Level 1.
function blockedCauses(input: RenderInput): string[] {
  return [...new Set(input.audit.evidence.filter((e) => e.kind !== "start" && e.kind !== "doctor").map(blockedBy).filter((b): b is string => Boolean(b) && b !== "the install was blocked on this machine").map((b) => b.replace(/, though the repo's declared image .*$/, "")))];
}

// Each is a clause that follows "it" in the headline.
function whyNoneAssessed(input: RenderInput): string[] {
  const skipped = input.components.filter((c) => !c.assessed).sort((a, b) => b.changeShare - a.changeShare);
  if (skipped.length === 0) return ["found no package it supports"];
  const detailed = `skipped ${list(skipped.map((c) => `${c.id} (${pct(c.changeShare, 1)}% of changes) because ${becauseOf(c.notAssessedReason ?? "it isn't supported")}`))}`;
  return [detailed, `skipped ${skipped.length} ${skipped.length === 1 ? "component whose toolchain" : "components whose toolchains"} the audit doesn't support yet`];
}

// What would let a rerun give the level, for the cause this audit hit; null when only support for
// the stack would, which the part 1 support line covers.
function rerunAdvice(input: RenderInput, causes: string[], verb: "give one" | "prove it"): string | null {
  if (input.audit.tier === "read-only") return `A local-exec audit can ${verb}.`;
  if (!input.audit.environment.containerRuntime) return `A rerun where Docker or Podman is available, such as CI, can ${verb}.`;
  if (causes.some((c) => NOT_SUPPORTED.test(c))) return null;
  if (causes.some((c) => / hit .*network/.test(c))) return `A rerun with open network access can ${verb}.`;
  if (causes.some((c) => /in the audit's image/.test(c))) return `A rerun with an image that has the tool, passed with --image, can ${verb}.`;
  return `A rerun where these checks can run can ${verb}.`;
}

function headlineFor(input: RenderInput, ready: string[], setByShare: number): string {
  const { rollup, rubric } = input;
  const top = input.top;
  const active = [...input.active];
  const fit = (...c: string[]) => c.find((x) => wordCount(x) <= rubric.part1.maxHeadlineWords) ?? c[c.length - 1];
  if (noneAssessed(input)) {
    return fit(...whyNoneAssessed(input).map((why) => `No component could be assessed, so this audit can't give a level yet: it ${why}.`), "No component could be assessed, so this audit can't give a level yet.");
  }
  if (input.noResults) {
    if (input.audit.tier === "read-only") return "This read-only audit ran no repo code, so it gives no level yet. A local-exec audit can give one.";
    const causes = blockedCauses(input);
    const rerun = rerunAdvice(input, causes, "give one");
    const where = input.audit.environment.containerRuntime ? "in the audit's container" : "on this machine";
    const tail = rerun ? ` ${rerun}` : "";
    return fit(...(causes.length ? [`Nothing could be checked ${where}, so this audit gives no level: ${list(causes)}.${tail}`] : []), `Nothing could be checked ${where}, so this audit gives no level.${tail}`);
  }
  if (unproven(input)) {
    const held = capComps(input);
    const where = held.length <= 3 ? list(held) : `all ${held.length} ${held.length === active.length ? "active " : ""}components`;
    const readOnly = input.audit.tier === "read-only";
    const causes = blockedCauses(input);
    const why = readOnly ? "the read-only tier runs no repo code" : !input.audit.environment.containerRuntime ? list(["this machine has no container runtime", ...causes]) : causes.length ? list(causes) : "a check that decides it couldn't run here";
    const rerun = rerunAdvice(input, causes, "prove it");
    const tail = rerun ? ` ${rerun}` : "";
    const other = notMachineCause(input);
    if (other) return fit(`Level ${rollup.level + 1} couldn't be proved for ${where}: ${other}.`, `Level ${rollup.level + 1} couldn't be proved for ${where}.`);
    return fit(`Level ${rollup.level + 1} couldn't be proved for ${where} because ${why}.${tail}`, `Level ${rollup.level + 1} couldn't be proved for ${where} on this machine.${tail}`);
  }
  if (top.length === 0 || top.every((t) => t.kind !== "fix")) {
    if (rollup.level >= 3) return "Agent PRs meet your Level 3 targets. Keep the weekly recheck running and widen the work agents take.";
    const one = active.length === 1;
    const where = active.length <= 3 ? list(active) : `all ${active.length} active components`;
    // "builds" only when every active component has a build step that passed; many have none.
    const built = active.every((id) => input.audit.contract.some((c) => c.kind === "build" && (c.component === id || c.component === "*") && input.audit.evidence.some((e) => e.contractId === c.id && e.result === "pass")));
    const does = one ? (built ? "it installs, builds and passes its" : "it installs and passes its") : built ? "they install, build and pass their" : "they install and pass their";
    return `Nothing blocks agents in ${where}: from a clean checkout ${does} tests, and ${one ? "its" : "their"} tests caught the planted bugs. Start delegating work to agents.`;
  }
  const names = list(rollup.setBy);
  const share = active.length > 1 ? `, and ${pct(setByShare, 1)}% of recent changes land there` : "";
  const readyLine = ready.length ? ` ${list(ready)} ${ready.length > 1 ? "are" : "is"} already at Level 2.` : "";
  const many = rollup.setBy.length > 1;
  const their = many ? "their" : "its";
  if (rollup.level === 0) {
    const blockers = new Set(top.filter((t) => t.kind === "fix" && t.fixes.some((f) => rollup.setBy.includes(f.component) || f.component === "*")).map((t) => t.template));
    // Components held back for different reasons are each named with their own.
    const phrase: Record<string, string> = { "clean.install": "doesn't install from a clean checkout", "clean.test:missing": "has no tests", "clean.build": "doesn't build from a clean checkout" };
    const own = rollup.setBy.map((id) => {
      const t = top.find((x) => x.kind === "fix" && x.fixes.some((f) => f.component === id || f.component === "*"));
      return { id, says: (t && phrase[t.template]) ?? "fails its tests from a clean checkout" };
    });
    if (many && new Set(own.map((o) => o.says)).size > 1) {
      const each = list(own.map((o) => `${o.id} ${o.says}`));
      return fit(`${each}, so agents can't check their changes there yet${share}.${readyLine}`, `${each}${share}.`);
    }
    if (blockers.has("clean.install")) {
      const why = because(input, "clean.install", their);
      return fit(`${names} ${many ? "don't" : "doesn't"} install from a clean checkout${why}, so agents can't build or test ${many ? "them" : "it"} yet.${readyLine}`, `${names} ${many ? "don't" : "doesn't"} install from a clean checkout, so agents can't build or test ${many ? "them" : "it"} yet.${readyLine}`);
    }
    if (blockers.has("clean.test:missing")) return `${names} ${many ? "have" : "has"} no tests, so agents can't check their own changes${share}.${readyLine}`;
    if (blockers.has("clean.build")) return fit(`${names} ${many ? "don't" : "doesn't"} build from a clean checkout${because(input, "clean.build", their)}${share}.${readyLine}`, `${names} ${many ? "don't" : "doesn't"} build from a clean checkout${share}.${readyLine}`);
    return fit(`Agents can't pass the tests in ${names} from a clean checkout${because(input, "clean.test", their)}${share}.${readyLine}`, `Agents can't pass the tests in ${names} from a clean checkout${share}.${readyLine}`);
  }
  const resultOf = (id: string) => {
    const evs = [...input.audit.evidence].reverse().filter((e) => e.contractId === id);
    return (evs.find((e) => e.where === "container" || e.where === "fresh_copy") ?? evs[0])?.result;
  };
  const failingKinds = [...new Set(input.audit.contract.filter((c) => (rollup.setBy.includes(c.component) || c.component === "*") && ["build", "lint", "typecheck", "test"].includes(c.kind) && resultOf(c.id) === "fail").map((c) => (c.kind === "typecheck" ? "type-check" : c.kind)))];
  const why: Partial<Record<CondId, string>> = {
    commands: failingKinds.length ? `${their} ${list(failingKinds)} ${failingKinds.length > 1 ? "commands fail" : "command fails"}` : `${their} checks don't all pass`,
    faults: `${their} tests can't yet catch wrong changes`,
    instructions: `${their} agent instructions don't match the repo`,
    safety: input.audit.safety.filter((s) => s.blocking).every((s) => s.kind === "secret") ? "a secret is committed to the repo" : "normal work needs production access",
  };
  const failing = rubric.level2.filter((c) => why[c] && rollup.setBy.some((id) => input.states.get(id)?.[c].state !== "met")).map((c) => why[c]!);
  return fit(`Agents can build and test ${names}, but ${failing.length ? list(failing) : `${their} checks can't yet catch wrong changes`}${share}.${readyLine}`, `Agents can build and test ${names}, but ${failing.length ? list(failing) : `${their} checks can't yet catch wrong changes`}${share}.`);
}

// Below Level 2 with no fix to offer, or with every condition of the next level blocked on this
// machine, means a deciding check couldn't run, not that nothing blocks.
function unproven(input: RenderInput): boolean {
  if (input.rollup.level >= 2) return false;
  if (input.top.every((t) => t.kind !== "fix")) return true;
  const caps = capReasons(input);
  return caps.length > 0 && caps.every((c) => c.state === "blocked");
}

// Why the next level couldn't be proved when this machine isn't the reason, or null when it is.
function notMachineCause(input: RenderInput): string | null {
  if (input.audit.tier === "read-only" || !input.audit.environment.containerRuntime) return null;
  const caps = capReasons(input);
  if (caps.length === 0 || caps.some((c) => c.state === "blocked")) return null;
  const reason = caps.find((c) => c.state === "unknown")?.reason;
  if (!reason) return null;
  // Part 1 carries this reason, so the audit's own words for its steps become plain ones, and a
  // reason that still holds one gives way to a plain sentence the seal will accept.
  const plain = reason.replace(/^planted faults skipped by --no-mutants$/, "this run skipped planted faults").replace(/\breplay(ed|s|ing)?\b/gi, (_m, s?: string) => (s?.toLowerCase() === "ed" ? "run" : s?.toLowerCase() === "s" ? "runs" : s?.toLowerCase() === "ing" ? "running" : "run"));
  return input.rubric.part1.bannedTerms.some((t) => plain.toLowerCase().includes(t.toLowerCase())) ? "a check that decides it didn't produce a result" : plain;
}

function because(input: RenderInput, cond: CondId, their: string): string {
  const fails = input.audit.evidence.filter((e) => e.condition === cond && e.result === "fail" && e.diagnosis);
  const d = (fails.filter((e) => input.rollup.setBy.includes(e.component ?? "")).at(-1) ?? fails.at(-1))?.diagnosis;
  if (!d) return "";
  if (d.cause === "service") return ` because ${their} tests need ${serviceLabel(d, (p) => `a service on port ${p}`)} running, which the setup doesn't start`;
  if (d.cause === "registry") return " because private registry credentials weren't provided";
  if (d.cause === "credential") return ` because it ${d.detail}`;
  if (d.cause === "unknown") return "";
  return ` because ${d.detail}`;
}

function gapText(item: RoadmapItem): string {
  return item.title.replace(/`/g, "");
}

function blocksText(item: RoadmapItem): string {
  if (item.kind !== "fix") return item.template === "targets" ? "Needs a decision" : "Can start now";
  const own = item.fixes.map((f) => f.component).find((c) => c !== "*");
  const mine = own ? item.unlocks.match(new RegExp(`(?:^|, )${own.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} to Level (\\d)`)) : null;
  if (mine) return `Blocks Level ${mine[1]} for ${own}`;
  const m = item.unlocks.match(/^(.+?) to Level (\d)/);
  if (m) return `Blocks Level ${m[2]} for ${m[1].split(",")[0]}`;
  return "Blocks the next level";
}

function stats3(input: RenderInput): ReportJson["executive"]["numbers"] {
  const { rubric, audit } = input;
  const activeIds = [...input.active];
  const ready = activeIds.filter((id) => (compLevel(input, id)?.level ?? 0) >= 2).length;
  // The third number keeps one meaning on every audit: changes in components below Level 2, the
  // bar for delegating work, so it can be compared with the first and the last audit.
  const bar = 2;
  const isUnproven = (id: string) => {
    const l = compLevel(input, id);
    return Boolean(l) && unprovenLevel1(l!.level, l!.couldBe, componentCaps(input, id));
  };
  const belowComps = input.components.filter((c) => c.assessed && input.active.has(c.id) && (compLevel(input, c.id)?.level ?? 0) < bar);
  const below = belowComps.reduce((s, c) => s + c.changeShare, 0);
  const unprovenOnly = belowComps.length > 0 && belowComps.every((c) => isUnproven(c.id));
  const someUnproven = belowComps.some((c) => isUnproven(c.id));
  const leveled = input.history.filter((h) => h.kind === "audit" && !h.noLevel && typeof h.repoLevel === "number");
  const prev = leveled[leveled.length - 1];
  const first = leveled[0];
  const days = audit.profile?.historyDays ?? 90;
  const readyThen = (h: HistoryLine) => `${h.active.filter((id) => (h.levels[id] ?? 0) >= 2).length} of ${h.active.length}`;
  const belowThen = (h: HistoryLine) => `${pct(h.active.filter((id) => (h.levels[id] ?? 0) < bar).reduce((s, id) => s + (h.shares[id] ?? 0), 0), 1)}%`;
  // Assessed components under the change-share line are left out of the count; say so next to it.
  const inactive = input.components.filter((c) => c.assessed && !input.active.has(c.id)).map((c) => c.id);
  const inactiveNote = inactive.length ? `; ${list(inactive)} ${inactive.length > 1 ? "get" : "gets"} under ${Math.round(rubric.repoLevel.activeShare * 100)}% of changes, so ${inactive.length > 1 ? "they aren't" : "it isn't"} counted` : "";
  let readyComparison = `Level 2 needs ${activeIds.length} of ${activeIds.length}`;
  let belowComparison = `Level ${bar} needs 0%, counting the last ${days} days`;
  if (prev && first && first.id !== prev.id) {
    readyComparison = `First audit: ${readyThen(first)}; last audit: ${readyThen(prev)}`;
    belowComparison = `First audit: ${belowThen(first)}; last audit: ${belowThen(prev)}, counting the last ${days} days`;
  } else if (prev) {
    readyComparison = `Last audit: ${readyThen(prev)}`;
    belowComparison = `Last audit: ${belowThen(prev)}, counting the last ${days} days`;
  }
  const o = audit.outcomes;
  const ciValue = o ? describeRate(rate(o.agent.firstTimeCiPass, o.agent.firstTimeCiKnown, rubric, windowLabel(o))) : "not measured";
  const ciComparison = o ? `${describeRate(rate(o.control.firstTimeCiPass, o.control.firstTimeCiKnown, rubric, windowLabel(o)))}, ${windowLabel(o)}` : "";
  const ci = { label: "Agent PRs that pass CI the first time", value: ciValue, comparison: o ? `Other PRs: ${ciComparison}` : "The audit needs read access to pull requests to compare agent PRs with other PRs" };
  if (noneAssessed(input)) {
    const found = input.components.length;
    return [
      { label: "Components ready for agents", value: "none assessed", comparison: `${found} ${found === 1 ? "component" : "components"} found, and ${found === 1 ? "it can't" : "none can"} be assessed yet` },
      ci,
      { label: "Recent changes this audit couldn't assess", value: `${pct(input.partial.unassessedShare, 1)}%`, comparison: `Counting the last ${days} days; a level needs at least one assessed component` },
    ];
  }
  if (notAssessed(input)) {
    const assessed = input.components.filter((c) => c.assessed);
    const share = assessed.reduce((s, c) => s + c.changeShare, 0);
    return [
      { label: "Components ready for agents", value: "none checked", comparison: `${assessed.length} of ${input.components.length} ${input.components.length === 1 ? "component" : "components"} could be assessed, but no check could run` },
      ci,
      { label: "Recent changes this audit couldn't check", value: `${pct(share + input.partial.unassessedShare, 1)}%`, comparison: `Counting the last ${days} days; a level needs at least one real check result` },
    ];
  }
  return [
    { label: "Components ready for agents", value: `${ready} of ${activeIds.length}`, comparison: readyComparison + inactiveNote },
    ci,
    {
      label: unprovenOnly ? `Recent changes in components not yet proven at Level ${bar}` : someUnproven ? `Recent changes in components below or not yet proven at Level ${bar}` : `Recent changes in components below Level ${bar}`,
      value: `${pct(below, 1)}%`,
      comparison: unprovenOnly ? `Proving Level 1 needs a clean container; counting the last ${days} days` : belowComparison,
    },
  ];
}

// Quadrants run left to right, top then bottom: low effort and high impact first.
export function quadrantOf(rubric: Rubric, x: number, y: number): string {
  const [doFirst, bigUnlocks, quickFills, later] = rubric.matrixQuadrants;
  return y >= 0.5 ? (x < 0.5 ? doFirst : bigUnlocks) : x < 0.5 ? quickFills : later;
}

function outcomeLabel(level: Level): string {
  return level === 3 ? "agent PR volume grows while the targets hold" : "agent PRs meet the team's targets";
}

function nextLine(input: RenderInput): string {
  const { rubric, rollup } = input;
  const L = rollup.level;
  if (L >= 4) return "This is the top of the scale. Keep the weekly recheck running.";
  const next = rubric.scale[L + 1];
  if (noneAssessed(input)) return `Next: Level ${L + 1}, ${next.plain}, once a component can be assessed. No condition has been checked yet.`;
  if (notAssessed(input)) return `Next: Level ${L + 1}, ${next.plain}, once a check can run. No condition has been checked yet.`;
  if (L === 3) return `Next: Level 4, ${next.plain}. ${rollup.outcomeReasons.length ? `${rollup.outcomeReasons[0].replace(/^Level 4 needs/, "It needs")}.` : "It needs agent PR volume to grow while the targets hold."}`;
  if (L >= 2) return `Next: Level ${L + 1}, ${next.plain}. It needs outcome targets your team sets and agent PRs that meet them${rollup.outcomeReasons.length ? `: ${rollup.outcomeReasons[0]}` : ""}.`;
  const conds = L === 0 ? rubric.level1 : rubric.level2;
  const met: string[] = [];
  const unmet: string[] = [];
  const blocked: string[] = [];
  for (const c of conds) {
    const failing = [...input.active].filter((id) => input.states.get(id)?.[c].state !== "met");
    const phrase = condPhrase(input, c, failing.length ? failing : [...input.active]);
    if (phrase === null) continue;
    if (failing.length === 0) {
      met.push(phrase);
      continue;
    }
    const stuck = failing.filter((id) => input.states.get(id)?.[c].state === "blocked");
    const notYet = failing.filter((id) => !stuck.includes(id));
    const name = (ids: string[]) => (rubric.conditions[c].scope === "repo" ? phrase : `${list(ids)} ${phrase}`);
    if (notYet.length) unmet.push(name(notYet));
    if (stuck.length) blocked.push(name(stuck));
  }
  return `Next: Level ${L + 1}, ${next.plain}. ${met.length ? `Met: ${list(met)}. ` : ""}${unmet.length ? `Not yet: ${list(unmet)}.` : ""}${unmet.length && blocked.length ? " " : ""}${blocked.length ? `Blocked on this machine: ${list(blocked)}.` : ""}`.trim();
}

// Part 1's own line for what the level doesn't cover, so an unassessed app or a stack the audit
// doesn't support yet is never only in the coverage footnote.
function unassessedOf(input: RenderInput): ReportJson["executive"]["unassessed"] {
  const skipped = input.components.filter((c) => !c.assessed && c.changeShare > 0).sort((a, b) => b.changeShare - a.changeShare);
  // A step the audit can't run yet, such as a build that needs a sibling package built first.
  const held = input.audit.evidence.filter((e) => e.kind !== "start" && e.kind !== "doctor" && NOT_SUPPORTED.test(blockedBy(e) ?? ""));
  const unsupported = held.length > 0 || input.components.some((c) => !c.assessed && NOT_SUPPORTED.test(c.notAssessedReason ?? ""));
  if (!skipped.length && !unsupported) return null;
  const share = skipped.reduce((s, c) => s + c.changeShare, 0);
  const shown = skipped.slice(0, 3).map((c) => `${c.id} (${pct(c.changeShare, 1)}%), because ${becauseOf(c.notAssessedReason ?? "it isn't assessed")}`);
  const more = skipped.length > 3 ? `; and ${skipped.length - 3} more` : "";
  const heldIds = [...new Set(held.map((e) => (e.component && e.component !== "*" ? e.component : "the repo")))];
  const heldText = held.length ? `${list(heldIds)} ${heldIds.length > 1 ? "have" : "has"} no proven level, because ${blockedBy(held[0])}` : "";
  // An unsupported component with no recent changes still needs its own words, or the line is empty.
  const quiet = skipped.length || held.length ? [] : input.components.filter((c) => !c.assessed && NOT_SUPPORTED.test(c.notAssessedReason ?? ""));
  const quietText = quiet.map((c) => `${c.id} (no recent changes), because ${becauseOf(c.notAssessedReason!)}`).join("; ");
  const text = [skipped.length ? `${pct(share, 1)}% of recent changes aren't assessed: ${shown.join("; ")}${more}` : "", heldText, quietText].filter(Boolean).join(". ");
  return { share: Math.round(share * 1000) / 1000, text, supportDoc: unsupported ? (input.supportDoc ?? SUPPORTED_DOC) : null };
}

function coverageLine(input: RenderInput): string {
  const { components, audit } = input;
  const assessed = components.filter((c) => c.assessed);
  const skipped = components.filter((c) => !c.assessed);
  const parts = [`The level covers ${assessed.length} ${assessed.length === 1 ? "component" : "components"}`];
  if (skipped.length) parts.push(`and ignores ${list(skipped.map((c) => `${c.id} (${pct(c.changeShare, 1)}% of changes, ${c.notAssessedReason})`))}`);
  let line = parts.join(" ") + ".";
  const threshold = input.rubric.repoLevel.activeShare;
  const share = `${Math.round(threshold * 100)}%`;
  const low = assessed.filter((c) => !input.active.has(c.id) && c.changeShare < threshold);
  const held = assessed.filter((c) => !input.active.has(c.id) && c.changeShare >= threshold);
  // The fallback is only the case where no active component reaches the line; one kept active by
  // the two-audit rule is still set by that rule.
  const activeRows = assessed.filter((c) => input.active.has(c.id));
  const fallback = activeRows.length === 1 && activeRows[0].changeShare < threshold && assessed.every((c) => c.changeShare < threshold) ? activeRows : [];
  if (low.length) line += ` ${list(low.map((c) => c.id))} ${low.length > 1 ? "get" : "gets"} under ${share} of changes, so ${low.length > 1 ? "they don't" : "it doesn't"} set the repo level.`;
  if (held.length) line += ` ${list(held.map((c) => c.id))} crossed ${share} of changes in this audit only; ${held.length > 1 ? "they set" : "it sets"} the repo level once ${held.length > 1 ? "they stay" : "it stays"} there for a second audit.`;
  if (fallback.length) line += ` No assessed component gets ${share} of changes, so the largest, ${fallback[0].id}, sets the repo level.`;
  if (input.partial.partial) line += ` Partial coverage: ${pct(input.partial.unassessedShare, 1)}% of changes aren't assessed.`;
  const sampled = sampledScope(audit);
  if (sampled) line += ` Sampled scope: ${sampled}.`;
  if (audit.tier !== "read-only" && !audit.environment.containerRuntime && audit.evidence.some((e) => e.where === "fresh_copy")) {
    const declared = audit.profile?.environmentJson?.build?.dockerfile;
    const blockedEv = audit.evidence.filter((e) => blockedBy(e) && e.diagnosis?.cause === "missing_tool");
    const missing = [...new Set(blockedEv.map((e) => e.diagnosis!.detail))];
    const inImage = [...new Set(blockedEv.filter((e) => /declared image/.test(e.blocked ?? "")).map((e) => e.diagnosis!.detail.replace(/ is not installed$/, "")))];
    line += ` Level 1 isn't provable on this machine: it has no container runtime, so setup ran in a fresh copy on the host${declared ? ` and the repo's declared environment image (.cursor/${declared}) couldn't be built` : ""}.`;
    if (missing.length) line += ` On this machine ${list(missing)}, an environment limit rather than a repo defect${inImage.length ? `; the declared image installs ${list(inImage)}` : ""}.`;
    if (audit.evidence.some((e) => /uses sudo/.test(e.blocked ?? ""))) line += " Setup commands that use sudo weren't run on this machine.";
  }
  // With no outcomes, the numbers already say agent PRs weren't measured.
  const f = audit.outcomes?.filter;
  if (f) line += ` Agent PRs are matched by ${describeFilter(f)}.`;
  return line;
}

function describeFilter(f: OutcomesSnapshot["filter"]): string {
  const parts: string[] = [];
  if (f.branchPrefixes.length) parts.push(`head branch starting with ${f.branchPrefixes.join(" or ")}`);
  if (f.labels.length) parts.push(`label ${f.labels.join(" or ")}`);
  if (f.authors.length) parts.push(`author ${f.authors.join(" or ")}`);
  if (f.coAuthorTrailers.length) parts.push(`co-author ${f.coAuthorTrailers.join(" or ")}`);
  return parts.join(", or ") || "no filter";
}

function checkResult(input: RenderInput, checkId: string): { result: string; ok: boolean | null } {
  const { audit, rubric } = input;
  const assessed = input.components.filter((c) => c.assessed);
  const byComp = (conds: CondId[]) => {
    const passed: string[] = [];
    const failed: string[] = [];
    const unproven: string[] = [];
    const blocked: string[] = [];
    for (const c of assessed) {
      const s = input.states.get(c.id)!;
      if (conds.some((k) => s[k].state === "not_met")) failed.push(c.id);
      else if (conds.some((k) => s[k].state === "blocked")) blocked.push(c.id);
      else if (conds.some((k) => s[k].state === "unknown")) unproven.push(c.id);
      else passed.push(c.id);
    }
    const parts: string[] = [];
    if (failed.length) parts.push(`failed: ${list(failed)}`);
    if (passed.length) parts.push(`passed: ${list(passed)}`);
    if (blocked.length) parts.push(`blocked on this machine: ${list(blocked)}`);
    if (unproven.length) parts.push(`not proven: ${list(unproven)}`);
    return { result: parts.join("; "), ok: failed.length ? false : unproven.length || blocked.length ? null : true };
  };
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (checkId === "scope.profile") return { result: `${plural(input.components.length, "component")} found, ${assessed.length} assessed`, ok: null };
  if (checkId === "scope.agent_assets") {
    const authors = new Set(audit.assets.flatMap((a) => a.authors.map((x) => x.name)));
    return { result: `${plural(audit.assets.length, "asset")}, ${plural(authors.size, "author")}`, ok: null };
  }
  if (checkId === "bootstrap.cold_replay") {
    const r = byComp(rubric.level1);
    const repoState = [...input.states.values()][0];
    const extra: string[] = [];
    if (repoState?.toolchain.state === "not_met") extra.push(`toolchain: ${repoState.toolchain.reason}`);
    if (repoState?.lockfile.state === "not_met") extra.push(`lockfile: ${repoState.lockfile.reason}`);
    return { result: [r.result, ...extra].filter(Boolean).join("; "), ok: extra.length ? false : r.ok };
  }
  if (checkId === "verify.canonical_interface") return byComp(["commands"]);
  if (checkId === "verify.behavioral_oracle") {
    const parts = assessed.map((c) => {
      const ev = [...audit.evidence].reverse().find((e) => e.condition === "faults" && e.component === c.id);
      return `${c.id}: ${ev ? ev.summary.replace(/ \(.*$/, "").replace(/; missed.*$/, "") : "not run"}`;
    });
    const r = byComp(["faults"]);
    return { result: parts.join("; "), ok: r.ok };
  }
  if (checkId === "context.instructions_verified") {
    const k = checkCounts(audit, checkId);
    const total = k.passed + k.failed + k.notRun;
    return { result: `${k.passed} of ${total} instruction items check out${k.failed ? `, ${k.failed} wrong` : ""}${k.notRun ? `, ${k.notRun} not run` : ""}`, ok: k.failed ? false : audit.instructions.some((i) => i.result === "not_run" && i.category === "replay") ? null : true };
  }
  if (checkId === "safety.execution_boundary") {
    const blocking = audit.safety.filter((s) => s.blocking);
    const listed = audit.safety.filter((s) => !s.blocking);
    return { result: `${blocking.length ? `failed: ${list(blocking.map((b) => b.detail))}` : "passed"}${listed.length ? `; ${listed.length} ${listed.length === 1 ? "item" : "items"} listed for review` : ""}`, ok: blocking.length === 0 };
  }
  return { result: "", ok: null };
}

export function buildReport(input: RenderInput): ReportJson {
  const { audit, rubric, roadmap, top, startNow } = input;
  const L = input.rollup.level;
  const ready = [...input.active].filter((id) => (compLevel(input, id)?.level ?? 0) >= 2 && !input.rollup.setBy.includes(id));
  const setByShare = input.components.filter((c) => input.rollup.setBy.includes(c.id)).reduce((s, c) => s + c.changeShare, 0);
  const none = notAssessed(input);
  const outcome = outcomeOf(input);
  const caps = capReasons(input);
  const noBlocker = !none && !unproven(input) && top.every((t) => t.kind !== "fix");
  const narr = audit.narration ?? {};
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  const gaps = top.map((t, i) => ({ rank: i + 1, text: (narr.gaps?.[t.id] ?? gapText(t)).trim().replace(/\.+$/, ""), blocks: t.status === "start_now" ? `Can start now; ${lower(blocksText(t))}` : blocksText(t), itemId: t.id }));
  const first = top[0];
  const skippedIds = input.components.filter((c) => !c.assessed).map((c) => c.id);
  const defaultAsk = noneAssessed(input)
    ? `Decision needed: which component this audit should cover${skippedIds.length ? `, since it can't assess ${list(skippedIds)}` : ", since it found none it supports"}.`
    : none
    ? audit.tier === "read-only"
      ? "Decision needed: whether to allow a local-exec audit, which runs the repo's commands in a container."
      : "Decision needed: where to rerun this audit so its checks can run, for example a CI job with Docker or Podman."
    : unproven(input) && notMachineCause(input)
    ? `Decision needed: how the audit can check Level ${L + 1} in ${list(capComps(input))}, since ${lower(notMachineCause(input)!)}.`
    : unproven(input)
    ? `Decision needed: where to rerun this audit so it can prove Level ${L + 1}, for example a CI job.${top.some((t) => t.status === "start_now") ? ` Meanwhile, ${lower(gapText(top.find((t) => t.status === "start_now")!))} can start now.` : ""}`
    : first?.decision
      ? `Decision needed: ${lower(first.decision)}.`
      : noBlocker
        ? "Decision needed: which work goes to agents first."
        : `Approve the agent's fix for "${gapText(first)}".`;
  let ask = (narr.ask ?? defaultAsk).trim();
  if (!/[.!?]$/.test(ask)) ask += ".";
  if (!roadmap.owner && !/\bowner\b/i.test(ask)) ask += " Also name an owner for agent readiness.";
  const actions: ReportAction[] = top.map((t, i) => action(t, i + 1, rubric, roadmap, t.status === "start_now", audit.outcomes));
  if (startNow) actions.push(action(startNow, actions.length + 1, rubric, roadmap, true, audit.outcomes));
  // From 2026-11-alpha, impact is placed against the largest action's, so the top recommendation
  // sits in the top half and is never filed under "Later" just because every share is small.
  const relative = rubric.matrixImpact === "relative";
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const maxImpact = Math.max(0, ...actions.map((a) => a.impact));
  const points = actions.map((a, i) => {
    const x = Math.round(Math.min(0.95, rubric.effortX[a.effort] + i * (relative ? 0.02 : 0.04)) * 1000) / 1000;
    // With no action moving a level on its own, the actions only unblock together, so they share
    // the top half instead of all reading as no impact.
    const together = roadmap.items.find((i) => i.id === a.itemId)?.unlocks.includes(" together with ") ?? false;
    const raw = relative ? Math.max(maxImpact > 0 ? a.impact / maxImpact : 0, together ? 0.75 : 0) : a.impact;
    const y = Math.round(clamp(raw) * 1000) / 1000;
    return { label: `${a.rank}. ${a.title}`, x, y, impact: clamp(a.impact), quadrant: quadrantOf(rubric, x, y), itemId: a.itemId };
  });
  const o = audit.outcomes;
  const w = o ? windowLabel(o) : "";
  const series = o
    ? [
        { label: "Agent PRs", s: o.agent, w },
        { label: "Other PRs", s: o.control, w },
        ...(input.previousOutcomes ? [{ label: `Agent PRs, ${input.previousOutcomes.window}`, s: input.previousOutcomes.agent, w: input.previousOutcomes.window }] : []),
      ].map((x) => ({
        label: x.label,
        opened: x.s.opened,
        merged: rate(x.s.merged, x.s.opened, rubric, x.w),
        firstTimeCi: rate(x.s.firstTimeCiPass, x.s.firstTimeCiKnown, rubric, x.w),
        changesRequested: rate(x.s.changesRequested, x.s.opened, rubric, x.w),
        medianDaysToMerge: x.s.medianDaysToMerge,
      }))
    : [];
  const prevAudits = input.history.filter((h) => h.kind === "audit");
  const allLines = [...input.history, input.currentLine];
  const progress =
    prevAudits.length > 0
      ? {
          history: allLines.map((h) => ({ date: h.date, kind: h.kind, result: h.result, note: h.note ?? null, levels: Object.fromEntries(Object.entries(h.levels ?? {}).map(([k, v]) => [k, h.noLevel || typeof v !== "number" ? null : v])), repoLevel: h.noLevel || typeof h.repoLevel !== "number" ? null : h.repoLevel, rubric: h.rubric })),
          closed: roadmap.items
            .filter((i) => i.status === "done" && i.closedAt && i.kind === "fix")
            .map((i) => ({
              title: `${i.order}. ${i.title}`,
              closed: i.closedAt as string,
              expected: `${i.expected.outcome} Watch: ${metricLabel(i.expected.watch.metric, i.expected.watch.scope)}, ${i.expected.watch.baseline}.`,
              observed: i.observed ? `${i.observed.value}${i.observed.sharedWith.length ? ` (closed with ${list(i.observed.sharedWith.map((s) => `step ${roadmap.items.find((x) => x.id === s)?.order ?? s}`))})` : ""}` : "not measurable yet: needs a full outcome window after the fix",
            })),
          weakening: input.weakening,
          rubricChanges: allLines.slice(1).filter((h, i) => h.rubric !== allLines[i].rubric).map((h, i) => ({ date: h.date, from: allLines[i].rubric, to: h.rubric })),
        }
      : null;
  const report: ReportJson = {
    schema: "agent-readiness/report@1",
    repo: audit.repo.name,
    audit: {
      id: audit.id,
      date: audit.createdAt.slice(0, 10),
      commit: audit.repo.commit.slice(0, 7),
      dirtyTree: audit.repo.dirtyTree,
      rubric: audit.rubric,
      tier: audit.tier,
      scriptsDigest: audit.skill.scriptsDigest,
      seedPinned: audit.seed.pinned,
      sealStatus: input.sealStatus,
      staleCopy: input.staleCopy,
      previous: prevAudits.length ? prevAudits[prevAudits.length - 1].id : null,
      storedAt: input.storedAt,
    },
    scale: rubric.scale,
    scenarios: (audit.scenarios ?? []).map((s) => ({ id: s.id, label: rubric.scenarios.find((x) => x.id === s.id)!.label, components: s.components })),
    maturity: {
      level: L,
      rule: `The repo level is ${rubric.repoLevel.rule}.`,
      couldBe: input.rollup.couldBe,
      couldBeReason: input.rollup.couldBe !== null ? "a check that would decide it couldn't run here" : null,
      setBy: input.rollup.setBy,
      partialCoverage: input.partial.partial,
      assessedComponents: input.components.filter((c) => c.assessed).length,
      outcome,
      confidence: confidenceOf(input, outcome),
      capReasons: caps,
      unproven: !none && unprovenLevel1(L, input.rollup.couldBe, caps),
      next: L < 4 ? { level: (L + 1) as Level, name: rubric.scale[L + 1].name, met: [], unmet: [] } : null,
    },
    components: componentsOf(input),
    executive: {
      heading: noneAssessed(input)
        ? "Not assessed: none of the components found can be assessed yet"
        : none
          ? `Not assessed: ${audit.tier === "read-only" ? "the read-only tier runs no repo code" : "no check could run on this machine"}`
          : !none && unprovenLevel1(L, input.rollup.couldBe, caps)
            ? unprovenHeading(caps)
            : `Level ${L} of 4, ${rubric.scale[L].plain}${outcome === "blocked" ? `; Level ${L + 1} is blocked on this machine` : ""}`,
      headline: narr.headline ?? headlineFor(input, ready, setByShare),
      numbers: stats3(input),
      nextLine: nextLine(input),
      gaps,
      ask,
      coverage: coverageLine(input),
      noBlocker,
      unassessed: unassessedOf(input),
    },
    actions,
    matrix: { quadrants: rubric.matrixQuadrants, points },
    roadmap: {
      owner: roadmap.owner,
      doneCount: roadmap.items.filter((i) => i.status === "done").length,
      total: roadmap.items.length,
      items: roadmap.items.map((i) => {
        // Several steps can be next at once; only the first says so, the others say which one they run alongside.
        const firstNext = roadmap.items.find((x) => x.status === "next");
        const text = i.status === "next" && firstNext && firstNext.id !== i.id ? `next, alongside step ${firstNext.order}` : statusText(i, roadmap);
        return { id: i.id, order: i.order, title: i.title, status: i.status, statusText: text, unlocks: i.unlocks, decision: i.decision, level: itemLevel(rubric, i) };
      }),
    },
    progress,
    details: {
      steps: actions.map((a) => ({ itemId: a.itemId, title: a.title, steps: roadmap.items.find((i) => i.id === a.itemId)!.steps })),
      checks: rubric.checks.map((c) => {
        const r = checkResult(input, c.id);
        if (c.id === "verify.canonical_interface") {
          const ids = new Set([...input.states.values()].flatMap((s) => s.commands.evidence));
          const evs = audit.evidence.filter((e) => ids.has(e.id));
          const counts = { passed: evs.filter((e) => e.result === "pass").length, failed: evs.filter((e) => e.result === "fail").length, notRun: evs.filter((e) => e.result === "not_run").length };
          return { id: c.id, name: c.title, why: c.why, sources: c.sources, result: r.result, ok: r.ok, counts, evidence: evs.map((e) => e.id) };
        }
        return { id: c.id, name: c.title, why: c.why, sources: c.sources, result: r.result, ok: r.ok, counts: checkCounts(audit, c.id), evidence: audit.evidence.filter((e) => e.checkId === c.id).map((e) => e.id) };
      }),
      notAssessed: rubric.notAssessed,
      levelRules: {
        level1: `Level 1 needs: ${list(rubric.level1.map((c) => condLabel(rubric, c)))}`,
        level2: `Level 2 needs: ${list(rubric.level2.map((c) => condLabel(rubric, c)))}`,
        scenarios: rubric.scenarios.filter((s) => (audit.scenarios ?? []).some((x) => x.id === s.id)).map((s) => ({ id: s.id, label: s.label, bar: `Level 2 needs: ${list(s.level2.map((c) => condLabel(rubric, c)))}` })),
      },
      outcomes: o
        ? {
            window: w,
            filter: describeFilter(o.filter),
            source: o.source === "gh" ? "GitHub through gh" : "a recorded PR file",
            series,
            byComponent: input.components
              .filter((c) => c.assessed)
              .map((c) => {
                const s = o.byComponent[c.id];
                return { component: c.id, prs: s?.opened ?? 0, firstTimeCi: rate(s?.firstTimeCiPass ?? 0, s?.firstTimeCiKnown ?? 0, rubric, w), changesRequested: rate(s?.changesRequested ?? 0, s?.opened ?? 0, rubric, w) };
              }),
            multiComponentNote: o.multiComponentPrs ? `${o.multiComponentPrs} agent ${o.multiComponentPrs === 1 ? "PR" : "PRs"} touched more than one component, so the component rows can add up to more than the total.` : "No agent PR touched more than one component.",
            matchedPrs: o.matchedAgentPrs,
            caveat: input.previousOutcomes ? "A trend, not attribution. Model updates or a different mix of tasks could account for part of the change." : "A baseline, not proof that readiness explains these numbers. Model updates and the mix of tasks move them too.",
          }
        : null,
      assets: audit.assets.map((a: Asset) => ({ kind: a.kind, path: a.path, authors: a.authors.map((x) => x.name), lastChanged: a.lastChanged, status: a.status, ok: a.ok })),
      missingAssets: missingList(audit.assets),
      signals: audit.signals ?? [],
      evidence: audit.evidence.map((e) => {
        const blocked = blockedBy(e);
        return {
          id: e.id,
          check: e.checkId,
          component: e.component && e.component !== "*" ? e.component : null,
          ran: e.command ?? e.summary,
          where: e.result === "not_run" ? "not run" : rubric.strengthLabels[e.strength],
          result: blocked ? "blocked" : e.result,
          summary: blocked && e.result === "fail" ? `${e.kind ?? "step"} blocked: ${blocked}` : blocked && !e.summary.includes(blocked) ? `${e.summary}; blocked: ${blocked}` : e.summary,
        };
      }),
      record: [
        { label: "Audit", value: audit.id },
        { label: "Commit", value: `${audit.repo.commit.slice(0, 7)}${audit.repo.dirtyTree ? " (uncommitted changes were not audited)" : " (clean tree)"}` },
        { label: "Rubric", value: audit.rubric },
        { label: "Permission tier", value: audit.tier },
        { label: "Seal", value: input.sealStatus },
        { label: "Skill digest", value: audit.skill.scriptsDigest.slice(0, 12) },
        { label: "Planted faults", value: plantedFaultsRecord(audit) },
        {
          label: "Replay environment",
          value: audit.environment.containerRuntime
            ? `${audit.environment.containerRuntime} container, ${audit.environment.image}`
            : audit.evidence.some((e) => e.where === "fresh_copy" || e.where === "container")
              ? "fresh copy on the host (no container runtime)"
              : `none: no repo command ran${noneAssessed(input) ? ", because no component could be assessed" : ""}`,
        },
        { label: "Stored in", value: input.storedAt },
      ],
    },
  };
  if (report.progress) report.progress.changes = input.previousReport ? changesOf(input.previousReport, report, rubric) : null;
  report.notices = noticesOf(input);
  return report;
}

// Only what the reader should act on reaches page 1, phrased as the action. An eval seed, a recorded
// PR file and an unkeyed seal need no action from a reader and stay in "About this report".
function noticesOf(input: RenderInput): { text: string }[] {
  const { audit } = input;
  const out: string[] = [];
  const release = input.sealStatus.match(/differ from release (\S+?);/)?.[1];
  if (release) out.push(`This audit ran with scripts that differ from the released skill (${release}), so it isn't a released result. Reinstall the released skill and rerun the audit.`);
  else if (input.sealStatus.startsWith("Seal not verified: no release manifest")) out.push("This copy of the skill ships no release manifest, so its scripts can't be checked against a release. Install a released copy and rerun the audit.");
  if (input.staleCopy) out.push(`${input.staleCopy} Update the installed skill and rerun the audit.`);
  if (audit.tier === "read-only") out.push("This audit ran at the read-only tier, so it ran no repo command. Rerun it with --tier local-exec to get a level.");
  else if (!audit.environment.containerRuntime && audit.evidence.some((e) => e.where === "fresh_copy")) out.push("This audit ran without a container runtime, so Level 1 is unproven. Install Docker or Podman, or run it in CI, and rerun the audit.");
  if (audit.repo.dirtyTree) out.push("Uncommitted changes weren't audited. Commit them and rerun the audit to include them.");
  return out.map((text) => ({ text }));
}

// What changed since the previous audit, read from its sealed report and this one only.
export function changesOf(prev: ReportJson, now: ReportJson, rubric: Rubric): ReportChanges {
  const repoLevel = (r: ReportJson) => (r.maturity.outcome === "not_assessed" ? null : r.maturity.level);
  const levels = (r: ReportJson) => new Map(r.components.included.map((c) => [c.id, c.level] as [string, Level | null]));
  const before = levels(prev);
  const after = levels(now);
  const ids = [...new Set([...before.keys(), ...after.keys()])];
  const components = ids.map((id) => ({ id, from: before.get(id) ?? null, to: after.get(id) ?? null })).filter((c) => c.from !== c.to);
  // The level a condition is needed for: a failing Level 1 condition only regresses a component that had reached Level 1.
  const condLevel = (c: string) => (rubric.level1.includes(c as CondId) ? 1 : rubric.level2.includes(c as CondId) ? 2 : 3);
  const caps = (r: ReportJson) => new Map(r.components.included.flatMap((c) => c.capReasons.map((k) => [`${c.id}\u0000${k.condition}`, { component: c.id, condition: k.condition, label: k.label, reason: k.reason, state: k.state }] as const)));
  const was = caps(prev);
  const is = caps(now);
  const held = (id: string) => (after.get(id) ?? -1) >= (before.get(id) ?? 0);
  const nowMet = [...was.entries()].filter(([k, v]) => !is.has(k) && after.get(v.component) != null && held(v.component)).map(([, v]) => ({ component: v.component, label: v.label }));
  const nowFailing = [...is.entries()].filter(([k, v]) => !was.has(k) && v.state === "not_met" && (before.get(v.component) ?? -1) >= condLevel(v.condition)).map(([, v]) => ({ component: v.component, label: v.label, reason: v.reason }));
  const okBefore = new Map(prev.details.checks.map((c) => [c.id, c.ok]));
  const checks = now.details.checks.filter((c) => okBefore.has(c.id) && okBefore.get(c.id) !== c.ok && (okBefore.get(c.id) === false || c.ok === false)).map((c) => ({ id: c.id, name: c.name, from: okBefore.get(c.id) ?? null, to: c.ok }));
  return { since: { audit: prev.audit.id, date: prev.audit.date }, repo: { from: repoLevel(prev), to: repoLevel(now) }, components, nowMet, nowFailing, checks };
}

function plantedFaultsRecord(audit: Audit): string {
  const faults = audit.evidence.filter((e) => e.condition === "faults");
  if (faults.length > 0 && faults.every((e) => e.skipped)) return `not planted: ${faults[0].skipped} skipped them, so no fault check ran`;
  return audit.seed.pinned ? "seed pinned (eval run; not a production result)" : "fresh seed for this audit";
}

// Held at Level 0 only because this machine couldn't check Level 1: nothing that ran failed.
// Every Level 1 condition left is blocked here, and a blocked step may have run (a build cut off by
// the network), so the heading says none failed rather than that every one that ran passed.
export function unprovenHeading(caps: { condition: string; state: string }[]): string {
  const n = new Set(caps.filter((c) => c.state === "blocked").map((c) => c.condition)).size;
  return `Level 1 unproven on this machine: no Level 1 check failed, and ${n} ${n === 1 ? "was" : "were"} blocked here`;
}

export function unprovenLevel1(level: Level | null, couldBe: Level | null, caps: { state: string }[]): boolean {
  return level === 0 && couldBe === 1 && caps.length > 0 && caps.every((c) => c.state === "blocked");
}

function componentCaps(input: RenderInput, id: string): ComponentLevel["capReasons"] {
  const l = compLevel(input, id);
  if (!l || notAssessed(input)) return [];
  if (l.level >= 2) return l.level < 4 ? l.outcomeReasons.map((r) => ({ component: id, condition: "outcomes", label: outcomeLabel(l.level), state: "not_met" as const, reason: r })) : [];
  const conds = l.level === 0 ? input.rubric.level1 : input.rubric.level2;
  return conds.flatMap((c) => {
    const s = input.states.get(id)?.[c];
    return s && s.state !== "met" ? [{ component: id, condition: c, label: condLabel(input.rubric, c), state: s.state, reason: s.reason }] : [];
  });
}

// Tier 2 and tier 3: every component found, its standard level, and the scenarios added for it.
function componentsOf(input: RenderInput): ReportJson["components"] {
  const comps = input.components;
  const none = notAssessed(input);
  const row = (c: Component) => ({ id: c.id, path: c.path, toolchain: c.toolchain ?? toolchainOf(c), manifest: c.manifest, lockfile: c.lockfile ?? null, changeShare: c.changeShare });
  const sampled = comps.some((c) => c.notAssessedReason?.startsWith("outside the "));
  return {
    shape: sampled ? "sampled_monorepo" : input.audit.profile?.repoType === "monorepo" ? "monorepo" : "single",
    included: comps
      .filter((c) => c.assessed)
      .map((c) => {
        const l = compLevel(input, c.id);
        const caps = componentCaps(input, c.id);
        const level = none || !l ? null : l.level;
        const couldBe = none || !l ? null : l.couldBe;
        const unproven = unprovenLevel1(level, couldBe, caps);
        const scenarios = [...(input.scenarioLevels.get(c.id) ?? new Map<ScenarioId, LevelResult>()).entries()].map(([sid, s]) => ({ id: sid, label: input.rubric.scenarios.find((x) => x.id === sid)!.label, level: none ? null : s.level, couldBe: none ? null : s.couldBe, unproven: unproven && s.level === 0 && s.couldBe === 1 }));
        return { ...row(c), active: input.active.has(c.id), level, couldBe, unproven, capReasons: caps, scenarios };
      }),
    excluded: [
      ...comps.filter((c) => !c.assessed).map((c) => ({ ...row(c), reason: c.notAssessedReason ?? "not assessed" })),
      ...(input.audit.profile?.satellites ?? []).map((s) => ({ id: s.path.split("/").pop()!, path: s.path, toolchain: s.toolchain, manifest: s.manifest, lockfile: null, changeShare: 0, reason: `not a component: ${s.reason}` })),
    ],
  };
}

function toolchainOf(c: Component): string {
  return c.language === "py" ? "Python" : c.language === "ts" ? "TypeScript" : c.language === "js" ? "Node" : "unknown";
}

function missingList(assets: Asset[]): string[] {
  const missing: string[] = [];
  if (!assets.some((a) => a.kind === "agents_md")) missing.push("an AGENTS.md");
  if (!assets.some((a) => a.kind === "environment")) missing.push("an environment setup");
  if (!assets.some((a) => a.kind === "skill")) missing.push("skills");
  if (!assets.some((a) => a.kind === "hooks")) missing.push("hooks");
  return missing;
}

export function validatePart1(report: ReportJson, rubric: Rubric, narratedAllowedNumbers: Set<string> | null): string[] {
  const errors: string[] = [];
  const ex = report.executive;
  if (wordCount(ex.headline) > rubric.part1.maxHeadlineWords) errors.push(`headline has ${wordCount(ex.headline)} words; the limit is ${rubric.part1.maxHeadlineWords}`);
  if (ex.gaps.length > rubric.part1.maxGaps) errors.push(`part 1 has ${ex.gaps.length} gaps; the limit is ${rubric.part1.maxGaps}`);
  for (const g of ex.gaps) if (wordCount(g.text) > rubric.part1.maxGapWords) errors.push(`gap "${g.text}" has more than ${rubric.part1.maxGapWords} words`);
  const fields: [string, string][] = [
    ["heading", ex.heading],
    ["headline", ex.headline],
    ["nextLine", ex.nextLine],
    ["ask", ex.ask],
    ["coverage", ex.coverage],
    ...(ex.unassessed ? [["not assessed line", ex.unassessed.text] as [string, string]] : []),
    ...ex.gaps.map((g) => ["gap", g.text] as [string, string]),
    ...ex.numbers.flatMap((n) => [["number label", n.label], ["number", n.value], ["comparison", n.comparison]] as [string, string][]),
  ];
  for (const [name, text] of fields) {
    if (text.includes("`")) errors.push(`${name} uses code formatting`);
    if (EMOJI.test(text)) errors.push(`${name} uses an emoji; say the status in words`);
    if (/\bev-\d+/.test(text)) errors.push(`${name} cites an evidence id`);
    if (/\b(bootstrap|verify|context|safety|scope)\.[a-z_]+/.test(text)) errors.push(`${name} names a check id`);
    for (const term of rubric.part1.bannedTerms) if (text.toLowerCase().includes(term.toLowerCase())) errors.push(`${name} uses the banned term "${term}"`);
    let masked = text;
    for (const lvl of [...rubric.part1.levelNames].sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`\\b${lvl}\\b`, "gi");
      for (const m of [...masked.matchAll(re)]) {
        const before = masked.slice(0, m.index);
        if (!/Level [0-4](?: of 4)?, $/i.test(before)) errors.push(`${name} uses the level name "${lvl}" without its level number`);
      }
      masked = masked.replace(re, (s) => "#".repeat(s.length));
    }
  }
  if (narratedAllowedNumbers) {
    const narrated = [ex.headline, ex.ask, ...ex.gaps.map((g) => g.text)];
    for (const t of narrated) for (const m of t.matchAll(/\d+(?:\.\d+)?%?/g)) if (!narratedAllowedNumbers.has(m[0])) errors.push(`"${m[0]}" in the narrated text isn't a number the audit computed`);
    // Only a component at Level 2 or above is ready for agents, so a narrated headline can't say
    // otherwise about one below it.
    for (const c of report.components.included) {
      if (c.level === null || c.level >= 2) continue;
      const id = c.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const claim = new RegExp(`\\b${id}\\b[^.;:]{0,40}?\\b(?:is|are)\\s+(?:already\\s+)?(?:ready|at Level [2-4]|verifiable|delegable)\\b`, "i");
      if (claim.test(ex.headline)) errors.push(`the headline calls ${c.id} ready, but ${c.id} is at Level ${c.level}; only a component at Level 2 or above is ready for agents`);
    }
  }
  return errors;
}

export function danglingEvidence(report: ReportJson, audit: Audit): string[] {
  const known = new Set(audit.evidence.map((e) => e.id));
  const cited = new Set([...JSON.stringify(report).matchAll(/\bev-\d{3,}\b/g)].map((m) => m[0]));
  return [...cited].filter((id) => !known.has(id)).sort();
}

// Every number the audit itself reports, from the parts of the report narration doesn't write
// (the headline, ask, gaps and titles are left out).
export function allowedNumbers(report: ReportJson): Set<string> {
  const set = new Set<string>();
  const ex = report.executive;
  const computed = {
    numbers: ex.numbers,
    nextLine: ex.nextLine,
    coverage: ex.coverage,
    unassessed: ex.unassessed,
    maturity: report.maturity,
    components: report.components,
    actions: report.actions.map(({ title: _title, ...rest }) => rest),
    roadmap: report.roadmap.items.map((i) => [i.unlocks, i.statusText]),
    progress: report.progress,
    checks: report.details.checks.map((c) => [c.result, c.counts]),
    evidence: report.details.evidence.map((e) => e.summary),
    outcomes: report.details.outcomes,
  };
  for (const m of JSON.stringify(computed).matchAll(/\d+(?:\.\d+)?%?/g)) set.add(m[0]);
  for (const c of report.components.included) set.add(`${Math.round(c.changeShare * 100)}%`);
  for (const a of report.actions) if (a.impact > 0) set.add(`${Math.round(a.impact * 100)}%`);
  const setBy = report.components.included.filter((c) => report.maturity.setBy.includes(c.id)).reduce((s, c) => s + c.changeShare, 0);
  if (setBy > 0) set.add(`${Math.round(setBy * 100)}%`);
  for (let i = 0; i <= 4; i++) set.add(String(i));
  return set;
}

function levelWord(rubric: Rubric, l: number): string {
  return `${l} ${rubric.scale[l].name}`;
}

export function scaleLine(r: ReportJson): string {
  const here = r.maturity.assessedComponents === 0 || r.maturity.outcome === "not_assessed" || r.maturity.unproven ? null : r.maturity.level;
  return r.scale.map((s) => (s.level === here ? `[Level ${s.level} ${s.name}]` : `Level ${s.level} ${s.name}`)).join(" > ");
}

// The level the report can mark on the scale, or null when it can't prove one.
export function markedLevel(r: ReportJson): Level | null {
  return r.maturity.assessedComponents === 0 || r.maturity.outcome === "not_assessed" || r.maturity.unproven ? null : r.maturity.level;
}

// Part 1's compact ladder: the scale left to right, with the repo's level bracketed.
export function ladderLine(r: ReportJson): string {
  const here = markedLevel(r);
  const steps = r.scale.map((s) => (s.level === here ? `**[${s.level} ${s.name}]**` : `${s.level} ${s.name}`)).join(" → ");
  return `Level ladder: ${steps}${here === null ? " (no level marked: this audit couldn't give one)" : ""}`;
}

// Levels 3 and 4 rest on agent PR outcomes, which this version tests only in unit tests.
export const EXPERIMENTAL_NOTE = "Levels 3 and 4 are experimental: they measure agent PR outcomes, and this version doesn't yet validate them end to end. Level 2 is the proven top of this version.";

export function isExperimental(level: Level | null | undefined): boolean {
  return level !== null && level !== undefined && level >= 3;
}

// The roadmap's own number for a step, so an action and its roadmap line carry the same number.
export function stepOf(r: ReportJson, itemId: string): number | null {
  return r.roadmap.items.find((i) => i.id === itemId)?.order ?? null;
}

// What the marked level means and what the next one needs, so "not bootable" never stands alone
// next to a headline that says the repo installs and builds.
export function levelDefinition(r: ReportJson): string | null {
  const here = markedLevel(r);
  if (here === null) return null;
  const meaning = r.scale[here].meaning.replace(/\.$/, "");
  const next = here === 0 ? r.details.levelRules.level1 : here === 1 ? r.details.levelRules.level2 : here < 4 ? `Level ${here + 1} (experimental) needs: ${r.scale[here + 1].meaning.charAt(0).toLowerCase()}${r.scale[here + 1].meaning.slice(1).replace(/\.$/, "")}` : null;
  return `Level ${here} means: ${meaning.charAt(0).toLowerCase()}${meaning.slice(1)}.${next ? ` ${next}.` : ""}`;
}

// Page 1's three numbers, compared with what the next level needs. The sealed comparisons stay in
// report.json and in part 5; only the view's wording changes.
export function pageNumbers(r: ReportJson): ReportJson["executive"]["numbers"] {
  const here = markedLevel(r);
  return r.executive.numbers.map((n, i) => {
    if (n.value === "not measured") return { ...n, comparison: "Not measured yet: give the audit read access to pull requests, then rerun it to measure this" };
    if (here !== null && here >= 2 && i === 0) return { ...n, comparison: "Every active component is at Level 2. Level 3 (experimental) is measured on agent PRs, not components" };
    if (here !== null && here >= 2 && i === 2) return { ...n, comparison: "Nothing is below Level 2. Level 3 (experimental) needs agent PRs that meet targets your team sets" };
    // With history the sealed comparison is against past audits; page 1 leads with what Level 2 needs.
    const last = n.comparison.match(/last audit: ([^;.,]+)/i)?.[1];
    if (!last) return n;
    const total = n.value.match(/^\d+ of (\d+)$/)?.[1];
    if (i === 0 && total) return { ...n, comparison: `Level 2 needs ${total} of ${total}; last audit: ${last}` };
    if (i === 2 && /%$/.test(n.value)) return { ...n, comparison: `Level 2 needs 0%; last audit: ${last}, counting the last 90 days` };
    return n;
  });
}

// The first action, as page 1's next move: what it unlocks, its effort and owner, and the decision.
export function nextMove(r: ReportJson): { step: number | null; title: string; unlocks: string; effort: string; decision: string | null; itemId: string; experimental: boolean } | null {
  const a = r.actions[0];
  if (!a) return null;
  const item = r.roadmap.items.find((i) => i.id === a.itemId);
  return { step: stepOf(r, a.itemId), title: a.title, unlocks: a.movesTheNeedle, effort: a.effortAndOwner, decision: a.decision, itemId: a.itemId, experimental: isExperimental(item?.level) };
}

// "Give agents work in alpha", "… in bravo" and so on read as one step for the reader.
export function groupedSteps(items: ReportJson["roadmap"]["items"]): { orders: number[]; title: string; unlocks: string; statusText: string; done: boolean }[] {
  const out: { orders: number[]; title: string; unlocks: string; statusText: string; done: boolean }[] = [];
  const work = items.filter((i) => /^Give agents work in /.test(i.title));
  for (const i of items) {
    if (work.length > 1 && work.includes(i)) {
      if (i !== work[0]) continue;
      const names = work.map((w) => w.title.replace(/^Give agents work in /, ""));
      const statuses = [...new Set(work.map((w) => w.statusText))];
      out.push({ orders: work.map((w) => w.order), title: `Give agents work in ${list(names)}`, unlocks: `measured agent work in ${list(names)}`, statusText: statuses.join(" / "), done: work.every((w) => w.status === "done") });
    } else out.push({ orders: [i.order], title: i.title, unlocks: i.unlocks, statusText: i.statusText, done: i.status === "done" });
  }
  return out;
}

const SPARK = ["▁", "▂", "▄", "▆", "█"];

// One glyph per record, taller for a higher level; a dot where a record gave no level.
export function sparkline(levels: (Level | null | undefined)[]): string {
  return levels.map((l) => (l === null || l === undefined ? "·" : SPARK[l])).join("");
}

function recordLabel(h: { date: string; kind: string; result: string }, level: Level | null | undefined): string {
  const what = level === null || level === undefined ? "no level" : `Level ${level}`;
  return `${fmtShortDate(h.date)} ${what}${h.kind === "recheck" ? ` (recheck${h.result === "failed" ? ", failed" : ""})` : ""}`;
}

// The repo level at every audit and recheck, oldest first.
export function trendLine(r: ReportJson): string {
  const h = r.progress?.history ?? [];
  if (h.length < 2) return "Trend: this is the first audit, so there is no trend yet.";
  return `Trend: ${sparkline(h.map((x) => x.repoLevel))} ${h.map((x) => recordLabel(x, x.repoLevel)).join(" → ")}`;
}

function componentTrend(r: ReportJson, id: string): string {
  const h = r.progress?.history ?? [];
  return h.length < 2 ? "first audit" : sparkline(h.map((x) => x.levels[id]));
}

function miniLadder(level: Level | null): string {
  return [0, 1, 2, 3, 4].map((l) => (l === level ? "●" : "○")).join("");
}

function supportLink(doc: string | null): string {
  if (!doc) return "";
  // report.md sits in .agent-readiness/latest/, two folders below the repo root.
  return doc.startsWith("references/") ? ` What the audit supports: ${doc} in the agent-readiness skill.` : ` What the audit supports: [supported.md](../../${doc}).`;
}

function levelText(l: Level | null): string {
  return l === null ? "no level" : `Level ${l}`;
}

// The provenance and eval-mode lines that need no action from a reader; they close the report.
function aboutLines(r: ReportJson): string[] {
  const fromFile = r.details.outcomes !== null && r.details.outcomes.source !== "GitHub through gh";
  const lines: string[] = [];
  if (r.audit.seedPinned) lines.push("Eval run with a pinned seed; not a production result.");
  if (fromFile) lines.push("Outcomes come from a recorded PR file, not GitHub; not a production result.");
  lines.push(`${r.audit.sealStatus}.`);
  if (r.audit.staleCopy) lines.push(r.audit.staleCopy);
  return lines;
}

function keyNote(r: ReportJson): string | null {
  return /unkeyed/.test(r.audit.sealStatus) ? "For signed reports, set SA_READINESS_SEAL_KEY from a CI secret where the audit runs." : null;
}

// One line on what changed since the last audit, or null on a first audit.
export function changeSummary(r: ReportJson): string | null {
  const ch = r.progress?.changes;
  if (!ch) return null;
  const since = fmtShortDate(ch.since.date);
  const { from, to } = ch.repo;
  const move = from === to ? `Unchanged since ${since}` : from !== null && to !== null && to > from ? `Up from Level ${from} since ${since}` : from !== null && to !== null ? `Down from Level ${from} since ${since}` : `Changed since ${since}`;
  const closed = r.progress!.closed.length;
  return `${move}${closed ? `; ${closed} ${closed === 1 ? "step" : "steps"} closed` : ""}`;
}

// Page 1 names the reason; the missed-fault locations stay in the audit details.
export function shortReason(reason: string): string {
  return reason.split("; missed:")[0];
}

// What holds a component where it is, and the roadmap step that moves it.
function holdsText(r: ReportJson, c: ReportJson["components"]["included"][number]): string {
  if (c.level !== null && c.level >= 2) return "ready for agents";
  const cap = c.capReasons.find((k) => k.state !== "met");
  const item = r.roadmap.items.find((i) => i.status !== "done" && new RegExp(`(^|, )${c.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} to Level`).test(i.unlocks));
  return `${cap ? `${cap.label}: ${shortReason(cap.reason)}`.replace(/\|/g, "\\|") : ""}${item ? ` (step ${item.order})` : ""}`;
}

export function renderMarkdown(r: ReportJson, rubric: Rubric): string {
  const out: string[] = [];
  const ex = r.executive;
  const conf = r.maturity.confidence;
  const noResults = r.maturity.outcome === "not_assessed";
  out.push(`# Agent readiness: ${r.repo}`, "");
  for (const n of r.notices ?? []) out.push(`> **Action needed:** ${n.text}`, "");

  // Page 1: where the repo stands, what changed and what to do next. Measures, methodology and
  // provenance are in part 5 and "About this report".
  out.push("## 1. Where am I now", "", `**${ex.heading}.**${changeSummary(r) ? ` ${changeSummary(r)}.` : ""}`, "", `**${ex.headline}**`, "");
  const move = nextMove(r);
  out.push(move ? `> **Next move${move.step !== null ? `, step ${move.step}` : ""}:** ${move.title}${move.experimental ? " (experimental)" : ""}. ${move.unlocks} Effort and owner: ${move.effort}${move.decision ? ` Decision: ${move.decision}.` : ""}` : `> **Next move:** ${ex.ask}`, "");
  out.push(ladderLine(r), "", `${levelDefinition(r) ?? "No level is marked: this audit couldn't give one."} ${EXPERIMENTAL_NOTE}`, "");
  if ((r.progress?.history.length ?? 0) > 2) out.push(trendLine(r), "");
  for (const n of pageNumbers(r)) out.push(`- **${n.label}:** ${n.value}. ${n.comparison}.`);
  out.push("");
  const comps = r.components;
  const listed = comps.excluded.filter((c) => !c.reason.startsWith("not a component"));
  if (comps.included.length + listed.length > 1) {
    out.push("| Component | Level | Ladder 0 to 4 | Share of changes | Trend | What holds it |", "|---|---|---|---|---|---|");
    for (const c of [...comps.included].sort((a, b) => b.changeShare - a.changeShare)) {
      const level = c.unproven ? "Level 1 unproven here" : levelText(c.level);
      out.push(`| \`${c.id}\` | ${level} | ${c.unproven ? miniLadder(null) : miniLadder(c.level)} | ${Math.round(c.changeShare * 100)}%${c.active ? "" : " (under 10%)"} | ${componentTrend(r, c.id)} | ${holdsText(r, c)} |`);
    }
    for (const c of listed) out.push(`| \`${c.id}\` | not assessed: ${c.reason} | | ${Math.round(c.changeShare * 100)}% | | |`);
    out.push("", "Share of changes: the component's share of changed files over the last 90 days.", "");
  }
  if (ex.unassessed) out.push(`- **Not assessed:** ${ex.unassessed.text}.${supportLink(ex.unassessed.supportDoc)}`, "");

  out.push("## 2. Have I improved", "");
  if (!r.progress) out.push("This is the first audit, so there is nothing to compare yet. Rerun the audit after your first fix to see what changed here.", "");
  else {
    const ch = r.progress.changes;
    if (ch) {
      out.push(`Since the audit on ${fmtDate(ch.since.date)}:`, "");
      out.push(`- **Repo level:** ${levelText(ch.repo.from)} to ${levelText(ch.repo.to)}${ch.repo.from === ch.repo.to ? ", no change" : ""}.`);
      for (const c of ch.components) out.push(`- **${c.id}:** ${levelText(c.from)} to ${levelText(c.to)}.`);
      if (ch.nowMet.length) out.push(`- **Now met:** ${ch.nowMet.map((m) => `${m.component}: ${m.label}`).join("; ")}.`);
      if (ch.nowFailing.length) out.push(`- **Now failing:** ${ch.nowFailing.map((m) => `${m.component}: ${m.label} (${m.reason})`).join("; ")}.`);
      const word = (ok: boolean | null) => (ok === true ? "passed" : ok === false ? "failed" : "not proven");
      if (ch.checks.length) out.push(`- **Checks that changed:** ${ch.checks.map((c) => `${c.name}, ${word(c.from)} then ${word(c.to)}`).join("; ")}.`);
      if (!ch.components.length && !ch.nowMet.length && !ch.nowFailing.length && !ch.checks.length) out.push("- No component level, condition or check changed.");
    } else out.push("The previous audit's sealed report isn't readable here, so only the levels in part 5 are compared.");
    if (r.progress.closed.length) out.push(`- **Steps closed:** ${r.progress.closed.map((c) => `${c.title} (${fmtShortDate(c.closed)})`).join("; ")}. Part 5 shows what moved after them.`);
    out.push("");
  }

  out.push("## 3. What moves the needle next", "", `> **Recommendation:** ${ex.ask}`, "", ex.nextLine, "");
  if (ex.gaps.length) {
    for (const g of ex.gaps) out.push(`${g.rank}. **${g.text}.** ${g.blocks}.`);
    out.push("");
  }
  r.actions.forEach((a, i) => {
    const item = r.roadmap.items.find((x) => x.id === a.itemId);
    out.push(`### Step ${stepOf(r, a.itemId) ?? a.rank}: ${a.title} (${a.startNow ? "can start now" : i === 0 ? "do first" : "then"}${isExperimental(item?.level) ? ", experimental" : ""})`, "");
    out.push(`- **How it moves the needle:** ${a.movesTheNeedle}`, `- **Why it matters:** ${a.why}`, `- **Effort and owner:** ${a.effortAndOwner}`);
    if (a.decision) out.push(`- **Decision needed:** ${a.decision}.`);
    if (a.dependsOn.length) out.push(`- **Depends on:** ${list(a.dependsOn)}`);
    if (a.evidence?.length) out.push(`- **Evidence:** ${a.evidence.map((e) => `\`${e}\``).join(", ")}`);
    out.push("");
  });
  if (r.actions.length === 0) out.push(r.maturity.assessedComponents === 0 ? "No actions can be planned yet: no component could be assessed, so nothing was checked. Part 1 says why." : noResults ? "No actions can be planned yet: this audit has no real check results to plan from. Part 1 says why." : r.maturity.outcome === "blocked" ? `No actions are open: nothing in the repo blocks Level ${r.maturity.level + 1}. Proving it needs a rerun where this machine's limits don't apply, such as CI with Docker or Podman.` : "No actions are open.", "");

  out.push("## 4. Roadmap to the max level", "");
  if (noResults) out.push("This audit added no steps, because it has no real check results to plan from. The roadmap is as the last audit left it.", "");
  out.push(`${r.roadmap.doneCount} of ${r.roadmap.total} steps done. Kept in \`.agent-readiness/roadmap.json\`.${r.roadmap.owner ? ` Owner: ${r.roadmap.owner}.` : ""}`, "");
  const here = markedLevel(r);
  const step = (g: ReturnType<typeof groupedSteps>[number]) => `- [${g.done ? "x" : " "}] ${g.orders.length > 1 ? `Steps ${g.orders[0]} to ${g.orders[g.orders.length - 1]}` : `Step ${g.orders[0]}`}: ${g.title}: unlocks ${g.unlocks} (${g.statusText})`;
  for (const L of [1, 2, 3, 4] as Level[]) {
    const s = r.scale[L];
    const state = here !== null && here >= L ? "reached" : (here ?? -1) + 1 === L ? "next" : "later";
    const needs = L === 1 ? r.details.levelRules.level1 : L === 2 ? r.details.levelRules.level2 : `Level ${L} means: ${s.meaning.charAt(0).toLowerCase()}${s.meaning.slice(1).replace(/\.$/, "")}`;
    out.push(`### Level ${L}, ${s.plain} (${state}${isExperimental(L) ? ", experimental" : ""})`, "", `${needs}.`, "");
    const items = groupedSteps(r.roadmap.items.filter((i) => i.level === L));
    if (items.length) out.push(...items.map(step), "");
    else if (state !== "reached") out.push(state === "next" ? "No step is open for it in the roadmap yet." : "Its steps are added once the level below it is reached.", "");
  }
  const every = groupedSteps(r.roadmap.items.filter((i) => i.level === null || i.level === undefined));
  if (every.length) out.push("### For every level", "", ...every.map(step), "");

  out.push("## 5. Audit details: exact steps and everything we checked", "");
  out.push("### Measures", "", `Confidence: ${conf.level} (${conf.reasons.join("; ")}).`, "");
  for (const n of ex.numbers) out.push(`- **${n.label}:** ${n.value}. ${n.comparison}.`);
  out.push("", ex.coverage, "");
  if (r.progress) {
    const keys = Object.keys(r.progress.history[r.progress.history.length - 1].levels);
    out.push("### Levels over time", "", "| Date | Record | Repo | " + keys.join(" | ") + " |", "|---|---|---|" + keys.map(() => "---|").join(""));
    const cell = (v: Level | null | undefined) => (v === undefined ? "-" : v === null ? "not assessed" : String(v));
    for (const h of r.progress.history) out.push(`| ${fmtShortDate(h.date)} | ${h.kind}${h.result === "failed" ? " failed" : ""}${h.note ? `, ${h.note}` : ""} | ${cell(h.repoLevel)} | ${keys.map((k) => cell(h.levels[k])).join(" | ")} |`);
    out.push("", "A failed recheck lowers a level and a later passing recheck restores it. Only an audit can raise a level above the last audit.", "");
    if (r.progress.rubricChanges.length) out.push(`Rubric changes: ${r.progress.rubricChanges.map((c) => `${fmtShortDate(c.date)} ${c.from} to ${c.to}`).join("; ")}. A level change at a rubric change can come from the rubric, not the repo.`, "");
    if (r.progress.closed.length) {
      out.push("### What each closed step was expected to move, and what moved after it", "", "| Step | Closed | Expected | Observed after |", "|---|---|---|---|");
      for (const c of r.progress.closed) out.push(`| ${c.title} | ${fmtShortDate(c.closed)} | ${c.expected} | ${c.observed} |`);
      out.push("", "Movement after a step closed, not proof that the step caused it. Each step shows its own measure; steps closed in the same audit share the window after it, so a change can't be credited to one of them.", "");
    }
    if (r.progress.weakening) out.push(r.progress.weakening, "");
  }
  if (r.matrix.points.length) {
    out.push(`Effort against impact (impact is the share of recent changes an action unblocks): ${r.matrix.points.map((p) => `${p.label} (${p.quadrant ? `${p.quadrant}: ` : ""}effort ${p.x <= 0.35 ? "small" : p.x <= 0.7 ? "medium" : "large"}, ${Math.round((p.impact ?? p.y) * 100)}%)`).join("; ")}.`, "");
  }
  for (const s of r.details.steps) {
    const a = r.actions.find((x) => x.itemId === s.itemId);
    out.push(`### Steps for ${s.title} (step ${stepOf(r, s.itemId) ?? ""})`, "");
    if (a) out.push(`- **What to watch:** ${a.watch}`, `- **Done when:** ${a.doneWhen}`, "");
    s.steps.forEach((st, i) => out.push(`${i + 1}. **${st.title}.** ${st.detail}`));
    out.push("");
  }
  out.push("### Everything we checked, and why", "", "| Check | Why it matters | Result | Evidence |", "|---|---|---|---|");
  for (const c of r.details.checks) {
    const src = c.sources.map((s) => ` ${s.claim} ${s.caveat} ([source](${s.url}))`).join("");
    const result = c.ok === false ? c.result.split("; ").map((part) => (/^(failed|toolchain|lockfile):/.test(part) ? `**${part}**` : part)).join("; ") : c.result;
    out.push(`| ${c.name} (\`${c.id}\`) | ${c.why}${src} | ${result} | ${c.evidence.slice(0, 6).map((e) => `\`${e}\``).join(", ")}${c.evidence.length > 6 ? ` and ${c.evidence.length - 6} more` : ""} |`);
  }
  out.push("", `Not assessed by this rubric version, which is different from unknown: ${list(r.details.notAssessed.map((n) => n.charAt(0).toLowerCase() + n.slice(1)))}.`, "");
  const levelCell = (level: Level | null, couldBe: Level | null, unproven = false) => (level === null ? "not assessed" : unproven ? "Level 1 unproven on this machine (could be 1)" : `${levelWord(rubric, level)}${couldBe !== null ? ` (could be ${couldBe})` : ""}`);
  out.push("### Levels by component", "", `Repo shape: ${comps.shape === "sampled_monorepo" ? "monorepo, sampled (only the most active supported components are assessed)" : comps.shape}. Each component gets one standard level; scenarios someone added appear under the components they cover.`, "", "| Component | Path | Toolchain | Manifest | Lockfile | Share of changes | Level |", "|---|---|---|---|---|---|---|");
  const file = (f: string | null) => (f ? `\`${f}\`` : "none");
  for (const c of comps.included) {
    out.push(`| \`${c.id}\`${c.active ? "" : " (under 10%)"} | \`${c.path}\` | ${c.toolchain} | ${file(c.manifest)} | ${file(c.lockfile)} | ${Math.round(c.changeShare * 100)}% | ${levelCell(c.level, c.couldBe, c.unproven)} |`);
    for (const s of c.scenarios) out.push(`| \`${c.id}\` › ${s.label} | | | | | | ${levelCell(s.level, s.couldBe, s.unproven)} |`);
  }
  for (const c of comps.excluded) out.push(`| \`${c.id}\` | \`${c.path}\` | ${c.toolchain} | ${file(c.manifest)} | ${file(c.lockfile)} | ${c.reason.startsWith("not a component") ? "n/a" : `${Math.round(c.changeShare * 100)}%`} | not assessed: ${c.reason} |`);
  out.push("", `Repo level: ${noResults ? "not assessed" : r.maturity.unproven ? "Level 1 unproven on this machine (could be 1)" : levelWord(rubric, r.maturity.level)}. ${r.maturity.rule}`, "");
  if (r.maturity.capReasons.length) {
    out.push(r.maturity.unproven ? "What keeps Level 1 unproven on this machine:" : `What holds the repo at Level ${r.maturity.level}:`, "");
    for (const c of r.maturity.capReasons) out.push(`- ${c.component === "*" ? "Repo" : `\`${c.component}\``}: ${c.label}, ${c.state === "blocked" ? "blocked on this machine" : c.state === "unknown" ? "not proven" : "not met"} (${c.reason}).`);
    out.push("");
  }
  out.push(`- **Standard level:** ${r.details.levelRules.level1}. ${r.details.levelRules.level2}.`);
  for (const s of r.details.levelRules.scenarios) out.push(`- **${s.label} scenario:** ${s.bar}.`);
  out.push("");
  const oc = r.details.outcomes;
  out.push("### Agent PR outcomes", "");
  if (oc) {
    out.push(`${oc.window}. Agent PRs are matched by ${oc.filter}. Source: ${oc.source}.`, "", "| Measure | " + oc.series.map((s) => s.label).join(" | ") + " |", "|---|" + oc.series.map(() => "---|").join(""));
    out.push(`| Opened | ${oc.series.map((s) => s.opened).join(" | ")} |`);
    out.push(`| Merged | ${oc.series.map((s) => describeRate(s.merged)).join(" | ")} |`);
    out.push(`| Passed CI the first time | ${oc.series.map((s) => describeRate(s.firstTimeCi)).join(" | ")} |`);
    out.push(`| Reviewer requested changes | ${oc.series.map((s) => describeRate(s.changesRequested)).join(" | ")} |`);
    out.push(`| Median days to merge | ${oc.series.map((s) => (s.medianDaysToMerge === null ? "n/a" : String(s.medianDaysToMerge))).join(" | ")} |`, "");
    out.push("| Component | Agent PRs | Passed CI the first time | Changes requested |", "|---|---|---|---|");
    for (const c of oc.byComponent) out.push(`| \`${c.component}\` | ${c.prs} | ${describeRate(c.firstTimeCi)} | ${describeRate(c.changesRequested)} |`);
    out.push("", `${oc.multiComponentNote} ${oc.caveat}`, "", `Matched PRs: ${oc.matchedPrs.map((n) => `#${n}`).join(", ") || "none"}.`, "");
  } else out.push("Not measured: outcomes need the external-systems tier and `readiness outcomes`.", "");
  out.push("### Agent assets already in the repo", "");
  if (r.details.assets.length) {
    out.push("| Asset | Path | Authors | Last changed | Status |", "|---|---|---|---|---|");
    for (const a of r.details.assets) out.push(`| ${a.kind} | \`${a.path}\` | ${a.authors.join(", ") || "unknown"} | ${a.lastChanged ? fmtShortDate(a.lastChanged) : "n/a"} | ${a.status} |`);
    out.push("");
  }
  if (r.details.missingAssets.length) out.push(`Missing: ${list(r.details.missingAssets)}.`, "");
  if (r.details.signals.length) {
    out.push("### Other signals (informational, not scored)", "", "| Signal | Found | Detail |", "|---|---|---|");
    for (const s of r.details.signals) out.push(`| ${s.label} | ${s.found === null ? "n/a" : s.found ? "yes" : "no"} | ${s.detail.replace(/\|/g, "\\|")} |`);
    out.push("", "These don't set a level or add a roadmap step.", "");
  }
  // Five columns: where a check ran goes with its result, and a check read from files names no command.
  out.push("### Evidence log", "", "<details><summary>All evidence</summary>", "", "| ID | Check | Component | What ran | Result |", "|---|---|---|---|---|");
  for (const e of r.details.evidence) {
    const ran = e.ran === e.summary ? `(${e.where})` : `${e.ran.replace(/\|/g, "\\|").slice(0, 120)} (${e.where})`;
    out.push(`| \`${e.id}\` | \`${e.check}\` | ${e.component ?? "repo"} | ${ran} | ${e.result}: ${e.summary.replace(/\|/g, "\\|").slice(0, 160)} |`);
  }
  out.push("", "</details>", "", "Evidence strength, weakest to strongest: stated in docs, read from files, ran on host, ran in a clean container, confirmed by outcomes. A check passes only at its required strength.", "");

  out.push("## About this report", "", `Audited ${fmtDate(r.audit.date)} at ${r.audit.commit}. ${aboutLines(r).join(" ")}`, "");
  for (const x of r.details.record) out.push(`- **${x.label}:** ${x.value}`);
  out.push("");
  const key = keyNote(r);
  out.push("---", "", `Generated from \`report.json\` by the agent-readiness skill; \`report.html\` is the same report as a page.${key ? ` ${key}` : ""}`, "");
  return out.join("\n");
}
