import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { activeComponents } from "../skill/agent-readiness/scripts/lib/levels.ts";
import { updateRoadmap } from "../skill/agent-readiness/scripts/lib/roadmap.ts";
import type { RoadmapContext } from "../skill/agent-readiness/scripts/lib/roadmap.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { componentStates } from "../skill/agent-readiness/scripts/lib/score.ts";
import type { Audit, Roadmap } from "../skill/agent-readiness/scripts/lib/types.ts";
import type { AuditSpec } from "./helpers.ts";
import { makeAudit, outcomes, stats } from "./helpers.ts";

const rubric = loadRubric("2026-10-alpha");

function ctxFor(audit: Audit): RoadmapContext {
  const comps = audit.profile!.components;
  return {
    audit,
    rubric,
    components: comps,
    states: new Map(comps.filter((c) => c.assessed).map((c) => [c.id, componentStates(audit, rubric, c.id)])),
    active: activeComponents(rubric, comps, []),
    outcomes: audit.outcomes,
  };
}

const mixed: AuditSpec = {
  components: [
    { id: "api", share: 0.56, test: "fail", diagnosis: { cause: "service", detail: "connection refused on port 5432", service: "Postgres" }, faults: "not_run" },
    { id: "worker", share: 0.27, faults: "fail" },
    { id: "shared", share: 0.15, faults: "pass" },
  ],
};

