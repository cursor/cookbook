import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { activeComponents, capAt, componentLevel, outcomeLevel, partialCoverage, previousAtLevel3, recheckStates, repoLevel, scenariosFor, statesOf, targetsMet } from "../skill/agent-readiness/scripts/lib/levels.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { compute } from "../skill/agent-readiness/scripts/lib/seal.ts";
import { componentStates } from "../skill/agent-readiness/scripts/lib/score.ts";
import type { HistoryLine } from "../skill/agent-readiness/scripts/lib/types.ts";
import { instruction, makeAudit as makeAuditAt, outcomes, reportFor, stats } from "./helpers.ts";
import type { AuditSpec } from "./helpers.ts";

// Every rule here holds under both rubrics; where 2026-11-alpha changed a rule, the test says which.
for (const version of ["2026-10-alpha", "2026-11-alpha"]) describe(`rubric ${version}`, () => {
const rubric = loadRubric(version);
const makeAudit = (spec: AuditSpec) => makeAuditAt({ rubric: version, ...spec });

function levelsOf(spec: AuditSpec, comp: string) {
  const audit = makeAudit(spec);
  const s = statesOf(componentStates(audit, rubric, comp));
  return { standard: componentLevel(rubric, s), first_pr: componentLevel(rubric, s, "first_pr"), bug_fixes: componentLevel(rubric, s, "bug_fixes"), repo_wide: componentLevel(rubric, s, "repo_wide") };
}

function line(id: string, shares: Record<string, number>, active: string[], levels: Record<string, 0 | 1 | 2 | 3 | 4> = {}): HistoryLine {
  return { id, kind: "audit", date: "2026-10-01", commit: "x", rubric: version, scriptsDigest: "x", result: "sealed", levels, repoLevel: 0, scenarioLevels: {}, shares, active, seedPinned: false };
}

describe("standard level", () => {
  test("a clean-container pass of install, build and tests gives Level 1", () => {
    assert.equal(levelsOf({ components: [{ id: "a", share: 1, faults: "fail" }] }, "a").standard.level, 1);
  });

  test("a pass on the host only is not proven, so the level is 0 with a could-be note", () => {
    const l = levelsOf({ components: [{ id: "a", share: 1, where: "fresh_copy", faults: "pass" }] }, "a").standard;
    assert.deepEqual([l.level, l.couldBe], [0, 1]);
  });

  test("tests that run but fail give Level 0", () => {
    const l = levelsOf({ components: [{ id: "a", share: 1, test: "fail", faults: "not_run" }] }, "a").standard;
    assert.deepEqual([l.level, l.couldBe], [0, null]);
  });

  test("a component with no test command can't reach Level 1", () => {
    assert.equal(levelsOf({ components: [{ id: "a", share: 1, test: "missing" }] }, "a").standard.level, 0);
  });

  test("Level 2 needs the commands, caught planted faults, accurate instructions and no production access", () => {
    assert.deepEqual(rubric.level2, ["commands", "faults", "instructions", "safety"]);
    assert.equal(levelsOf({ components: [{ id: "a", share: 1, faults: "pass" }] }, "a").standard.level, 2);
    assert.equal(levelsOf({ components: [{ id: "a", share: 1, faults: "fail" }] }, "a").standard.level, 1, "0 of N planted faults caught is never Level 2");
    const drift = levelsOf({ components: [{ id: "a", share: 1, faults: "pass" }], instructions: [instruction("fail", "pnpm test", "uses pnpm, but the repo uses npm")] }, "a");
    assert.equal(drift.standard.level, 1, "stale instructions hold the standard level at 1");
  });

  test("faults that couldn't be planted read as could-be, not as passed", () => {
    const l = levelsOf({ components: [{ id: "a", share: 1, faults: "not_run" }] }, "a").standard;
    assert.deepEqual([l.level, l.couldBe], [1, 2]);
  });
});

describe("scenarios", () => {
  test("a scenario swaps in its own Level 2 bar and never changes the standard level", () => {
    const drift = levelsOf({ components: [{ id: "a", share: 1, faults: "pass" }], instructions: [instruction("fail", "pnpm test", "uses pnpm, but the repo uses npm")] }, "a");
    assert.deepEqual([drift.standard.level, drift.bug_fixes.level, drift.first_pr.level], [1, 2, 1]);
    const unpinned = levelsOf({ components: [{ id: "a", share: 1, faults: "pass" }], toolchainPinned: false, lockfile: "pass" }, "a");
    assert.deepEqual([unpinned.standard.level, unpinned.repo_wide.level], [2, 1], "repo-wide changes also need pinned toolchains");
  });

  test("a scenario applies only to the components it names", () => {
    const specs = [{ id: "bug_fixes" as const, components: ["web"] }, { id: "repo_wide" as const, components: ["*"] }];
    assert.deepEqual(scenariosFor(rubric, specs, "web"), ["bug_fixes", "repo_wide"]);
    assert.deepEqual(scenariosFor(rubric, specs, "api"), ["repo_wide"]);
    assert.deepEqual(scenariosFor(rubric, [], "web"), []);
  });

  test("two components and one scenario on only one: the scenario nests under that component, and the repo rolls up standard levels only", () => {
    const audit = makeAudit({
      scenarios: [{ id: "first_pr", components: ["web"] }],
      components: [{ id: "web", share: 0.6, faults: "fail" }, { id: "api", share: 0.4, faults: "pass" }],
    });
    const c = compute(audit, rubric, []);
    assert.deepEqual([...c.scenarioLevels.get("web")!.keys()], ["first_pr"]);
    assert.equal(c.scenarioLevels.get("api")!.size, 0);
    const r = reportFor(audit);
    const web = r.components.included.find((x) => x.id === "web")!;
    const api = r.components.included.find((x) => x.id === "api")!;
    assert.deepEqual([web.level, web.scenarios.map((s) => [s.id, s.level])], [1, [["first_pr", 2]]], "web is Level 1 standard and Level 2 for a first PR");
    assert.deepEqual([api.level, api.scenarios], [2, []], "api has no scenario breakdown");
    assert.equal(r.maturity.level, 1, "the repo rolls up the standard levels, not the scenario");
    assert.deepEqual(r.maturity.setBy, ["web"]);
    assert.deepEqual(r.scenarios, [{ id: "first_pr", label: "First PR", components: ["web"] }]);
    assert.doesNotMatch(r.executive.heading + r.executive.headline, /first PR|bug fixes|for /i, "part 1 carries no activity framing");
  });
});

describe("repo rollup", () => {
  test("the rule is written into the rubric and the report", () => {
    assert.match(rubric.repoLevel.rule, /^the lowest level among active components/);
    const r = reportFor(makeAudit({ components: [{ id: "a", share: 1, faults: "pass" }] }));
    assert.equal(r.maturity.rule, `The repo level is ${rubric.repoLevel.rule}.`);
  });

  test("the repo level is the lowest standard level among active components", () => {
    const audit = makeAudit({ components: [{ id: "api", share: 0.56, test: "fail" }, { id: "shared", share: 0.38, faults: "pass" }, { id: "docs", share: 0.06, test: "fail" }] });
    const active = activeComponents(rubric, audit.profile!.components, []);
    assert.deepEqual([...active].sort(), ["api", "shared"]);
    const levels = new Map(["api", "shared", "docs"].map((id) => [id, componentLevel(rubric, statesOf(componentStates(audit, rubric, id)))]));
    const r = repoLevel(levels, active);
    assert.deepEqual([r.level, r.setBy], [0, ["api"]]);
    assert.equal(repoLevel(levels, new Set(["shared"])).level, 2, "a component under 10% doesn't set the level");
  });

  test("components the audit can't assess never set the level", () => {
    const r = reportFor(makeAudit({ components: [{ id: "web", share: 0.5, faults: "pass" }, { id: "infra", share: 0.5, assessed: false }] }));
    assert.equal(r.maturity.level, 2);
    assert.deepEqual(r.components.excluded.map((c) => c.id), ["infra"]);
    assert.equal(r.maturity.partialCoverage, true);
  });

  test("the 10% rule changes membership only after two consecutive audits", () => {
    const comps = makeAudit({ components: [{ id: "a", share: 0.95 }, { id: "b", share: 0.05 }] }).profile!.components;
    const first = [line("aud-1", { a: 0.8, b: 0.2 }, ["a", "b"])];
    assert.deepEqual([...activeComponents(rubric, comps, first)].sort(), ["a", "b"], "b stays active after one audit below the line");
    const second = [...first, line("aud-2", { a: 0.95, b: 0.05 }, ["a", "b"])];
    assert.deepEqual([...activeComponents(rubric, comps, second)].sort(), ["a"], "b leaves after two audits below the line");
    const rising = makeAudit({ components: [{ id: "a", share: 0.85 }, { id: "b", share: 0.15 }] }).profile!.components;
    assert.deepEqual([...activeComponents(rubric, rising, [line("aud-3", { a: 0.95, b: 0.05 }, ["a"])])], ["a"], "b doesn't join after one audit above the line");
    assert.deepEqual([...activeComponents(rubric, rising, [line("aud-3", { a: 0.95, b: 0.05 }, ["a"]), line("aud-4", { a: 0.88, b: 0.12 }, ["a"])])].sort(), ["a", "b"]);
  });

  test("more than 20% of changes outside assessed components reads as partial coverage", () => {
    const comps = makeAudit({ components: [{ id: "a", share: 0.7 }, { id: "infra", share: 0.3, assessed: false }] }).profile!.components;
    assert.equal(partialCoverage(rubric, comps).partial, true);
    const small = makeAudit({ components: [{ id: "a", share: 0.9 }, { id: "infra", share: 0.1, assessed: false }] }).profile!.components;
    assert.equal(partialCoverage(rubric, small).partial, false);
  });
});

describe("outcome levels", () => {
  const targets = { mergeRate: 0.7, firstPass: 0.6, maxChangesRequested: 0.3, minAgentPrs: 20 };
  const window = (agent: ReturnType<typeof stats>, control = stats(40, 35, 30, 5)) => ({ agent, control });

  test("Level 3 needs recorded targets and Level 2 first", () => {
    const o = window(stats(25, 22, 20, 3));
    assert.equal(outcomeLevel(rubric, { level2: true, targets: null, outcomes: o, previousAtLevel3: null }).level, null);
    assert.equal(outcomeLevel(rubric, { level2: true, targets, outcomes: o, previousAtLevel3: null }).level, 3);
    assert.equal(outcomeLevel(rubric, { level2: false, targets, outcomes: o, previousAtLevel3: null }).level, null);
  });

  test("the sample floor holds: fewer than 20 agent PRs can't reach Level 3", () => {
    const r = targetsMet(rubric, targets, window(stats(12, 12, 12, 0)));
    assert.equal(r.met, false);
    assert.match(r.reasons[0], /only 12 agent PRs/);
  });

  test("a team can't lower the floor below 10", () => {
    assert.equal(targetsMet(rubric, { ...targets, minAgentPrs: 5 }, window(stats(8, 8, 8, 0))).met, false);
  });

  test("Level 3 always needs a control group", () => {
    assert.equal(targetsMet(rubric, targets, window(stats(25, 22, 20, 3), stats(0, 0, 0, 0))).met, false);
  });

  test("Level 4 needs agent PR volume to double without change requests rising", () => {
    const prev = stats(20, 18, 16, 2);
    // 2026-10-alpha compares with the last audit at Level 3; 2026-11-alpha with the first window of the run.
    const earlier = { previousAtLevel3: prev, level3Run: [prev] };
    assert.equal(outcomeLevel(rubric, { level2: true, targets, outcomes: window(stats(42, 38, 34, 4)), ...earlier }).level, 4);
    assert.equal(outcomeLevel(rubric, { level2: true, targets, outcomes: window(stats(42, 38, 34, 10)), ...earlier }).level, 3);
    assert.equal(outcomeLevel(rubric, { level2: true, targets, outcomes: window(stats(42, 38, 34, 4)), previousAtLevel3: null, level3Run: [] }).level, 3, "with no earlier window at Level 3, the first is Level 3");
  });

  test("Levels 3 and 4 are measured per component, on the agent PRs that touch it", () => {
    const o = outcomes("2026-10-01", "2026-10-30", stats(45, 40, 36, 4), stats(40, 35, 30, 5), { web: stats(30, 27, 24, 2), api: stats(15, 13, 12, 2) });
    const audit = makeAudit({ components: [{ id: "web", share: 0.6, faults: "pass" }, { id: "api", share: 0.4, faults: "pass" }], outcomes: o });
    const c = compute(audit, rubric, [], targets);
    assert.deepEqual([c.levels.get("web")!.level, c.levels.get("api")!.level], [3, 2], "api has too few agent PRs of its own");
    assert.match(c.levels.get("api")!.outcomeReasons[0], /only 15 agent PRs/);
    assert.equal(c.repo.level, 2, "the repo is as high as its lowest active component");
    assert.deepEqual(previousAtLevel3([{ ...line("aud-1", {}, ["web"], { web: 3 }), outcomes: { window: "w", agent: o.agent, control: o.control, byComponent: o.byComponent } }], "web"), o.byComponent.web);
  });
});

describe("recheck rule", () => {
  const base = statesOf(componentStates(makeAudit({ components: [{ id: "a", share: 1, lint: "pass", faults: "pass" }] }), rubric, "a"));

  test("a lint failure in a recheck gives Level 1", () => {
    assert.equal(componentLevel(rubric, recheckStates(base, new Set(["lint"]))).level, 1);
  });

  test("a failing test in a recheck gives Level 0", () => {
    assert.equal(componentLevel(rubric, recheckStates(base, new Set(["test"]))).level, 0);
  });

  test("a passing recheck restores the last audit's level and never raises it", () => {
    assert.equal(componentLevel(rubric, recheckStates(base, new Set())).level, 2);
    assert.equal(capAt(2, 1), 1);
    assert.equal(capAt(0, 1), 0);
  });
});
});
