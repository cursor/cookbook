import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Audit, ReportJson } from "../skill/agent-readiness/scripts/lib/types.ts";
import { claimsNotInTree } from "../support/evals/lib/claims.ts";
import { goldenProblems, levelViolations, loadGoldens, loadLastRun, rankViolations, scoringDigest, staleResults } from "../support/evals/lib/goldens.ts";
import type { GoldenResult, GoldenSet, LastRun } from "../support/evals/lib/goldens.ts";
import { materialize, readiness } from "../support/tools/fixture.ts";

function audited(fixture: string): { repo: string; report: ReportJson; audit: Audit } {
  const repo = materialize(fixture);
  const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"]);
  assert.equal(r.code, 0, r.out);
  const dir = join(repo, ".agent-readiness/history/audits");
  return {
    repo,
    report: JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8")),
    audit: JSON.parse(readFileSync(join(dir, readdirSync(dir).sort().pop()!, "audit.json"), "utf8")),
  };
}

describe("public goldens", () => {
  test("the pinned set is 4 to 6 permissive repos at full SHAs, covering JS/TS, Python, Go, .NET and a monorepo with nested apps", () => {
    const set = loadGoldens();
    assert.deepEqual(goldenProblems(set), []);
    assert.ok(set.goldens.some((g) => g.shape === "monorepo" && g.expect.included.length > 1), "the monorepo has more than one assessed app");
  });

  test("the ranking is ordinal: each tier sits strictly above the next, and a missing level fails", () => {
    const set = { schema: "agent-readiness/goldens@1", rank: [["a:x"], ["b:y", "c:z"], ["d:w"]], goldens: [] } as unknown as GoldenSet;
    assert.deepEqual(rankViolations(set, { "a:x": 2, "b:y": 1, "c:z": 1, "d:w": 0 }), []);
    assert.deepEqual(rankViolations(set, { "a:x": 4, "b:y": 3, "c:z": 2, "d:w": 0 }), [], "exact scores don't matter, only the order");
    assert.deepEqual(rankViolations(set, { "a:x": 1, "b:y": 1, "c:z": 1, "d:w": 0 }), ["a:x is Level 1, which should be above b:y at Level 1", "a:x is Level 1, which should be above c:z at Level 1"]);
    assert.match(rankViolations(set, { "a:x": 2, "b:y": null, "c:z": 1, "d:w": 0 })[0], /both need a level/);
  });

  test("exact levels are asserted for the stable goldens, and a level off by one fails", () => {
    const set = loadGoldens();
    const exact = Object.fromEntries(set.goldens.flatMap((g) => Object.entries(g.expect.levels ?? {}).map(([c, l]) => [`${g.id}:${c}`, l])));
    assert.deepEqual({ slugify: exact["slugify:slugify"], starlette: exact["starlette:starlette"], express: exact["express:express"] }, { slugify: 2, starlette: 2, express: 1 });
    const slugify = set.goldens.find((g) => g.id === "slugify")!;
    assert.deepEqual(levelViolations(slugify, { slugify: 2 }), []);
    assert.deepEqual(levelViolations(slugify, { slugify: 1 }), ["slugify:slugify is Level 1, expected Level 2"], "a regression that moves every repo down one level still keeps the ranking");
    assert.deepEqual(levelViolations(slugify, { slugify: null }), ["slugify:slugify is no level, expected Level 2"]);
    assert.deepEqual(levelViolations(slugify, {}), ["slugify:slugify has no result"]);
  });

  test("a result recorded under other scoring, at another SHA, or missing is stale", () => {
    const set = loadGoldens();
    const result = (id: string, scoring: string): GoldenResult => ({ id, sha: set.goldens.find((g) => g.id === id)!.sha, minutes: 0, repoLevel: null, outcome: "proven", levels: {}, excluded: [], failures: [], scoring, commit: "x" });
    const run: LastRun = { ranAt: "", results: set.goldens.map((g) => result(g.id, "d1")), violations: [], pending: [] };
    assert.deepEqual(staleResults(set, run, "d1"), []);
    assert.deepEqual(staleResults(set, run, "d2").map((s) => s.id), set.goldens.map((g) => g.id), "changing score.ts or levels.ts makes every result stale");
    const moved: LastRun = { ...run, results: run.results.map((r, i) => (i === 0 ? { ...r, sha: "0".repeat(40) } : r)).slice(0, -1) };
    assert.deepEqual(staleResults(set, moved, "d1").map((s) => s.why.split(",")[0]), ["recorded at 0000000", "no recorded result"]);
    assert.notEqual(scoringDigest(), "", "the digest covers the scoring files");
  });

  // The freshness check: last-run.json must show what the current score.ts and levels.ts give. A
  // result `npm run goldens -- --only` couldn't rerun (no network for PyPI, say) is listed as pending
  // and shows here as a TODO; `npm run goldens -- --check` fails on it, so the release gate does.
  for (const p of loadLastRun()?.pending ?? []) test(`golden ${p.id} is pending a rerun`, { todo: p.reason }, () => {});

  test("last-run.json is fresh against score.ts and levels.ts, and the recorded run holds every assertion", () => {
    const set = loadGoldens();
    const run = loadLastRun();
    const pending = new Map((run?.pending ?? []).map((p) => [p.id, p.reason]));
    const stale = staleResults(set, run).filter((s) => !pending.has(s.id));
    assert.deepEqual(stale, [], "rerun the goldens (`npm run goldens`) after changing scripts/lib/score.ts or scripts/lib/levels.ts");
    const current = run!.results.filter((r) => !pending.has(r.id));
    assert.deepEqual(current.flatMap((r) => r.failures.map((f) => `${r.id}: ${f}`)), []);
    assert.deepEqual(set.goldens.filter((g) => !pending.has(g.id)).flatMap((g) => levelViolations(g, run!.results.find((r) => r.id === g.id)?.levels ?? {})), []);
    const levels = Object.fromEntries(run!.results.flatMap((r) => Object.entries(r.levels).map(([c, l]) => [`${r.id}:${c}`, l])));
    assert.deepEqual(rankViolations(set, levels), []);
  });

  test("goldenProblems catches a short SHA, a copyleft license and a missing toolchain", () => {
    const set = loadGoldens();
    const broken: GoldenSet = { ...set, goldens: set.goldens.map((g, i) => (i === 0 ? { ...g, sha: "abc123", license: "GPL-3.0" } : g)).filter((g) => !g.toolchains.includes("go")) };
    const problems = goldenProblems(broken).join("\n");
    assert.match(problems, /full 40-character SHA/);
    assert.match(problems, /GPL-3\.0 isn't a permissive license/);
    assert.match(problems, /no golden covers go/);
  });
});

describe("claims outside the tree", () => {
  test("a report the scripts wrote claims nothing outside the tree", () => {
    for (const fixture of ["healthy-node", "nested-apps-dotnet"]) {
      const { repo, report, audit } = audited(fixture);
      assert.deepEqual(claimsNotInTree(report, audit, repo), [], fixture);
    }
  });

  test("a claimed config, script or path that isn't in the tree is caught", () => {
    const { repo, report, audit } = audited("nested-apps-dotnet");
    report.components.included[0].manifest = "apps/ghost/package.json";
    report.components.excluded[0].path = "services/ghost";
    report.details.assets.push({ kind: "environment", path: ".cursor/environment.json.bak", authors: [], lastChanged: null, status: "Present", ok: true });
    audit.contract.push({ id: "cmd-buyer-web-typecheck", kind: "typecheck", component: "buyer-web", cwd: "apps/buyer-web", command: "npm run typecheck", source: "apps/buyer-web/package.json scripts.typecheck", reason: "", timeoutSec: 60 });
    audit.contract.push({ id: "cmd-repo-test", kind: "test", component: "*", cwd: ".", command: "make test", source: "CONTRIBUTING.md:12", reason: "", timeoutSec: 60 });
    audit.evidence.push({ id: "ev-900", checkId: "bootstrap.cold_replay", condition: "toolchain", component: "*", strength: "static", where: "static", result: "pass", summary: "toolchain pinned in .tool-versions", at: audit.createdAt });
    const problems = claimsNotInTree(report, audit, repo);
    assert.deepEqual(problems.sort(), [
      "agent asset .cursor/environment.json.bak isn't in the tree",
      "command cmd-buyer-web-typecheck runs scripts.typecheck, which apps/buyer-web/package.json doesn't define",
      "command cmd-repo-test's source CONTRIBUTING.md isn't in the tree",
      `component ${report.components.excluded[0].id}'s path services/ghost isn't in the tree`,
      `component ${report.components.included[0].id}'s manifest apps/ghost/package.json isn't in the tree`,
      "the toolchain pin .tool-versions isn't in the tree",
    ].sort());
  });

  test("a stale instruction's missing target isn't a claim of presence", () => {
    const { repo, report, audit } = audited("agents-md-drift");
    assert.ok(audit.instructions.some((i) => i.result === "fail"), "the fixture has a wrong instruction");
    assert.deepEqual(claimsNotInTree(report, audit, repo), []);
  });
});
