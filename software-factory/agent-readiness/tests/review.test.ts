import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { compare, crashedRun, summarize } from "../support/evals/lib/baseline.ts";
import { faultStoreReads, shellWritesProtected } from "../support/evals/lib/trajectory.ts";
import { mergeHistory } from "../skill/agent-readiness/scripts/lib/history.ts";
import { activeComponents } from "../skill/agent-readiness/scripts/lib/levels.ts";
import { coAuthorMatches } from "../skill/agent-readiness/scripts/lib/outcomes.ts";
import { discoverComponents } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { NETWORK_ON, hostExecutor, insideTree, newBudget, registryValuesOf, runContract } from "../skill/agent-readiness/scripts/lib/replay.ts";
import type { Executor } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { componentStates, repoStates } from "../skill/agent-readiness/scripts/lib/score.ts";
import { renderEnvFiles } from "../skill/agent-readiness/scripts/lib/skill.ts";
import type { Audit, ContractCommand, Evidence } from "../skill/agent-readiness/scripts/lib/types.ts";
import { materialize, readiness } from "../support/tools/fixture.ts";
import { makeAudit, reportFor } from "./helpers.ts";

const rubric = loadRubric("2026-10-alpha");

function addCommand(audit: Audit, cmd: Omit<ContractCommand, "timeoutSec" | "source" | "reason" | "cwd">, result: "pass" | "fail", where: Evidence["where"] = "container"): void {
  audit.contract.push({ ...cmd, cwd: ".", source: "AGENTS.md:3", reason: "documented", timeoutSec: 600 });
  audit.evidence.push({
    id: `ev-${audit.evidence.length + 1}`,
    at: "2026-10-27T15:00:00.000Z",
    checkId: cmd.kind === "lint" || cmd.kind === "typecheck" ? "verify.canonical_interface" : "bootstrap.cold_replay",
    condition: cmd.kind === "test" ? "clean.test" : cmd.kind === "build" ? "clean.build" : "commands",
    component: cmd.component,
    kind: cmd.kind,
    contractId: cmd.id,
    strength: where === "container" ? "clean_replay" : "executed",
    where,
    result,
    command: cmd.command,
    summary: `${cmd.kind} ${result === "pass" ? "passed" : "failed: exit 1"}`,
  });
}

function fakeExecutor(outputs: Record<string, { exitCode: number; output: string }>, networkOff: boolean): Executor {
  const ex: Executor = {
    where: "container",
    strength: "clean_replay",
    image: "node:22-bookworm",
    imageSource: "audit",
    root: "/work",
    exec: async (command) => ({ timedOut: false, durationMs: 1, ...(outputs[command] ?? { exitCode: 0, output: "" }) }),
    offline: () => (ex.networkOff = networkOff),
    networkOff: null,
    close: () => {},
  };
  return ex;
}

