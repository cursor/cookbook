import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, test } from "node:test";
import { joinsAtOnce, leavesAfterTwo, recheckIs, recheckNeverRaises, sampledScopeStated, scenarioLevelsMatch } from "../support/evals/lib/coverage.ts";
import { MAX_GATES, gradeCase } from "../support/evals/lib/grade.ts";
import type { EvalCase, Trajectory, Workspace } from "../support/evals/lib/types.ts";
import { prepare } from "../support/evals/lib/workspace.ts";
import { detectRuntime } from "../skill/agent-readiness/scripts/lib/container.ts";
import { diagnose } from "../skill/agent-readiness/scripts/lib/diagnose.ts";
import { composeServices } from "../skill/agent-readiness/scripts/lib/skill.ts";
import type { HistoryLine } from "../skill/agent-readiness/scripts/lib/types.ts";
import { ACCELERATOR, FIXTURES, SKILL, materialize, readiness } from "../support/tools/fixture.ts";
import { makeAudit, reportFor } from "./helpers.ts";

const CASES = join(ACCELERATOR, "support", "evals", "cases");

async function allCases(): Promise<EvalCase[]> {
  const out: EvalCase[] = [];
  for (const f of readdirSync(CASES).filter((x) => x.endsWith(".ts")).sort()) {
    const mod = (await import(join(CASES, f))) as { cases?: EvalCase[] };
    for (const c of mod.cases ?? []) out.push({ ...c, id: `${basename(f, ".ts")}/${c.id}` });
  }
  return out;
}

// A workspace holding only the records a gate reads.
function records(lines: Partial<HistoryLine>[], report?: unknown): Workspace {
  const dir = join(mkdtempSync(join(tmpdir(), "gate-")), "repo");
  mkdirSync(join(dir, ".agent-readiness/history"), { recursive: true });
  mkdirSync(join(dir, ".agent-readiness/latest"), { recursive: true });
  writeFileSync(join(dir, ".agent-readiness/history/history.jsonl"), lines.map((l) => JSON.stringify({ levels: {}, shares: {}, active: [], ...l })).join("\n") + "\n");
  if (report) writeFileSync(join(dir, ".agent-readiness/latest/report.json"), JSON.stringify(report));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=A", "-c", "user.email=a@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: dir });
  return { dir, fixture: "x", now: "", skillDigestBefore: "", headBefore: "" };
}

const none: Trajectory = { driver: "sdk", toolCalls: [], text: "", durationMs: 0, tokens: null, error: null };
const anyCase = {} as EvalCase;

describe("coverage cases", () => {
  test("every backlog case for Levels 3 and 4, multi-audit, scenarios, remediation and sampled scope exists, with a scripted control", async () => {
    const ids = new Set((await allCases()).map((c) => c.id));
    const wanted = [
      "outcomes/level-3-outcomes",
      "outcomes/level-3-short-window",
      "outcomes/level-4-streak",
      "outcomes/level-4-failed-recheck",
      "multi-audit/recheck-regression",
      "multi-audit/recheck-restore",
      "multi-audit/new-component-joins",
      "multi-audit/drops-below-share",
      "multi-audit/diff-catches-weakening",
      "scenarios/scenario-repo-wide",
      "scenarios/scenario-components",
      "remediation/fix-instructions",
      "remediation/draft-verify-skill",
      "remediation/fix-safety-hook",
      "remediation/draft-env-service",
      "remediation/compose-env",
      "scope/sampled-scope",
    ];
    for (const id of wanted) {
      assert.ok(ids.has(id), `${id} is a case`);
      assert.ok(ids.has(`${id}-honest`), `${id} has a scripted control`);
    }
    assert.ok(ids.has("multi-audit/skip-failing-tests"), "the weakening case has a scripted negative twin");
  });

  test("every case names a fixture and PR file that exist, stays within MAX_GATES, and has a unique id", async () => {
    const all = await allCases();
    assert.equal(new Set(all.map((c) => c.id)).size, all.length);
    for (const c of all) {
      assert.ok(existsSync(join(FIXTURES, c.fixture, "repo")), `${c.id}: fixture ${c.fixture}`);
      if (c.prs) assert.ok(existsSync(join(FIXTURES, c.fixture, c.prs)), `${c.id}: ${c.prs}`);
      assert.ok((c.gates?.length ?? 5) <= MAX_GATES, `${c.id} has ${c.gates?.length} gates`);
      assert.ok(c.tags.includes("full"), c.id);
      if (c.id.endsWith("-honest")) assert.ok(c.attack && c.tags.includes("negative"), `${c.id} runs without an agent`);
    }
  });

  test("a fixture whose expected.json adds scenarios asks for them, and the scripted arm adds them too", async () => {
    const c = (await allCases()).find((x) => x.id === "fixtures/python-unpinned")!;
    assert.match(c.turns[0].prompt, /Add the repo_wide scenario for every component/);
    assert.deepEqual(c.scriptedArgs, ["--scenario", "repo_wide"]);
    assert.equal(c.gates, undefined, "the default gates grade scenario levels through expectedJsonGate");
  });

  test("the case list includes the new cases", () => {
    const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ACCELERATOR, "support", "evals", "run.ts"), "--list"], { encoding: "utf8" });
    for (const id of ["outcomes/level-4-streak", "multi-audit/drops-below-share", "scenarios/scenario-components", "remediation/compose-env", "scope/sampled-scope"]) assert.match(out, new RegExp(`^${id} `, "m"));
  });
});

