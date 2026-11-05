import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mergeHistory } from "../skill/agent-readiness/scripts/lib/history.ts";
import { level3Run, outcomeLevel } from "../skill/agent-readiness/scripts/lib/levels.ts";
import { fetchPrs } from "../skill/agent-readiness/scripts/lib/outcomes.ts";
import { allowedNumbers, validatePart1 } from "../skill/agent-readiness/scripts/lib/render.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { componentStates } from "../skill/agent-readiness/scripts/lib/score.ts";
import type { Audit, HistoryLine, Level } from "../skill/agent-readiness/scripts/lib/types.ts";
import { exportTree } from "../skill/agent-readiness/scripts/lib/workspace.ts";
import { commitAll, materialize, readiness } from "../support/tools/fixture.ts";
import { instruction, makeAudit, reportFor, stats } from "./helpers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const next = loadRubric("2026-11-alpha");
const targets = { mergeRate: 0.7, firstPass: 0.6, maxChangesRequested: 0.3, minAgentPrs: 20 };
const control = stats(40, 35, 30, 5);
const hostAudit = (repo: string, env: Record<string, string> = {}) => assert.equal(readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"], env).code, 0);
const draftDir = (repo: string) => join(repo, ".agent-readiness/work", readFileSync(join(repo, ".agent-readiness/work/CURRENT"), "utf8").trim());

function line(id: string, level: Level, web: ReturnType<typeof stats> | null, extra: Partial<HistoryLine> = {}, window = "2026-09-01 to 2026-10-01"): HistoryLine {
  return { id, kind: "audit", date: "2026-10-01", commit: "x", rubric: "2026-11-alpha", scriptsDigest: "x", result: "sealed", levels: { web: level }, repoLevel: level, scenarioLevels: {}, shares: { web: 1 }, active: ["web"], seedPinned: false, outcomes: web ? { window, agent: web, control, byComponent: { web }, source: "gh" } : null, ...extra };
}

describe("fixes from the second independent review", () => {
  test("with a seal key set, verify-seal refuses an unkeyed seal instead of falling back to a plain digest", () => {
    const repo = materialize("healthy-node");
    hostAudit(repo, { SA_READINESS_SEAL_KEY: "" });
    const v = readiness(repo, ["verify-seal"], { SA_READINESS_SEAL_KEY: "ci-key" });
    assert.equal(v.code, 2);
    assert.match(v.out, /SA_READINESS_SEAL_KEY is set, so .*'s unkeyed seal isn't accepted/);
  });

  test("--allow-unkeyed lets the weekly recheck verify an audit sealed on a laptop, and the digest still has to match", () => {
    const repo = materialize("healthy-node");
    hostAudit(repo, { SA_READINESS_SEAL_KEY: "" });
    const v = readiness(repo, ["verify-seal", "--allow-unkeyed"], { SA_READINESS_SEAL_KEY: "ci-key" });
    assert.equal(v.code, 0, v.out);
    assert.match(v.out, /accepted unkeyed because of --allow-unkeyed/);
    assert.match(readFileSync(join(__dirname, "../support/examples/github-workflows/scheduled-recheck.yml"), "utf8"), /verify-seal latest .*--allow-unkeyed/);
  });

  test("with a seal key set, seal leaves out unkeyed history lines, which anyone could have written", () => {
    const repo = materialize("healthy-node");
    hostAudit(repo, { SA_READINESS_SEAL_KEY: "" });
    const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"], { SA_READINESS_SEAL_KEY: "ci-key" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Left out 1 history line that don't match a sealed audit/);
  });

  test("a deleted draft digest, or a seal key that changed since init, is refused with its own reason", () => {
    const repo = materialize("healthy-node");
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"], { SA_READINESS_SEAL_KEY: "" }).code, 0);
    assert.match(readiness(repo, ["scan"], { SA_READINESS_SEAL_KEY: "k" }).out, /SA_READINESS_SEAL_KEY was unset when .* started and is set now/);
    const tree = JSON.parse(readFileSync(join(draftDir(repo), "local.json"), "utf8")).tree as string;
    rmSync(join(tree, "..", "draft.digest"));
    assert.match(readiness(repo, ["scan"], { SA_READINESS_SEAL_KEY: "" }).out, /draft digest is missing/);
  });

  test("a cited line adds exactly what it says, or the bare script; nothing that could mask a failure", () => {
    const repo = materialize("healthy-node");
    writeFileSync(join(repo, "README.md"), "Run the checks:\n\n    npm run check\n\n- CI: `cd tools && npm run check`\n");
    commitAll(repo, "Document a check script");
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"]).code, 0);
    assert.equal(readiness(repo, ["scan"]).code, 0);
    const add = (cmd: string, line: number) => readiness(repo, ["contract", "add", "--kind", "lint", "--component", "healthy-node", "--cmd", cmd, "--source", `README.md:${line}`, "--reason", "documented"]);
    for (const cmd of ["npm run check ; true", "npm run check || echo ok", "npm run check | cat", "npm run check -- --passWithNoTests"]) assert.notEqual(add(cmd, 3).code, 0, cmd);
    const ok = add("npm run check", 5);
    assert.equal(ok.code, 0, ok.out);
  });

  test("a re-audit inside a window doesn't end a Level 3 run", () => {
    const first = line("a1", 3, stats(20, 18, 16, 2), {}, "2026-08-01 to 2026-08-31");
    const second = line("a2", 4, stats(42, 38, 34, 4), {}, "2026-09-01 to 2026-09-30");
    const reaudit = line("a3", 4, stats(43, 39, 35, 4), {}, "2026-09-03 to 2026-10-02");
    assert.equal(level3Run([first, second, reaudit], "web", { from: "2026-10-03" }).length, 2, "the overlapping re-audit is skipped; the two whole windows still count");
  });

  test("a part 1 reason that still holds a banned word gives way to a plain sentence", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, faults: "not_run" }] });
    audit.rubric = "2026-11-alpha";
    audit.evidence.find((e) => e.condition === "faults")!.summary = "planting faults failed: the mutant oracle crashed";
    const r = reportFor(audit);
    for (const field of [r.executive.headline, r.executive.ask]) for (const t of next.part1.bannedTerms) assert.ok(!field.toLowerCase().includes(t.toLowerCase()), `${t} in ${field}`);
  });

  test("a failing root test command can't be pinned on components whose own tests pass", () => {
    const audit = makeAudit({ components: [{ id: "api", share: 0.5, test: "fail" }, { id: "shared", share: 0.5, faults: "pass" }] });
    audit.rubric = "2026-11-alpha";
    audit.contract.push({ id: "cmd-repo-test", kind: "test", component: "*", cwd: ".", command: "npm test", source: "AGENTS.md:3", reason: "documented", timeoutSec: 600 });
    audit.evidence.push({ id: "ev-root", at: audit.createdAt, checkId: "bootstrap.cold_replay", condition: "clean.test", component: "*", kind: "test", contractId: "cmd-repo-test", strength: "clean_replay", where: "container", result: "fail", command: "npm test", summary: "test failed: connection refused on port 5432" });
    const rubric = loadRubric("2026-11-alpha");
    assert.equal(componentStates(audit, rubric, "shared")["clean.test"].state, "met", "shared's own tests decide it");
    assert.equal(componentStates(audit, rubric, "api")["clean.test"].state, "not_met");
    const noOwn = makeAudit({ components: [{ id: "app", share: 1, test: "missing" }] });
    noOwn.contract.push(audit.contract.at(-1)!);
    noOwn.evidence.push(audit.evidence.at(-1)!);
    assert.equal(componentStates(noOwn, rubric, "app")["clean.test"].state, "not_met", "a component with no test of its own gets the repo's");
  });

  test("the seal refuses a narrated headline that calls a component below Level 2 ready", () => {
    const audit = makeAudit({ components: [{ id: "api", share: 0.6, test: "fail" }, { id: "shared", share: 0.4, faults: "fail" }] });
    audit.rubric = "2026-11-alpha";
    audit.narration = { headline: "api sets the level: its tests need Postgres. shared is ready for agents." };
    const r = reportFor(audit);
    assert.match(validatePart1(r, next, allowedNumbers(r)).join("; "), /the headline calls shared ready, but shared is at Level 1/);
    audit.narration = { headline: "api sets the level: its tests need Postgres. shared installs and its tests run, but they miss planted bugs, so it isn't ready yet." };
    const fine = reportFor(audit);
    assert.deepEqual(validatePart1(fine, next, allowedNumbers(fine)).filter((e) => /calls .* ready/.test(e)), []);
  });

  test("SKILL.md says to seal without a registry token instead of stopping to ask", () => {
    assert.match(readFileSync(join(__dirname, "../skill/agent-readiness/SKILL.md"), "utf8"), /If the variable isn't set in this shell, don't stop to ask for it: narrate and seal the audit as it stands/);
  });

  test("SKILL.md says to seal one audit per request, with the narration final once sealed", () => {
    assert.match(readFileSync(join(__dirname, "../skill/agent-readiness/SKILL.md"), "utf8"), /\*\*Seal one audit per request\.\*\* .*Once an audit is sealed, its narration is final: don't run another audit to reword it/);
  });

  test("SKILL.md says to narrate only what the audit recorded", () => {
    const skill = readFileSync(join(__dirname, "../skill/agent-readiness/SKILL.md"), "utf8");
    assert.match(skill, /\*\*Only what the audit recorded\.\*\* .*What you learned only by reading the repo isn't in those records, so leave it out even when it's true/);
    assert.match(skill, /A refused connection on port 5432 is "a service on port 5432 the setup doesn't start" unless a line names the service/);
    assert.match(skill, /Describe only this audit\. Leave out "now", "new", "again"/);
    assert.match(skill, /say so and where a rerun can prove it/);
  });

  test("verify-seal fails when the latest audit's roadmap.json is gone", () => {
    const repo = materialize("healthy-node");
    hostAudit(repo);
    rmSync(join(repo, ".agent-readiness/roadmap.json"));
    assert.match(readiness(repo, ["verify-seal"]).out, /roadmap\.json is missing/);
  });

  test("an edit to the draft audit.json by hand is caught at the next step", () => {
    const repo = materialize("healthy-node");
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"]).code, 0);
    assert.equal(readiness(repo, ["scan"]).code, 0);
    const f = join(draftDir(repo), "audit.json");
    const draft = JSON.parse(readFileSync(f, "utf8")) as Audit;
    draft.seed.pinned = true;
    writeFileSync(f, JSON.stringify(draft, null, 2));
    const r = readiness(repo, ["status"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /audit\.json was edited outside the scripts/);
  });

  test("the draft holds only a digest of the seed; the sealed audit records the seed itself", () => {
    const repo = materialize("healthy-node");
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"]).code, 0);
    const dir = draftDir(repo);
    const draft = JSON.parse(readFileSync(join(dir, "audit.json"), "utf8")) as Audit;
    const tree = JSON.parse(readFileSync(join(dir, "local.json"), "utf8")).tree as string;
    const seed = readFileSync(join(tree, "..", "seed.txt"), "utf8").trim();
    assert.notEqual(draft.seed.value, seed);
    assert.ok(!readFileSync(join(dir, "audit.json"), "utf8").includes(seed));
    for (const args of [["scan"], ["replay", "--runtime", "none", "--no-mutants"], ["seal"]]) assert.equal(readiness(repo, args).code, 0, args.join(" "));
    const sealed = JSON.parse(readFileSync(join(repo, ".agent-readiness/history/audits", draft.id, "audit.json"), "utf8")) as Audit;
    assert.equal(sealed.seed.value, seed);
  });

  test("a commit id from the draft never reaches a shell", () => {
    assert.throws(() => exportTree(tmpdir(), "HEAD; touch /tmp/pwned #", mkdtempSync(join(tmpdir(), "x-"))), /Not a commit id/);
  });

  test("--runtime takes only a supported runtime, and --registry-env can't pass the audit's own settings", () => {
    const repo = materialize("healthy-node");
    const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "/usr/bin/true"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /--runtime takes auto, docker, podman, none; got \/usr\/bin\/true/);
    const s = readiness(repo, ["init", "--force", "--tier", "local-exec", "--registry-env", "SA_READINESS_SEAL_KEY"]);
    assert.notEqual(s.code, 0);
    assert.match(s.out, /--registry-env can't pass SA_READINESS_SEAL_KEY/);
  });

  test("a host run after the replay doesn't turn a failed clean install into a blocked one", () => {
    const audit = makeAudit({ install: "fail", components: [{ id: "api", share: 1, test: "not_run" }] });
    audit.evidence.push({ ...audit.evidence[0], id: "ev-host", where: "host", strength: "executed", result: "pass", summary: "install passed" });
    assert.equal(componentStates(audit, loadRubric("2026-11-alpha"), "api")["clean.install"].state, "not_met");
  });

  test("a production audit's Level 3 run never counts eval or recorded-file windows", () => {
    const fromFile = line("a1", 3, stats(20, 18, 16, 2), { outcomes: { window: "2026-09-01 to 2026-10-01", agent: stats(20, 18, 16, 2), control, byComponent: { web: stats(20, 18, 16, 2) }, source: "file" } });
    assert.equal(level3Run([fromFile], "web", { production: true }).length, 0);
    assert.equal(level3Run([line("a1", 3, stats(20, 18, 16, 2), { seedPinned: true })], "web", { production: true }).length, 0);
    assert.equal(level3Run([fromFile], "web", { production: false }).length, 1, "an eval audit can still build on eval windows");
  });

  test("the run breaks on an audit with no level, a failed recheck, an overlapping window, and a window with too few PRs", () => {
    const ok = line("a1", 3, stats(20, 18, 16, 2));
    const noLevel = line("a2", 3, stats(20, 18, 16, 2), { noLevel: true }, "2026-10-01 to 2026-10-31");
    assert.equal(level3Run([ok, noLevel], "web", { from: "2026-11-01" }).length, 0);
    const failed: HistoryLine = { ...line("r1", 0, null), kind: "recheck", result: "failed", levels: { web: 1 } };
    assert.equal(level3Run([ok, failed], "web", { from: "2026-11-01" }).length, 0);
    assert.equal(level3Run([ok], "web", { from: "2026-09-15" }).length, 0, "a window that overlaps this one isn't back-to-back");
    assert.equal(level3Run([ok], "web", { from: "2026-10-01" }).length, 1);
    assert.equal(level3Run([line("a1", 3, stats(0, 0, 0, 0))], "web", { minOpened: 10 }).length, 0, "a forged empty window can't set the baseline");
  });

  test("Level 3 is measured only over the rubric's window, and a CI rate needs enough finished runs", () => {
    const base = { level2: true, targets, previousAtLevel3: null, level3Run: [] };
    const longWindow = outcomeLevel(next, { ...base, outcomes: { agent: stats(25, 22, 20, 2), control, windowDays: 365 } });
    assert.equal(longWindow.level, null);
    assert.match(longWindow.reasons[0], /measured over a 30-day window; this one was 365 days/);
    const fewCi = { ...stats(25, 22, 1, 2), firstTimeCiKnown: 1 };
    const r = outcomeLevel(next, { ...base, outcomes: { agent: fewCi, control, windowDays: 30 } });
    assert.equal(r.level, null);
    assert.match(r.reasons.join("; "), /only 1 agent PRs have a finished first CI run/);
  });

  test("seal leaves out history lines that don't match a sealed audit", () => {
    const repo = materialize("healthy-node");
    hostAudit(repo);
    const hist = join(repo, ".agent-readiness/history/history.jsonl");
    const forged = { ...JSON.parse(readFileSync(hist, "utf8").trim()), id: "aud-forged", levels: { "healthy-node": 3 } };
    writeFileSync(hist, readFileSync(hist, "utf8") + JSON.stringify(forged) + "\n");
    const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Left out 1 history line that don't match a sealed audit: aud-forged/);
  });

  test("a failing repo-wide command gets a roadmap fix, so the report never calls it unproven", () => {
    const audit = makeAudit({ components: [{ id: "api", share: 0.5, faults: "pass" }, { id: "web", share: 0.5, faults: "pass" }] });
    audit.rubric = "2026-11-alpha";
    audit.contract.push({ id: "cmd-repo-typecheck", kind: "typecheck", component: "*", cwd: ".", command: "tsc --noEmit", source: "AGENTS.md:3", reason: "x", timeoutSec: 600 });
    audit.evidence.push({ id: "ev-tc", at: audit.createdAt, checkId: "verify.canonical_interface", condition: "commands", component: "*", kind: "typecheck", contractId: "cmd-repo-typecheck", strength: "clean_replay", where: "container", result: "fail", command: "tsc --noEmit", summary: "typecheck failed: error TS2322" });
    const r = reportFor(audit);
    assert.deepEqual(r.roadmap.items.filter((i) => i.id.startsWith("commands:")).map((i) => i.id), ["commands:repo"], "one fix for the repo-wide command, not one per component");
    assert.match(r.roadmap.items.find((i) => i.id === "commands:repo")!.title, /^Fix the failing typecheck command in the repo$/);
    assert.equal(r.maturity.unproven, false);
    assert.doesNotMatch(r.executive.headline, /couldn't be proved/);
    assert.match(r.executive.headline, /type-check command fails/);
  });

  test("a reason that reaches part 1 never carries the audit's banned words", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }], instructions: [{ ...instruction("pass", "npm run docs"), result: "not_run" }] });
    audit.rubric = "2026-11-alpha";
    const r = reportFor(audit);
    for (const field of [r.executive.headline, r.executive.ask]) assert.doesNotMatch(field, /replay/i, field);
  });

  test("narration may use the share of changes the default headline gives for the components that set the level", () => {
    const r = reportFor(makeAudit({ components: [{ id: "api", share: 0.35, test: "fail" }, { id: "worker", share: 0.25, test: "fail" }, { id: "web", share: 0.4, faults: "fail" }] }));
    assert.match(r.executive.headline, /60% of recent changes/);
    assert.ok(allowedNumbers(r).has("60%"));
  });

  test("the coverage line names the fallback only when no component reaches 10%", () => {
    const comps = { components: [{ id: "api", share: 0.5 }, { id: "web", share: 0.05 }] };
    const r = reportFor(makeAudit(comps), [{ ...line("a1", 1, null), levels: { api: 1, web: 1 }, shares: { api: 0.5, web: 0.15 }, active: ["api", "web"] }]);
    assert.doesNotMatch(r.executive.coverage, /No assessed component gets 10%/);
  });

  test("actions that only unblock together share the top of the matrix and say so", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, faults: "fail" }], instructions: [instruction("fail", "pnpm test", "uses pnpm, but the repo uses npm")] });
    audit.rubric = "2026-11-alpha";
    const r = reportFor(audit);
    const points = r.matrix.points.filter((p) => ["faults:app", "instructions:repo"].includes(p.itemId));
    assert.equal(points.length, 2);
    for (const p of points) assert.equal(p.y, 0.75);
    assert.ok(r.actions.some((a) => /^Takes app to Level 2 together with/.test(a.movesTheNeedle)), JSON.stringify(r.actions.map((a) => a.movesTheNeedle)));
  });

  test("a recheck on the host records no level even when a command failed there", () => {
    const repo = materialize("healthy-node");
    hostAudit(repo);
    writeFileSync(join(repo, "test/pricing.test.js"), 'import test from "node:test";\nimport assert from "node:assert";\ntest("broken", () => assert.fail("x"));\n');
    commitAll(repo, "Break a test");
    readiness(repo, ["recheck", "--runtime", "none"]);
    const last = JSON.parse(readFileSync(join(repo, ".agent-readiness/history/history.jsonl"), "utf8").trim().split("\n").pop()!) as HistoryLine;
    assert.equal(last.result, "failed");
    assert.equal(last.noLevel, true);
  });

  test("merged history is in date order", () => {
    const a = JSON.stringify({ id: "a", date: "2026-10-02" });
    const b = JSON.stringify({ id: "b", date: "2026-10-01" });
    assert.equal(mergeHistory(`${a}\n`, `${b}\n${a}\n`), `${b}\n${a}\n`);
  });

  test("first-time CI is unknown when check runs sit past the first page", () => {
    const bin = mkdtempSync(join(tmpdir(), "gh-"));
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
if [ "$1" = "pr" ]; then echo '[{"number":7,"headRefName":"cursor/fix","author":{"login":"a"},"labels":[],"createdAt":"2026-10-20T00:00:00Z","mergedAt":null,"state":"OPEN","files":[],"reviews":[],"commits":[{"oid":"abc"}]}]'; exit 0; fi
if [ "$1" = "api" ]; then echo '{"total_count":150,"check_runs":[{"conclusion":"success","status":"completed"}]}'; exit 0; fi
exit 1
`);
    chmodSync(join(bin, "gh"), 0o755);
    const old = process.env.PATH;
    process.env.PATH = `${bin}:${old}`;
    try {
      assert.equal(fetchPrs("example-org/example", 30).prs[0].firstCheck, null);
    } finally {
      process.env.PATH = old;
    }
  });
});
