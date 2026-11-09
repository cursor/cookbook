import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { activeComponents, level3Run, outcomeLevel, previousAtLevel3 } from "../skill/agent-readiness/scripts/lib/levels.ts";
import { renderMarkdown } from "../skill/agent-readiness/scripts/lib/render.ts";
import { latestRubricVersion, loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { compute } from "../skill/agent-readiness/scripts/lib/seal.ts";
import type { HistoryLine, Level } from "../skill/agent-readiness/scripts/lib/types.ts";
import { makeAudit, outcomes, reportFor, stats } from "./helpers.ts";

const next = loadRubric("2026-11-alpha");
const prior = loadRubric("2026-10-alpha");
const targets = { mergeRate: 0.7, firstPass: 0.6, maxChangesRequested: 0.3, minAgentPrs: 20 };
const control = stats(40, 35, 30, 5);

function audit(id: string, level: Level, web: ReturnType<typeof stats> | null): HistoryLine {
  return { id, kind: "audit", date: "2026-10-01", commit: "x", rubric: "2026-11-alpha", scriptsDigest: "x", result: "sealed", levels: { web: level }, repoLevel: level, scenarioLevels: {}, shares: { web: 1 }, active: ["web"], seedPinned: false, outcomes: web ? { window: "w", agent: web, control, byComponent: { web } } : null };
}

function level(rubric: typeof next, history: HistoryLine[], now: ReturnType<typeof stats>) {
  return outcomeLevel(rubric, { level2: true, targets, outcomes: { agent: now, control }, previousAtLevel3: previousAtLevel3(history, "web"), level3Run: level3Run(history, "web") });
}

describe("rubric 2026-11-alpha", () => {
  test("is the rubric new audits use, and lists what changed", () => {
    assert.equal(latestRubricVersion(), "2026-11-alpha");
    assert.ok((next.changes ?? []).length >= 3);
  });

  test("Level 4 needs two back-to-back windows: the first window at Level 3 is only Level 3", () => {
    const r = level(next, [], stats(42, 38, 34, 4));
    assert.equal(r.level, 3);
    assert.match(r.reasons[0], /needs 2 back-to-back windows that meet the targets; this is window 1/);
  });

  test("a second window at double the volume, without more change requests, is Level 4", () => {
    assert.equal(level(next, [audit("a1", 3, stats(20, 18, 16, 2))], stats(42, 38, 34, 4)).level, 4);
    const rose = level(next, [audit("a1", 3, stats(20, 18, 16, 2))], stats(42, 38, 34, 10));
    assert.equal(rose.level, 3);
    assert.match(rose.reasons[0], /change requests to stay at or below the first window's 10%; they rose to 24%/);
  });

  test("a window below Level 3 starts the count again, where the old rule skipped over it", () => {
    const history = [audit("a1", 3, stats(20, 18, 16, 2)), audit("a2", 0, stats(5, 2, 1, 3))];
    assert.equal(level(prior, history, stats(42, 38, 34, 4)).level, 4, "2026-10-alpha compared with the last audit at Level 3, across the drop");
    assert.equal(level(next, history, stats(42, 38, 34, 4)).level, 3);
  });

  test("Level 4 holds while the volume holds, where the old rule demanded it double again", () => {
    const history = [audit("a1", 3, stats(20, 18, 16, 2)), audit("a2", 4, stats(42, 38, 34, 4))];
    assert.equal(level(prior, history, stats(45, 41, 37, 4)).level, 3, "2026-10-alpha measured against the Level 4 window");
    assert.equal(level(next, history, stats(45, 41, 37, 4)).level, 4);
  });

  test("the 10-PR floor is stated wherever the 20 is", () => {
    assert.match(next.scale[3].meaning, /at least 20 agent PRs in the window \(never fewer than 10\)/);
    assert.match(next.level3.floor ?? "", /never fewer than 10/);
    assert.equal(next.level3.absoluteMinAgentPRs, 10);
  });

  test("the exact window and the first-CI floor hang on level3.rule, not on the Level 4 rule, and are listed as changes", () => {
    const base = { level2: true, targets, previousAtLevel3: null, level3Run: [] };
    const fewCi = { agent: { ...stats(25, 22, 1, 2), firstTimeCiKnown: 1 }, control, windowDays: 30 };
    const shortWindow = { agent: stats(25, 22, 20, 2), control, windowDays: 28 };
    assert.equal(next.level3.rule, "measured-window");
    assert.equal(outcomeLevel(next, { ...base, outcomes: fewCi }).level, null);
    assert.equal(outcomeLevel(next, { ...base, outcomes: shortWindow }).level, null);
    const streakOnly = { ...next, level3: { ...next.level3, rule: undefined } };
    assert.equal(outcomeLevel(streakOnly, { ...base, outcomes: shortWindow }).level, 3, "a future rubric that keeps the streak but drops the flag drops both checks");
    const flagOnly = { ...prior, level3: { ...prior.level3, rule: "measured-window" as const } };
    assert.match(outcomeLevel(flagOnly, { ...base, outcomes: shortWindow }).reasons[0], /30-day window; this one was 28 days/, "the checks don't need the streak rule");
    assert.match(outcomeLevel(flagOnly, { ...base, outcomes: fewCi }).reasons.join(" "), /only 1 agent PRs have a finished first CI run/);
    const changes = (next.changes ?? []).join("\n");
    assert.match(changes, /exactly outcomes\.windowDays/);
    assert.match(changes, /finished first CI run/);
    assert.equal(prior.level3.rule, undefined, "2026-10-alpha never checked either");
  });

  test("at Level 3 the next line says what Level 4 needs, not the Level 3 bar again", () => {
    const o = outcomes("2026-10-01", "2026-10-30", stats(25, 22, 20, 2), control, { web: stats(25, 22, 20, 2) });
    const a = makeAudit({ components: [{ id: "web", share: 1, faults: "pass" }], outcomes: o });
    a.rubric = "2026-11-alpha";
    const r = reportFor(a, [], targets);
    assert.equal(r.maturity.level, 3);
    assert.equal(r.executive.nextLine, "Next: Level 4, scalable. It needs 2 back-to-back windows that meet the targets; this is window 1.");
    assert.equal(r.maturity.capReasons[0].label, "agent PR volume grows while the targets hold");
  });

  test("a component the last audit didn't have joins the active set at once; under 2026-10-alpha it waited", () => {
    const comps = makeAudit({ components: [{ id: "old", share: 0.4 }, { id: "new-svc", share: 0.6 }] }).profile!.components;
    const last: HistoryLine = { ...audit("a1", 1, null), levels: { old: 1 }, shares: { old: 1 }, active: ["old"] };
    assert.deepEqual([...activeComponents(next, comps, [last])].sort(), ["new-svc", "old"]);
    assert.deepEqual([...activeComponents(prior, comps, [last])], ["old"]);
  });

  test("the only recommended action is never filed under Later; under 2026-10-alpha it could be", () => {
    const spec = { components: [{ id: "worker", share: 0.3, faults: "fail" as const }, { id: "web", share: 0.7, faults: "pass" as const }] };
    const old = reportFor(makeAudit({ ...spec, rubric: "2026-10-alpha" }));
    const top = (r: ReturnType<typeof reportFor>) => r.matrix.points.find((p) => p.itemId === "faults:worker")!;
    assert.equal(top(old).y, 0.3);
    assert.ok(top(old).x >= 0.5 && top(old).y < 0.5, "2026-10-alpha put a medium fix with a 30% share in the Later corner");
    const a = makeAudit(spec);
    a.rubric = "2026-11-alpha";
    const now = reportFor(a);
    assert.equal(top(now).quadrant, "Do first");
    assert.equal(top(now).impact, 0.3, "the share of changes is kept for the text");
    assert.match(renderMarkdown(now, next), /1\. [^;]*\(Do first: effort medium, 30%\)/);
  });

  test("compute passes the run of Level 3 windows to the rule", () => {
    const o = outcomes("2026-10-01", "2026-10-30", stats(42, 38, 34, 4), control, { web: stats(42, 38, 34, 4) });
    const a = makeAudit({ components: [{ id: "web", share: 1, faults: "pass" }], outcomes: o });
    assert.equal(compute(a, next, [audit("a1", 3, stats(20, 18, 16, 2))], targets).levels.get("web")!.level, 4);
  });
});
