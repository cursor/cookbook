import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { activeComponents, componentLevel, partialCoverage, recheckStates, statesOf } from "../skill/agent-readiness/scripts/lib/levels.ts";
import { allowedNumbers, danglingEvidence, renderMarkdown, validatePart1 } from "../skill/agent-readiness/scripts/lib/render.ts";
import { updateRoadmap } from "../skill/agent-readiness/scripts/lib/roadmap.ts";
import { mutantsFile } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { componentStates } from "../skill/agent-readiness/scripts/lib/score.ts";
import type { HistoryLine } from "../skill/agent-readiness/scripts/lib/types.ts";
import { SKILL, commitAll, materialize, readiness } from "../support/tools/fixture.ts";
import { makeAudit, outcomes, reportFor, stats } from "./helpers.ts";

const rubric = loadRubric("2026-10-alpha");
const L = (spec: Parameters<typeof makeAudit>[0], comp: string, act: "first_pr" | "bug_fixes" | "features") => componentLevel(rubric, statesOf(componentStates(makeAudit(spec), rubric, comp)), act).level;

describe("regressions from the four-model review of the mock report", () => {
  test("a component with 0 of N planted faults caught is never Level 2 for an activity that needs them", () => {
    const spec = { components: [{ id: "worker", share: 1, faults: "fail" as const }] };
    assert.equal(L(spec, "worker", "bug_fixes"), 1);
    assert.equal(L(spec, "worker", "features"), 1);
  });

  test("tests that run but fail give Level 0", () => {
    assert.equal(L({ components: [{ id: "api", share: 1, test: "fail" }] }, "api", "first_pr"), 0);
  });

  test("impact is computed by flipping one action's checks alone, and dependencies are declared", () => {
    const audit = makeAudit({ components: [{ id: "api", share: 0.6, test: "fail", faults: "not_run" }, { id: "worker", share: 0.4, faults: "fail" }] });
    const comps = audit.profile!.components;
    const states = new Map(comps.map((c) => [c.id, componentStates(audit, rubric, c.id)]));
    const r = updateRoadmap(null, { audit, rubric, components: comps, states, active: activeComponents(rubric, comps, []), outcomes: null });
    const get = (id: string) => r.roadmap.items.find((i) => i.id === id)!;
    assert.equal(get("clean.test:api").impact, 0.6);
    assert.equal(get("faults:worker").impact, 0.4);
    assert.equal(get("faults:api").impact, 0);
    assert.deepEqual(get("faults:api").dependsOn, ["clean.test:api"]);
  });

  test("a lint failure in a recheck gives Level 1", () => {
    const base = statesOf(componentStates(makeAudit({ components: [{ id: "a", share: 1, lint: "pass", faults: "pass" }] }), rubric, "a"));
    assert.equal(componentLevel(rubric, recheckStates(base, new Set(["lint"]))).level, 1);
  });

  test("the 10% rule only changes membership after two consecutive audits", () => {
    const comps = makeAudit({ components: [{ id: "a", share: 0.95 }, { id: "b", share: 0.05 }] }).profile!.components;
    const h = (id: string, b: number, active: string[]): HistoryLine => ({ id, kind: "audit", date: "2026-10-01", commit: "x", rubric: "2026-10-alpha", scriptsDigest: "x", result: "sealed", levels: {}, repoLevel: 0, scenarioLevels: {}, shares: { a: 1 - b, b }, active, seedPinned: false });
    assert.ok(activeComponents(rubric, comps, [h("1", 0.2, ["a", "b"])]).has("b"));
    assert.ok(!activeComponents(rubric, comps, [h("1", 0.2, ["a", "b"]), h("2", 0.05, ["a", "b"])]).has("b"));
  });

  test("observed outcomes are computed from stored series, and shared values are labeled", () => {
    const spec = { components: [{ id: "api", share: 0.6, test: "fail" as const, faults: "not_run" as const }, { id: "shared", share: 0.4, faults: "pass" as const }], outcomes: outcomes("2026-09-27", "2026-10-27", stats(9, 7, 3, 4), stats(41, 35, 29, 7), { api: stats(5, 4, 1, 2) }) };
    const ctx = (a: ReturnType<typeof makeAudit>) => {
      const comps = a.profile!.components;
      return { audit: a, rubric, components: comps, states: new Map(comps.map((c) => [c.id, componentStates(a, rubric, c.id)])), active: activeComponents(rubric, comps, []), outcomes: a.outcomes };
    };
    const first = updateRoadmap(null, ctx(makeAudit(spec)));
    const fixed = { ...spec, components: [{ id: "api", share: 0.6, faults: "pass" as const }, spec.components[1]] };
    const second = updateRoadmap(first.roadmap, ctx(makeAudit({ ...fixed, id: "aud-2026-10-27-x-2" })));
    const third = updateRoadmap(second.roadmap, ctx(makeAudit({ ...fixed, id: "aud-2026-11-26-x-3", createdAt: "2026-11-26T00:00:00Z", outcomes: outcomes("2026-10-28", "2026-11-26", stats(17, 13, 11, 5), stats(38, 33, 27, 6), { api: stats(9, 7, 7, 1) }) })));
    const api = third.roadmap.items.find((i) => i.id === "clean.test:api")!;
    assert.equal(api.observed!.value, "20% (1 of 5) to 78% (7 of 9)");
    assert.ok(api.observed!.sharedWith.length > 0, "closed in the same window as another step, so the value is shared");
  });

  test("a dangling evidence ID is rejected", () => {
    const audit = makeAudit({ components: [{ id: "a", share: 1, faults: "pass" }] });
    const r = reportFor(audit);
    r.details.checks[0].evidence.push("ev-404");
    assert.deepEqual(danglingEvidence(r, audit), ["ev-404"]);
  });

  test("part 1 enforces the word, gap and banned-term limits", () => {
    const r = reportFor(makeAudit({ components: [{ id: "a", share: 1, test: "fail" }] }));
    r.executive.headline = "Bootstrap replay failed and the oracle " + "is weak ".repeat(20);
    r.executive.gaps = [1, 2, 3, 4].map((n) => ({ rank: 1, text: `gap ${n}`, blocks: "x", itemId: `i${n}` }));
    const errors = validatePart1(r, rubric, allowedNumbers(r)).join("\n");
    assert.match(errors, /words; the limit is 40/);
    assert.match(errors, /4 gaps; the limit is 3/);
    assert.match(errors, /banned term "oracle"/);
    assert.match(errors, /banned term "replay"/);
  });

  test("the control group is present in every snapshot", () => {
    const r = reportFor(makeAudit({ components: [{ id: "a", share: 1 }], outcomes: outcomes("2026-09-27", "2026-10-27", stats(9, 7, 3, 4), stats(41, 35, 29, 7)) }));
    assert.equal(r.details.outcomes!.series[1].label, "Other PRs");
    assert.match(r.executive.numbers[1].comparison, /^Other PRs: /);
    assert.match(renderMarkdown(r, rubric), /\| Measure \| Agent PRs \| Other PRs \|/);
  });

  test("mutant locations never reach remediate mode, the flake guard holds, and the seed changes each audit", () => {
    const repo = materialize("healthy-node");
    assert.equal(readiness(repo, ["init"]).code, 0);
    const firstSeed = JSON.parse(readFileSync(join(repo, ".agent-readiness/work", readFileSync(join(repo, ".agent-readiness/work/CURRENT"), "utf8").trim(), "audit.json"), "utf8")).seed;
    assert.equal(readiness(repo, ["init", "--force"]).code, 0);
    const id = readFileSync(join(repo, ".agent-readiness/work/CURRENT"), "utf8").trim();
    const secondSeed = JSON.parse(readFileSync(join(repo, ".agent-readiness/work", id, "audit.json"), "utf8")).seed;
    assert.equal(firstSeed.pinned, false);
    assert.notEqual(firstSeed.value, secondSeed.value, "a fresh seed for each audit");
    assert.equal(readiness(repo, ["scan"]).code, 0);
    assert.equal(readiness(repo, ["replay", "--runtime", "none"]).code, 0);
    const draftText = readFileSync(join(repo, ".agent-readiness/work", id, "audit.json"), "utf8");
    const draft = JSON.parse(draftText);
    const tree = JSON.parse(readFileSync(join(repo, ".agent-readiness/work", id, "local.json"), "utf8")).tree;
    const planted = JSON.parse(readFileSync(mutantsFile(tree), "utf8")) as { after: string; file: string; line: number }[];
    assert.ok(draft.mutants.length >= 3);
    assert.equal(planted.length, draft.mutants.length);
    for (const m of draft.mutants) assert.deepEqual(Object.keys(m).sort(), ["component", "exitCodes", "id", "result"], "the draft in the repo holds no fault sites");
    for (const m of planted) assert.ok(!draftText.includes(m.after.trim()) && !draftText.includes(`${m.file}:${m.line}`));
    const status = readiness(repo, ["status", "--json"]).out;
    for (const m of planted) assert.ok(!status.includes(m.after.trim()), "status never shows a planted edit");
    assert.ok(!status.includes('"mutants"'));
    assert.equal(readiness(repo, ["seal"]).code, 0);
    const report = readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8") + readFileSync(join(repo, ".agent-readiness/latest/report.md"), "utf8");
    for (const m of planted) assert.ok(!report.includes(m.after.trim()), "the report never shows a planted edit");
    const sealed = JSON.parse(readFileSync(join(repo, ".agent-readiness/history/audits", id, "audit.json"), "utf8"));
    assert.ok(sealed.mutants.every((m: { file?: string }) => m.file), "the sealed audit keeps every fault's site");
    assert.equal(readiness(repo, ["draft-skill", "--remediate"]).code, 0);
    const skill = readFileSync(join(repo, ".cursor/skills/verify/SKILL.md"), "utf8");
    for (const m of planted) assert.ok(!skill.includes(m.after.trim()));

    const flaky = materialize("healthy-node");
    appendFileSync(join(flaky, "test/pricing.test.js"), `\nimport { existsSync, rmSync, writeFileSync } from "node:fs";\ntest("flaky", () => {\n  if (existsSync(".flaky")) { rmSync(".flaky"); assert.fail("flaky"); }\n  writeFileSync(".flaky", "1");\n});\n`);
    commitAll(flaky, "Add a flaky test");
    readiness(flaky, ["init"]);
    readiness(flaky, ["scan"]);
    readiness(flaky, ["replay", "--runtime", "none"]);
    const out = readiness(flaky, ["status", "--json"]).out;
    assert.match(out, /passed once and failed on a second run/);
  });

  test("verify-seal catches an edited script", () => {
    const copy = join(mkdtempSync(join(tmpdir(), "edited-skill-")), "agent-readiness");
    cpSync(SKILL, copy, { recursive: true });
    appendFileSync(join(copy, "scripts/lib/util.ts"), "\n// an edit after release\n");
    const repo = materialize("healthy-node");
    const cli = join(copy, "scripts/readiness.ts");
    const run = (args: string[]) => readiness(repo, args, {}, cli);
    assert.equal(run(["audit", "--runtime", "none", "--no-mutants"]).code, 0);
    const v = run(["verify-seal"]);
    assert.equal(v.code, 2, v.out);
    assert.match(v.out, /don't match the release manifest/);
    const report = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
    assert.match(report.audit.sealStatus, /Seal not verified/);
  });

  test("registry variable names are recorded and their values never are", () => {
    const repo = materialize("needs-private-registry");
    const value = "registry-value-" + "7d3f9a".repeat(3);
    const r = readiness(repo, ["audit", "--runtime", "none", "--no-mutants", "--registry-env", "NPM_TOKEN"], { NPM_TOKEN: value });
    assert.equal(r.code, 0, r.out);
    const dir = join(repo, ".agent-readiness/history/audits");
    const audit = readFileSync(join(dir, readdirSync(dir)[0], "audit.json"), "utf8");
    assert.match(audit, /"registryEnv": \[\s*"NPM_TOKEN"\s*\]/);
    for (const f of ["audit.json", "report.json", "report.md"]) assert.ok(!readFileSync(join(dir, readdirSync(dir)[0], f), "utf8").includes(value), f);
    assert.ok(existsSync(join(repo, ".agent-readiness/roadmap.json")));
    assert.equal(partialCoverage(rubric, []).partial, false);
  });
});