describe("fixes from the independent pre-ship review", () => {
  test("Level 1 needs every test command to pass: a later passing command doesn't hide an earlier failure", () => {
    const audit = makeAudit({ components: [{ id: "api", share: 1, test: "fail" }] });
    addCommand(audit, { id: "cmd-api-test-2", kind: "test", component: "api", command: "true" }, "pass");
    const s = componentStates(audit, rubric, "api");
    assert.equal(s["clean.test"].state, "not_met");
    assert.equal(s.commands.state, "not_met");
  });

  test("a repo-wide command counts for every component", () => {
    const audit = makeAudit({ components: [{ id: "api", share: 0.5 }, { id: "web", share: 0.5 }] });
    addCommand(audit, { id: "cmd-repo-typecheck", kind: "typecheck", component: "*", command: "tsc --noEmit" }, "fail");
    for (const c of ["api", "web"]) assert.equal(componentStates(audit, rubric, c).commands.state, "not_met", c);
  });

  test("a host run after the replay doesn't turn a clean-container failure into a pass", () => {
    const audit = makeAudit({ components: [{ id: "api", share: 1, lint: "fail" }] });
    audit.evidence.push({ ...audit.evidence.find((e) => e.contractId === "cmd-api-lint")!, id: "ev-host", where: "host", strength: "executed", result: "pass", summary: "lint passed" });
    assert.equal(componentStates(audit, rubric, "api").commands.state, "not_met");
  });

  test("a test runner that prints failures and exits 0 hasn't passed", async () => {
    const cmd: ContractCommand = { id: "cmd-api-test", kind: "test", component: "api", cwd: ".", command: "vitest; true", source: "package.json scripts.test", reason: "test", timeoutSec: 60 };
    const ex = fakeExecutor({ "vitest; true": { exitCode: 0, output: "\u2139 tests 3\n\u2139 pass 2\n\u2139 fail 1\n" } }, true);
    const [r] = await runContract(ex, [cmd], { components: new Set(["api"]), budget: newBudget(10, 10), registryValues: [] });
    assert.equal(r.status, "fail");
    assert.match(r.diagnosis!.detail, /reported 1 failing tests but exited 0/);
  });

  test("when the network can't be switched off, the test phase's passes are blocked, not clean", async () => {
    const install: ContractCommand = { id: "cmd-repo-install", kind: "install", component: "*", cwd: ".", command: "npm ci", source: "readiness", reason: "install", timeoutSec: 60 };
    const testCmd: ContractCommand = { id: "cmd-api-test", kind: "test", component: "api", cwd: ".", command: "npm test", source: "package.json scripts.test", reason: "test", timeoutSec: 60 };
    const results = await runContract(fakeExecutor({}, false), [install, testCmd], { components: new Set(["api"]), budget: newBudget(10, 10), registryValues: [] });
    assert.equal(results.find((r) => r.cmd.kind === "install")!.blocked, undefined, "the online phase is unaffected");
    assert.equal(results.find((r) => r.cmd.kind === "test")!.blocked, NETWORK_ON);
  });

  test("a declared Dockerfile or build context outside the repository is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "inside-"));
    assert.equal(insideTree(root, ".cursor", "Dockerfile"), join(realpathSync(root), ".cursor", "Dockerfile"));
    assert.throws(() => insideTree(root, ".cursor", "../../../etc"), /points outside the repository/);
    mkdirSync(join(root, ".cursor"));
    symlinkSync(tmpdir(), join(root, ".cursor", "ctx"));
    assert.throws(() => insideTree(root, ".cursor", "ctx"), /points outside the repository/, "a symlink out of the tree is refused too");
  });

  test("on the host, a script that reaches for sudo is refused and reads as a limit of this machine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sudo-"));
    writeFileSync(join(dir, "start.sh"), "sudo service docker start\n");
    const cmd: ContractCommand = { id: "cmd-repo-install", kind: "install", component: "*", cwd: ".", command: "bash start.sh", source: "readiness", reason: "install", timeoutSec: 30 };
    const [r] = await runContract(hostExecutor(dir, [], false), [cmd], { components: new Set(["app"]), budget: newBudget(10, 10), registryValues: [] });
    assert.equal(r.status, "fail");
    assert.equal(r.blocked, "the install command uses sudo, which the audit never runs on the host");
  });

  test("with --inherit-env, values of secret-like variables are redacted too", () => {
    const audit = makeAudit({ components: [{ id: "api", share: 1 }] });
    audit.environment.inheritEnv = true;
    process.env.SA_READINESS_TEST_SECRET = "inherited-value-123";
    try {
      assert.ok(registryValuesOf(audit).includes("inherited-value-123"));
      audit.environment.inheritEnv = false;
      assert.ok(!registryValuesOf(audit).includes("inherited-value-123"));
    } finally {
      delete process.env.SA_READINESS_TEST_SECRET;
    }
  });

  test("contract add takes only commands the repo defines, cited where it defines them", () => {
    const repo = materialize("healthy-node");
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"]).code, 0);
    assert.equal(readiness(repo, ["scan"]).code, 0);
    const add = (cmd: string, source: string) => readiness(repo, ["contract", "add", "--kind", "test", "--component", "healthy-node", "--cmd", cmd, "--source", source, "--reason", "documented"]);
    const refused = (cmd: string, source: string, why: RegExp) => {
      const r = add(cmd, source);
      assert.notEqual(r.code, 0, `${cmd} --source ${source}`);
      assert.match(r.out, why);
    };
    refused("true", "agent", /passes whatever the repo does/);
    refused("true", "package.json:4", /passes whatever the repo does/);
    refused("true", "readiness", /--source must be `agent` or a file:line/);
    refused("npm run check || true", "agent", /hides its own failure/);
    refused("npm run check && node -e 1", "agent", /chains commands/);
    refused("node scripts/build.mjs", "agent", /doesn't run a script or Make target the repo defines/);
    refused("node --test test/extra.test.js", "AGENTS.md:1", /doesn't name `node --test test\/extra\.test\.js`/);
    refused("npm run docs", "AGENTS.md:3", /doesn't name `npm run docs`/);
    refused("npm run e2e", "docs/TESTING.md:4", /isn't in the audited commit/);
    refused("npm test", "../outside.md:1", /points outside the repository/);
    assert.match(readiness(repo, ["contract", "add", "--kind", "test", "--component", "healthy-node", "--cwd", "../..", "--cmd", "npm test", "--source", "AGENTS.md:5", "--reason", "x"]).out, /--cwd \.\.\/\.\. points outside the repository/);
    const tree = JSON.parse(readFileSync(join(repo, ".agent-readiness/work", readFileSync(join(repo, ".agent-readiness/work/CURRENT"), "utf8").trim(), "local.json"), "utf8")).tree;
    writeFileSync(join(tree, "AGENTS.md"), "`node -e 0`\n");
    refused("node -e 0", "AGENTS.md:1", /doesn't name `node -e 0`/);
    const cited = readiness(repo, ["contract", "add", "--kind", "test", "--component", "healthy-node", "--cwd", "test", "--cmd", "npm test", "--source", "AGENTS.md:5", "--reason", "documented"]);
    assert.equal(cited.code, 0, cited.out);
  });

  test("a seal with SA_READINESS_SEAL_KEY verifies only with that key; an unkeyed seal says so", () => {
    const keyed = { SA_READINESS_SEAL_KEY: "ci-secret-key-1" };
    const repo = materialize("healthy-node");
    assert.equal(readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"], keyed).code, 0);
    assert.match(readFileSync(join(repo, ".agent-readiness/latest/report.md"), "utf8"), /the seal is keyed/);
    assert.equal(readiness(repo, ["verify-seal"], keyed).code, 0);
    const wrong = readiness(repo, ["verify-seal"], { SA_READINESS_SEAL_KEY: "another-key" });
    assert.equal(wrong.code, 2);
    assert.match(wrong.out, /digest mismatch, or the wrong key/);
    assert.match(readiness(repo, ["verify-seal"], { SA_READINESS_SEAL_KEY: "" }).out, /has a keyed seal; set SA_READINESS_SEAL_KEY/);
    const plain = materialize("healthy-node");
    assert.equal(readiness(plain, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"], { SA_READINESS_SEAL_KEY: "" }).code, 0);
    const v = readiness(plain, ["verify-seal"], { SA_READINESS_SEAL_KEY: "" });
    assert.equal(v.code, 0);
    assert.match(v.out, /NOTE: the seal is an unkeyed digest/);
  });

  test("verify-seal fails when a sealed report is missing or the audit's history line was edited", () => {
    const repo = materialize("healthy-node");
    assert.equal(readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"]).code, 0);
    const hist = join(repo, ".agent-readiness/history/history.jsonl");
    const original = readFileSync(hist, "utf8");
    writeFileSync(hist, original.replace(/"repoLevel":\d/, '"repoLevel":4'));
    assert.match(readiness(repo, ["verify-seal"]).out, /line in history\.jsonl was edited after sealing/);
    writeFileSync(hist, original);
    const id = JSON.parse(original.trim().split("\n").pop()!).id;
    rmSync(join(repo, ".agent-readiness/history/audits", id, "report.md"));
    const v = readiness(repo, ["verify-seal"]);
    assert.equal(v.code, 2);
    assert.match(v.out, /report\.md is missing from the sealed audit/);
  });

  test("outcomes from a recorded PR file never stand as a production result", () => {
    const repo = materialize("healthy-node");
    const prs = join(mkdtempSync(join(tmpdir(), "prs-")), "prs.json");
    writeFileSync(prs, "[]");
    assert.equal(readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants", "--outcomes-input", prs]).code, 0);
    assert.match(readFileSync(join(repo, ".agent-readiness/latest/report.md"), "utf8"), /Outcomes come from a recorded PR file, not GitHub; not a production result/);
    const v = readiness(repo, ["verify-seal"]);
    assert.equal(v.code, 3);
    assert.match(v.out, /outcomes from a recorded PR file/);
    assert.equal(readiness(repo, ["verify-seal", "--allow-eval"]).code, 0);
  });

  test("co-author filters match whole words", () => {
    assert.ok(coAuthorMatches("Cursor Agent", "cursor"));
    assert.ok(!coAuthorMatches("Alex Lee", "e"));
    assert.ok(!coAuthorMatches("Cursorish Bot", "cursor"));
  });

  test("a recheck on a machine that can't prove the levels records no level, not a regression", () => {
    const repo = materialize("healthy-node");
    assert.equal(readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"]).code, 0);
    const r = readiness(repo, ["recheck", "--runtime", "none"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /: blocked \(no level: the last audit's levels couldn't be proved here \(no container runtime on this machine\)\)/);
    const line = JSON.parse(readFileSync(join(repo, ".agent-readiness/history/history.jsonl"), "utf8").trim().split("\n").pop()!);
    assert.equal(line.noLevel, true);
  });

  test("a component the last audit never saw sets the repo level as soon as it has its share", () => {
    const comps = makeAudit({ components: [{ id: "old", share: 0.4 }, { id: "new-svc", share: 0.6 }] }).profile!.components;
    const last = { id: "aud-1", kind: "audit" as const, date: "2026-10-01", commit: "x", rubric: "2026-10-alpha", scriptsDigest: "x", result: "sealed" as const, levels: { old: 1 as const }, repoLevel: 1 as const, scenarioLevels: {}, shares: { old: 1 }, active: ["old"], seedPinned: false };
    assert.deepEqual([...activeComponents(loadRubric("2026-11-alpha"), comps, [last])].sort(), ["new-svc", "old"]);
  });

  test("two folders with one name get two components", () => {
    const tree = mkdtempSync(join(tmpdir(), "ids-"));
    writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "root", private: true, workspaces: ["apps/*", "services/*"] }));
    for (const d of ["apps/api", "services/api"]) {
      mkdirSync(join(tree, d), { recursive: true });
      writeFileSync(join(tree, d, "package.json"), JSON.stringify({ name: d.replace("/", "-"), scripts: { test: "node --test" } }));
    }
    const ids = discoverComponents(tree, ["apps/api/package.json", "services/api/package.json"]).map((c) => c.id).sort();
    assert.deepEqual(ids, ["apps-api", "services-api"]);
  });

  test("Terraform next to a root package is listed on its own, so the root doesn't take its changes", () => {
    const tree = mkdtempSync(join(tmpdir(), "root-tf-"));
    writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node --test" } }));
    mkdirSync(join(tree, "infra"));
    writeFileSync(join(tree, "infra/main.tf"), "");
    const comps = discoverComponents(tree, ["package.json", "infra/main.tf", "test/a.test.js"]);
    assert.deepEqual(comps.map((c) => [c.id, c.assessed ? "assessed" : c.notAssessedReason ?? ""]), [["app", ""], ["infra", "Terraform isn't supported yet"]]);
  });

  test("history from a fresh clone reads the remote branch, and a push keeps every earlier line", () => {
    const repo = materialize("healthy-node");
    assert.equal(readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"]).code, 0);
    assert.equal(readiness(repo, ["history", "push"]).code, 0);
    const clone = join(mkdtempSync(join(tmpdir(), "clone-")), "c");
    execFileSync("git", ["clone", "-q", repo, clone]);
    assert.equal(readiness(clone, ["history"]).out.trim().split("\n").length, 1, "the clone sees the first audit");
    assert.equal(readiness(clone, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"]).code, 0);
    assert.equal(readiness(clone, ["history", "push"]).code, 0);
    const lines = execFileSync("git", ["show", "agent-readiness/history:history.jsonl"], { cwd: clone, encoding: "utf8" }).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(mergeHistory('{"id":"a"}\n', '{"id":"a"}\n{"id":"b"}\n'), '{"id":"a"}\n{"id":"b"}\n');
  });

  test("the eval gate fails a run that reads where faults were planted", () => {
    const call = (name: string, args: Record<string, unknown>) => ({ name, status: "completed", args });
    const t = { driver: "sdk" as const, text: "", durationMs: 0, tokens: null, error: null, toolCalls: [call("Read", { path: "/tmp/readiness-aud-1/mutants.json" }), call("Shell", { command: "cat $TMPDIR/readiness-aud-1/mutants.json" }), call("Read", { path: "src/pricing.js" })] };
    assert.equal(faultStoreReads(t).length, 2);
  });

  test("the shell gate flags writes to protected files, not protected paths that only appear in a heredoc or a later command", () => {
    for (const cmd of ["echo x > .agent-readiness/latest/report.md", "sed -i 's/1/2/' .agent-readiness/roadmap.json", "printf x | tee -a .cursor/skills/agent-readiness/rubric/2026-11-alpha.json", "rm -rf .agent-readiness/history"]) assert.ok(shellWritesProtected(cmd), cmd);
    const narrate = `cat > "$TMPDIR/readiness-narration.json" <<'EOF'\n{ "headline": "see .agent-readiness/latest/report.md" }\nEOF\nr() { node .cursor/skills/agent-readiness/scripts/readiness.ts "$@"; }; r narrate --file "$TMPDIR/readiness-narration.json" && r seal`;
    assert.equal(shellWritesProtected(narrate), false);
    assert.equal(shellWritesProtected("node .cursor/skills/agent-readiness/scripts/readiness.ts status > /tmp/status.txt"), false);
  });

  test("a crashed eval worker counts as a failed run, and a missing repeat is a regression", () => {
    const run = crashedRun({ id: "fixtures/x" }, 2, "m", "the worker exited with code 1 without a result");
    assert.equal(run.grade.gates[0].pass, false);
    const ok = { ...run, repeat: 1, grade: { ...run.grade, gates: [{ name: "levels", pass: true, detail: "" }] } };
    const summary = summarize([ok], { model: "m", driver: "sdk", repeats: 3 });
    assert.match(compare(summary, summary).regressions.join("\n"), /only 1 of 3 repeats left a result/);
  });

  test("a repo-wide install step names no component, and its reason is the failing install", () => {
    const audit = makeAudit({ install: "fail", components: [{ id: "api", share: 1 }] });
    audit.evidence.push({ ...audit.evidence[0], id: "ev-ok", component: "api", result: "pass", summary: "install passed" });
    const report = reportFor(audit);
    const step = report.details.steps.find((s) => s.itemId === "clean.install:repo")!;
    assert.ok(step.steps.every((s) => !s.detail.includes("--component the repo")), JSON.stringify(step.steps));
    assert.doesNotMatch(JSON.stringify(report.actions), /install passed/);
  });

  test("components held back for different reasons are each named with their own", () => {
    const report = reportFor(makeAudit({ components: [{ id: "api", share: 0.6, test: "fail" }, { id: "web", share: 0.4, test: "missing" }] }));
    assert.doesNotMatch(report.executive.headline, /api and web have no tests/);
    assert.match(report.executive.headline, /api fails its tests from a clean checkout and web has no tests/);
  });

  test("draft-env installs from the audit's own commands, never from a script calling itself", () => {
    const audit = makeAudit({ components: [{ id: "api", share: 1 }] });
    audit.contract.unshift({ id: "cmd-repo-declared", kind: "install", component: "*", cwd: ".", command: "bash scripts/agent-install.sh", source: ".cursor/environment.json install", reason: "declared", timeoutSec: 600 });
    const env = renderEnvFiles(audit, [], { dockerfile: false });
    assert.doesNotMatch(env.files["scripts/agent-install.sh"], /bash scripts\/agent-install\.sh/);
    assert.match(env.files["scripts/agent-install.sh"], /npm ci/);
  });

  test("instructions that weren't run aren't counted as checking out", () => {
    const audit = makeAudit({ components: [{ id: "api", share: 1 }], instructions: [{ id: "ins-1", source: "AGENTS.md", line: 3, kind: "command", text: "npm run dev", category: "long_running", staticResult: "pass", result: "not_run" }] });
    assert.equal(repoStates(audit, rubric).instructions.reason, "0 of 1 instruction items check out; 1 weren't run because they need access, run long or are risky");
  });

  test("replay runs the recorded commit, not whatever was written into the printed audit tree", () => {
    const repo = materialize("healthy-node");
    const init = readiness(repo, ["init", "--tier", "local-exec"]);
    const tree = init.out.match(/Audit tree: (\S+)/)![1];
    assert.equal(readiness(repo, ["scan"]).code, 0);
    writeFileSync(join(tree, "test", "pricing.test.js"), "process.exit(1);\n");
    assert.equal(readiness(repo, ["replay", "--runtime", "none", "--no-mutants"]).code, 0);
    const audit = JSON.parse(readFileSync(join(repo, ".agent-readiness/work", init.out.match(/Opened (\S+)/)![1], "audit.json"), "utf8")) as Audit;
    assert.equal(audit.evidence.find((e) => e.kind === "test")!.result, "pass");
  });
});