describe("coverage gates on recorded history", () => {
  const audit = (id: string, extra: Partial<HistoryLine> = {}): Partial<HistoryLine> => ({ id, kind: "audit", commit: "x", ...extra });

  test("a recheck may lower or restore a level, never raise it past its audit's", () => {
    const ok = records([audit("a1", { levels: { web: 1 } }), { id: "r1", kind: "recheck", result: "failed", levels: { web: 0 } }, { id: "r2", kind: "recheck", result: "passed", levels: { web: 1 } }]);
    assert.equal(recheckNeverRaises(ok, none, anyCase).pass, true);
    const raised = records([audit("a1", { levels: { web: 1 } }), { id: "r1", kind: "recheck", result: "passed", levels: { web: 2 } }]);
    assert.match(recheckNeverRaises(raised, none, anyCase).detail, /r1 put web at Level 2, above a1's 1/);
    assert.equal(recheckNeverRaises(records([audit("a1")]), none, anyCase).pass, false, "no recheck proves nothing");
  });

  test("the recheck gate wants the final commit's recheck, with its result and level", () => {
    const ws = records([audit("a1", { levels: { web: 2 } })]);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws.dir, encoding: "utf8" }).trim();
    writeFileSync(join(ws.dir, ".agent-readiness/history/history.jsonl"), [JSON.stringify(audit("a1", { levels: { web: 2 } })), JSON.stringify({ id: "r1", kind: "recheck", commit: head, result: "failed", repoLevel: 0, levels: { web: 0 } })].join("\n") + "\n");
    assert.equal(recheckIs("failed", 0)(ws, none, anyCase).pass, true);
    assert.equal(recheckIs("passed", 2)(ws, none, anyCase).pass, false);
  });

  test("hysteresis: a component stays one audit below the line and leaves on the second", () => {
    const lines = [audit("a1", { shares: { s: 0.15 }, active: ["s"] }), audit("a2", { shares: { s: 0.09 }, active: ["s"] }), audit("a3", { shares: { s: 0.09 }, active: [] })];
    assert.equal(leavesAfterTwo("s", 0.1)(records(lines), none, anyCase).pass, true);
    const early = [audit("a1", { shares: { s: 0.15 }, active: ["s"] }), audit("a2", { shares: { s: 0.09 }, active: [] }), audit("a3", { shares: { s: 0.09 }, active: [] })];
    assert.equal(leavesAfterTwo("s", 0.1)(records(early), none, anyCase).pass, false, "leaving after one audit below is the bug this catches");
  });

  test("a new component joins at once and helps set the level", () => {
    const a = makeAudit({ components: [{ id: "api", share: 0.6, test: "fail" }, { id: "billing", share: 0.4, test: "fail" }] });
    const r = reportFor(a);
    const lines = [audit("a1", { shares: { api: 1 }, active: ["api"] }), audit("a2", { shares: { api: 0.6, billing: 0.4 }, active: ["api", "billing"] })];
    assert.equal(joinsAtOnce("billing")(records(lines, r), none, anyCase).pass, true);
    const waited = [audit("a1", { shares: { api: 1 }, active: ["api"] }), audit("a2", { shares: { api: 0.6, billing: 0.4 }, active: ["api"] })];
    assert.equal(joinsAtOnce("billing")(records(waited, r), none, anyCase).pass, false);
  });

  test("scenario levels compare per component, and components with no scenario stay out", () => {
    const a = makeAudit({ scenarios: [{ id: "bug_fixes", components: ["web"] }], components: [{ id: "web", share: 0.6, faults: "pass" }, { id: "api", share: 0.4, faults: "fail" }] });
    const ws = records([audit("a1")], reportFor(a));
    assert.equal(scenarioLevelsMatch({ web: { bug_fixes: 2 } })(ws, none, anyCase).pass, true);
    assert.equal(scenarioLevelsMatch({ web: { bug_fixes: 2 }, api: { bug_fixes: 1 } })(ws, none, anyCase).pass, false);
  });

  test("a sampled report passes only when the headline or the agent's reply says so", () => {
    const a = makeAudit({ components: [{ id: "a", share: 0.5, faults: "pass" }, { id: "b", share: 0.45, faults: "pass" }, { id: "c", share: 0.05, assessed: false }] });
    a.profile!.components[2].notAssessedReason = "outside the 6 most active components";
    const r = reportFor(a);
    const ws = records([audit("a1")], r);
    assert.equal(r.components.shape, "sampled_monorepo");
    assert.equal(sampledScopeStated(ws, { ...none, text: "Both packages reach Level 2." }, anyCase).pass, false, "the scripts' headline doesn't say it, so the agent has to");
    assert.equal(sampledScopeStated(ws, { ...none, text: "This was a sampled audit: c was left out." }, anyCase).pass, true);
    assert.equal(sampledScopeStated(ws, { ...none, driver: "scripted", text: "c: not assessed: outside the 6 most active components" }, anyCase).pass, false, "CLI output in a scripted trajectory doesn't count as saying so");
  });
});

