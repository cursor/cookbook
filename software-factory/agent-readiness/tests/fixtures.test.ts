import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { detectRuntime } from "../skill/agent-readiness/scripts/lib/container.ts";
import { auditFixture, expected, fixtureNames } from "../support/tools/fixture.ts";

const runtime = detectRuntime("auto");

describe("fixtures match expected.json", { concurrency: 3, skip: runtime ? false : "no container runtime: fixture audits need docker or podman" }, () => {
  for (const name of fixtureNames()) {
    const exp = expected(name);
    for (const run of exp.runs) {
      test(`${name}: ${run.name}`, { timeout: 15 * 60 * 1000 }, () => {
        const a = auditFixture(name, run);
        assert.equal(a.code, 0, a.out);
        const r = a.report;
        assert.equal(r.maturity.level, run.level, "repo rollup");
        const levels: Record<string, number> = {};
        for (const c of r.components.included) levels[c.id] = c.level;
        assert.deepEqual(levels, run.levels, "one standard level per assessed component");
        const scenarioLevels: Record<string, Record<string, number>> = {};
        for (const c of r.components.included) if (c.scenarios.length) scenarioLevels[c.id] = Object.fromEntries(c.scenarios.map((s: { id: string; level: number }) => [s.id, s.level]));
        assert.deepEqual(scenarioLevels, run.scenarioLevels ?? {}, "scenarios appear only when added, under their components");
        const top = r.actions.filter((x: { startNow: boolean }) => !x.startNow).map((x: { itemId: string }) => x.itemId);
        assert.deepEqual(top, run.top, "top items in order");
        const startNow = r.actions.find((x: { startNow: boolean }) => x.startNow)?.itemId ?? null;
        assert.equal(startNow, run.startNow, "can-start-now item");
        assert.equal(r.executive.noBlocker, run.noBlocker, "no-blocker result");
        const safety = r.details.checks.find((c: { id: string }) => c.id === "safety.execution_boundary");
        assert.equal(safety.ok ? "pass" : "fail", run.safety, "safety check");
        const passedChecks = new Set(r.details.checks.filter((c: { ok: boolean | null }) => c.ok === true).map((c: { id: string }) => c.id));
        for (const t of top) {
          const item = a.roadmap.items.find((i: { id: string }) => i.id === t);
          for (const f of item.fixes) assert.ok(!passedChecks.has(checkOf(f.condition)), `${t} names a check that passed`);
        }
        if (run.notAssessed) assert.deepEqual(r.components.excluded.filter((u: { reason: string }) => !u.reason.startsWith("not a component")).map((u: { id: string }) => u.id), run.notAssessed);
        if (run.waiting) for (const w of run.waiting) assert.equal(a.roadmap.items.find((i: { id: string }) => i.id === w)?.status, "waiting", `${w} waits`);
        if (run.diagnosis) assert.ok(r.details.evidence.some((e: { summary: string }) => e.summary.includes(run.diagnosis!)), `evidence says ${run.diagnosis}`);
        if (run.outcome) assert.equal(r.maturity.outcome, run.outcome, "outcome");
        if (run.shares) {
          const all = [...r.components.included, ...r.components.excluded.filter((c: { reason: string }) => !c.reason.startsWith("not a component"))];
          assert.deepEqual(Object.fromEntries(all.filter((c: { id: string }) => c.id in run.shares!).map((c: { id: string; changeShare: number }) => [c.id, c.changeShare])), run.shares, "share of changes, kept for components that aren't assessed");
        }
        if (run.satellites) assert.deepEqual(r.components.excluded.filter((c: { reason: string }) => c.reason.startsWith("not a component")).map((c: { path: string }) => c.path), run.satellites, "satellites");
        if (run.assets) for (const [path, ok] of Object.entries(run.assets)) assert.equal(r.details.assets.find((x: { path: string }) => x.path === path)?.ok, ok, `asset ${path} ok`);
        if (run.listed) assert.deepEqual([...new Set(a.audit.safety.filter((s: { blocking: boolean }) => !s.blocking).map((s: { kind: string }) => s.kind))].sort(), [...run.listed].sort(), "safety findings listed for review");
        if (run.signals) assert.deepEqual(Object.fromEntries(r.details.signals.filter((s: { id: string }) => s.id in run.signals!).map((s: { id: string; found: boolean | null }) => [s.id, s.found])), run.signals, "informational signals");
        if (run.coverage) assert.match(r.executive.coverage, new RegExp(run.coverage), "coverage line");
        if (run.contract) for (const [id, command] of Object.entries(run.contract)) assert.equal(a.audit.contract.find((c: { id: string }) => c.id === id)?.command, command, `${id} runs check-only`);
        if (run.neverRan) {
          const ran = a.audit.evidence.map((e: { command?: string }) => e.command ?? "").filter(Boolean);
          for (const text of run.neverRan) assert.deepEqual(ran.filter((c: string) => c.includes(text)), [], `no command the audit ran contains ${text}`);
        }
        if (run.skipped !== undefined) assert.equal(a.audit.instructions.filter((i: { category: string }) => i.category === "skipped").length, run.skipped, "instruction commands listed as skipped");
        if (run.unassessed !== undefined) {
          const u = r.executive.unassessed;
          assert.deepEqual(u ? { share: u.share, supportLink: u.supportDoc !== null } : null, run.unassessed, "part 1 says what isn't assessed");
          if (run.unassessed?.supportLink) assert.match(a.markdown, /\*\*Not assessed:\*\* .*What the audit supports/, "part 1 links the support list");
        }
        for (const value of run.absent ?? []) {
          for (const [what, text] of [["report.md", a.markdown], ["report.json", JSON.stringify(r)], ["audit.json", JSON.stringify(a.audit)]]) assert.ok(!text.includes(value), `${what} doesn't echo ${value.slice(0, 6)}…`);
        }
      });
    }
  }
});

function checkOf(condition: string): string {
  if (condition.startsWith("clean.") || condition === "toolchain" || condition === "lockfile") return "bootstrap.cold_replay";
  if (condition === "commands") return "verify.canonical_interface";
  if (condition === "faults") return "verify.behavioral_oracle";
  if (condition === "instructions") return "context.instructions_verified";
  return "safety.execution_boundary";
}