describe("roadmap", () => {
  test("impact comes from flipping one action's checks alone, and dependencies are declared", () => {
    const r = updateRoadmap(null, ctxFor(makeAudit(mixed)));
    const byId = new Map(r.roadmap.items.map((i) => [i.id, i]));
    assert.equal(byId.get("clean.test:api")!.impact, 0.56);
    assert.equal(byId.get("clean.test:api")!.template, "clean.test:service");
    assert.equal(byId.get("faults:worker")!.impact, 0.27);
    const waiting = byId.get("faults:api")!;
    assert.equal(waiting.impact, 0);
    assert.deepEqual(waiting.dependsOn, ["clean.test:api"]);
    assert.equal(waiting.status, "waiting");
    assert.match(waiting.unlocks, /first needs Set up the service the tests expect on port 5432 for agents in api/);
  });

  test("top items block a component's next standard level, at most three, ordered by impact then effort", () => {
    const r = updateRoadmap(null, ctxFor(makeAudit(mixed)));
    assert.deepEqual(r.top.map((t) => t.id), ["clean.test:api", "faults:worker"]);
    assert.equal(r.startNow?.id, "delegate:shared");
    assert.ok(r.top.length <= 3);
    for (const t of r.top) assert.equal(t.status, "next");
  });

  test("an item the standard level doesn't need is never a top item, even when a scenario would", () => {
    const audit = makeAudit({ scenarios: [{ id: "repo_wide", components: ["*"] }], components: [{ id: "app", share: 1, faults: "pass" }], toolchainPinned: false, lockfile: "fail" });
    const r = updateRoadmap(null, ctxFor(audit));
    assert.deepEqual(r.top.map((t) => t.id), ["targets"]);
    for (const id of ["toolchain:repo", "lockfile:repo"]) {
      const item = r.roadmap.items.find((i) => i.id === id)!;
      assert.equal(item.status, "later");
      assert.equal(item.impact, 0);
    }
  });

  test("co-required items both block and describe what they unlock together", () => {
    const stale = [{ id: "ins-1", source: "AGENTS.md", line: 7, kind: "command" as const, text: "pnpm test", category: "replay" as const, staticResult: "fail" as const, result: "fail" as const, reason: "uses pnpm, but the repo uses npm" }];
    const r = updateRoadmap(null, ctxFor(makeAudit({ components: [{ id: "app", share: 1, faults: "fail" }], instructions: stale })));
    assert.deepEqual(r.top.map((t) => t.id).sort(), ["faults:app", "instructions:repo"]);
    const ins = r.roadmap.items.find((i) => i.id === "instructions:repo")!;
    assert.deepEqual(ins.dependsOn, []);
    assert.match(ins.unlocks, /^app to Level 2 together with Make app's tests catch wrong behavior/);
  });

  test("the roadmap opens with naming an owner until one is recorded", () => {
    const r = updateRoadmap(null, ctxFor(makeAudit(mixed)));
    assert.equal(r.roadmap.items[0].id, "owner");
    const blocked = updateRoadmap(null, { ...ctxFor(makeAudit(mixed)), decisionsOnly: true });
    assert.deepEqual([blocked.roadmap.items.map((i) => i.id), blocked.top, blocked.startNow], [["owner", "targets"], [], null], "with no real results only the decisions stay, so the ask to name an owner matches a roadmap step");
    const owned: Roadmap = { ...r.roadmap, owner: "Platform team" };
    const again = updateRoadmap(owned, ctxFor(makeAudit({ ...mixed, id: "aud-2026-11-01-abc1234-0002" })));
    assert.equal(again.roadmap.items.find((i) => i.id === "owner")!.status, "done");
  });

  test("with no blocker, targets are next and the ready component can start now", () => {
    const r = updateRoadmap(null, ctxFor(makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] })));
    assert.deepEqual(r.top.map((t) => t.id), ["targets"]);
    assert.equal(r.startNow?.id, "delegate:app");
  });

  test("IDs are stable across audits, and the audit that closes an item records it", () => {
    const first = updateRoadmap(null, ctxFor(makeAudit(mixed)));
    const fixed = makeAudit({ ...mixed, id: "aud-2026-11-26-def5678-0002", createdAt: "2026-11-26T15:00:00.000Z", components: [{ id: "api", share: 0.56, faults: "pass" }, mixed.components[1], mixed.components[2]] });
    const second = updateRoadmap(first.roadmap, ctxFor(fixed));
    const item = second.roadmap.items.find((i) => i.id === "clean.test:api")!;
    assert.equal(item.status, "done");
    assert.equal(item.closedBy, "aud-2026-11-26-def5678-0002");
    assert.equal(item.createdBy, "aud-2026-10-27-abc1234-0001");
    assert.equal(item.order, first.roadmap.items.find((i) => i.id === "clean.test:api")!.order);
    assert.equal(second.roadmap.items.find((i) => i.id === "faults:api")!.status, "done");
    assert.deepEqual(second.top.map((t) => t.id), ["faults:worker"]);
  });

  test("observed outcomes come from the item's own metric after it closed, and shared values say so", () => {
    const base = outcomes("2026-09-27", "2026-10-27", stats(9, 7, 3, 4), stats(41, 35, 29, 7), { api: stats(5, 4, 1, 2), worker: stats(3, 2, 1, 2), shared: stats(2, 2, 2, 0) });
    const first = updateRoadmap(null, ctxFor(makeAudit({ ...mixed, outcomes: base })));
    assert.equal(first.roadmap.items.find((i) => i.id === "clean.test:api")!.expected.watch.baseline, "20% (1 of 5)");
    const fixedSpec = { ...mixed, components: [{ id: "api", share: 0.56, faults: "pass" as const }, mixed.components[1], mixed.components[2]] };
    const closedIn = makeAudit({ ...fixedSpec, id: "aud-2026-10-28-aaa0000-0002", outcomes: base });
    const second = updateRoadmap(first.roadmap, ctxFor(closedIn));
    assert.equal(second.roadmap.items.find((i) => i.id === "clean.test:api")!.observed, null, "no window after the close yet");
    const later = outcomes("2026-10-28", "2026-11-26", stats(17, 13, 11, 5), stats(38, 33, 27, 6), { api: stats(9, 7, 7, 1), worker: stats(6, 4, 2, 3), shared: stats(3, 3, 3, 0) });
    const third = updateRoadmap(second.roadmap, ctxFor(makeAudit({ ...fixedSpec, id: "aud-2026-11-26-bbb0000-0003", outcomes: later })));
    const api = third.roadmap.items.find((i) => i.id === "clean.test:api")!;
    assert.equal(api.observed!.value, "20% (1 of 5) to 78% (7 of 9)");
    assert.deepEqual(api.observed!.sharedWith, ["faults:api"]);
  });
});