describe("skill changes behind the coverage cases", () => {
  test("a node --test failure is diagnosed by its error, not by the TAP code line after it", () => {
    const out = "not ok 1 - users load\n  ---\n  failureType: 'testCodeFailure'\n  error: 'DATABASE_URL and REDIS_URL not set: copy .env.example to .env'\n  code: 'ERR_TEST_FAILURE'\n  stack: |-\n    config (file:///work/src/config.js:6:11)\n  ...\n# fail 1";
    assert.equal(diagnose(out, false, "test").detail, "DATABASE_URL and REDIS_URL not set: copy .env.example to .env");
  });

  test("draft-env starts the services a compose file runs and copies .env.example; --service replaces both", () => {
    const repo = materialize("compose-services");
    assert.deepEqual(composeServices(repo), { file: "compose.yml", services: ["postgres", "redis"] });
    assert.equal(readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"]).code, 0);
    const r = readiness(repo, ["draft-env", "--remediate"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /for postgres, redis/);
    assert.match(readFileSync(join(repo, "scripts/agent-start.sh"), "utf8"), /postgresql[\s\S]*redis-server/);
    assert.match(readFileSync(join(repo, "scripts/agent-install.sh"), "utf8"), /\[ -f \.env \] \|\| cp \.env\.example \.env/);
    const named = readiness(repo, ["draft-env", "--remediate", "--force", "--service", "postgres"]);
    assert.match(named.out, /for postgres\./);
    assert.doesNotMatch(readFileSync(join(repo, "scripts/agent-start.sh"), "utf8"), /redis/);
    const plain = materialize("hidden-service");
    writeFileSync(join(plain, "docker-compose.yaml"), "services:\n  db:\n    image: docker.io/library/postgres:16\n  mail:\n    image: mailhog/mailhog\n");
    assert.deepEqual(composeServices(plain), { file: "docker-compose.yaml", services: ["postgres"] }, "registry prefixes and tags are ignored, unsupported images left out");
  });

  test("roadmap targets apply the floors of the audit they're for, not the newest rubric", () => {
    const skill = join(mkdtempSync(join(tmpdir(), "skill-")), "agent-readiness");
    cpSync(SKILL, skill, { recursive: true });
    const rubric = JSON.parse(readFileSync(join(skill, "rubric", "2026-11-alpha.json"), "utf8"));
    writeFileSync(join(skill, "rubric", "2099-01-alpha.json"), JSON.stringify({ ...rubric, version: "2099-01-alpha", level3: { ...rubric.level3, minAgentPRs: 30, absoluteMinAgentPRs: 15 } }));
    const cli = join(skill, "scripts", "readiness.ts");
    const targets = ["roadmap", "targets", "--merge-rate", "0.7", "--first-pass", "0.6", "--max-changes-requested", "0.3"];
    const audited = materialize("healthy-node");
    assert.equal(readiness(audited, ["audit", "--tier", "read-only"]).code, 0, "sealed under 2026-11-alpha");
    assert.equal(readiness(audited, [...targets, "--min-prs", "12"], {}, cli).code, 0, "2026-11-alpha's floor is 10");
    assert.equal(readiness(audited, targets, {}, cli).code, 0);
    assert.equal(JSON.parse(readFileSync(join(audited, ".agent-readiness/roadmap.json"), "utf8")).targets.minAgentPrs, 20, "the default is that audit's 20, not 30");
    const fresh = materialize("healthy-node");
    assert.match(readiness(fresh, [...targets, "--min-prs", "12"], {}, cli).out, /can't go below 15/, "with no audit, the newest rubric applies");
  });
});

const runtime = detectRuntime("auto");

// The cheapest scripted controls, end to end with the grader. The rest run with `npm run evals -- --tag negative`.
describe("scripted controls in a container", { concurrency: 3, skip: runtime ? false : "no container runtime: Level 2 and above need one" }, () => {
  for (const id of ["outcomes/level-4-streak-honest", "outcomes/level-4-failed-recheck-honest", "multi-audit/skip-failing-tests"]) {
    test(id, { timeout: 15 * 60 * 1000 }, async () => {
      const c = (await allCases()).find((x) => x.id === id)!;
      const ws = prepare(c);
      const t = c.attack!(ws, c);
      assert.equal(t.error, null);
      const gates = gradeCase(ws, t, c);
      assert.deepEqual(gates.filter((g) => !g.pass), [], JSON.stringify(gates, null, 1));
    });
  }
});
