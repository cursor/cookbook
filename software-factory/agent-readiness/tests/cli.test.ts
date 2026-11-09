import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { detectRuntime } from "../skill/agent-readiness/scripts/lib/container.ts";
import { saveDraft } from "../skill/agent-readiness/scripts/lib/workspace.ts";
import { paths } from "../skill/agent-readiness/scripts/lib/workspace.ts";
import { commitAll, materialize, readiness } from "../support/tools/fixture.ts";

function hostAudit(fixture: string, extra: string[] = [], env: Record<string, string> = {}) {
  const repo = materialize(fixture);
  const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", ...extra], env);
  assert.equal(r.code, 0, r.out);
  return repo;
}

const sealedDir = (repo: string) => {
  const dir = join(repo, ".agent-readiness/history/audits");
  return join(dir, readdirSync(dir).sort().pop()!);
};

describe("CLI", { concurrency: 4 }, () => {
  test("without a container runtime, Level 1 can't be proved and the report says why", () => {
    const repo = hostAudit("healthy-node");
    const r = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
    assert.equal(r.maturity.level, 0);
    assert.equal(r.maturity.couldBe, 1);
    assert.equal(r.components.included[0].couldBe, 1);
    assert.ok(r.details.record.some((x: { value: string }) => x.value.includes("fresh copy on the host")));
    const status = readFileSync(join(sealedDir(repo), "audit.json"), "utf8");
    assert.match(status, /"where": "fresh_copy"/);
  });

  test("empty SA_READINESS_IMAGE and SA_READINESS_RUNTIME mean the defaults", { skip: detectRuntime("auto") ? false : "no container runtime" }, () => {
    const repo = materialize("healthy-node");
    const r = readiness(repo, ["audit", "--tier", "local-exec", "--no-mutants"], { SA_READINESS_IMAGE: "", SA_READINESS_RUNTIME: "" });
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /Could not start a container|No container runtime/);
  });

  test("contract add and run refuse components the scan didn't find or can't assess", () => {
    const repo = materialize("nested-apps-dotnet");
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"]).code, 0);
    assert.equal(readiness(repo, ["scan"]).code, 0);
    const add = (component: string) => readiness(repo, ["contract", "add", "--kind", "typecheck", "--component", component, "--cmd", "npm run lint", "--source", "agent", "--reason", "the documented check"]);
    const unknown = add("storefront");
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.out, /No component named storefront\. Use \* for a repo-wide command or one of: admin-web, buyer-web\./);
    const skipped = add("commerce-core");
    assert.notEqual(skipped.code, 0);
    assert.match(skipped.out, /commerce-core isn't assessed \(\.NET isn't supported yet\), so replay wouldn't run its commands/);
    assert.equal(add("buyer-web").code, 0);
    const run = readiness(repo, ["run", "--component", "storefront"]);
    assert.notEqual(run.code, 0);
    assert.match(run.out, /No component named storefront/);
    const duplicate = readiness(repo, ["contract", "add", "--kind", "test", "--component", "buyer-web", "--cwd", "apps/buyer-web", "--cmd", "npm test", "--source", "README.md:3", "--reason", "the documented test command"]);
    assert.notEqual(duplicate.code, 0);
    assert.match(duplicate.out, /cmd-buyer-web-test already runs the test script for buyer-web \(`npm run test`\), so it would run twice/);
    const status = readiness(repo, ["status"]);
    assert.match(status.out, /Part 1 now: /, "status shows the part 1 the seal would build, so narration can use its ids");
    assert.match(status.out, /Repo level: not assessed/, "before anything ran, status gives no level");
    assert.match(status.out, /buyer-web: not assessed/);
    const json = readiness(repo, ["status", "--json"]).out;
    assert.match(json, /no blocking findings; 1 item listed for review/);
    assert.doesNotMatch(json, /blocked: blocked:/);
    const scenario = readiness(repo, ["scenario", "add", "bug_fixes", "--components", "commerce-core"]);
    assert.notEqual(scenario.code, 0);
    assert.match(scenario.out, /commerce-core isn't assessed \(\.NET isn't supported yet\), so it has no level for a scenario to break down\. Use one of: admin-web, buyer-web\./);
    assert.doesNotMatch(scenario.out, /replay/);
  });

  test("status words every tier as the report does", () => {
    const repo = materialize("healthy-node");
    for (const args of [["init", "--tier", "local-exec"], ["scan"], ["scenario", "add", "bug_fixes", "--components", "healthy-node"], ["replay", "--runtime", "none", "--no-mutants"]]) assert.equal(readiness(repo, args).code, 0, args.join(" "));
    const status = readiness(repo, ["status"]).out;
    assert.match(status, /Repo level: Level 1 unproven on this machine \(could be 1\)/);
    assert.match(status, /healthy-node: Level 1 unproven on this machine \(could be 1\); scenarios bug_fixes Level 1 unproven on this machine \(could be 1\)/);
    assert.doesNotMatch(status, /level Level/);
  });

  test("--no-mutants is disclosed with its own reason, not as a blocked check", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    const report = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
    assert.equal(report.details.checks.find((c: { id: string }) => c.id === "verify.behavioral_oracle").result, "healthy-node: planted faults skipped by --no-mutants");
    assert.ok(report.details.record.some((x: { label: string; value: string }) => x.label === "Planted faults" && x.value === "not planted: --no-mutants skipped them, so no fault check ran"));
    assert.ok(!report.components.included[0].capReasons.some((c: { condition: string; state: string }) => c.condition === "faults" && c.state === "blocked"));
  });

  test("an error while planting faults is contained: the other results are kept and the fault check says why", () => {
    const repo = materialize("healthy-node");
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    const stamp = "node -e \"const fs=require('fs');for(const f of fs.readdirSync('src'))fs.writeFileSync('src/'+f,'// built\\n'+fs.readFileSync('src/'+f,'utf8'))\"";
    writeFileSync(join(repo, "package.json"), JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, build: stamp } }, null, 2));
    commitAll(repo, "Stamp sources at build time");
    const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none"]);
    assert.equal(r.code, 0, r.out);
    const report = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
    const evidence = report.details.evidence as { summary: string; result: string }[];
    assert.ok(evidence.some((e) => e.summary.startsWith("test passed")), "the test results are kept");
    assert.ok(evidence.some((e) => /^planting faults failed: Line \d+ of src\/\S+ changed since the site was chosen$/.test(e.summary)), JSON.stringify(evidence.map((e) => e.summary)));
  });

  test("scan offers external-systems when agents already open PRs here", () => {
    const repo = materialize("healthy-node");
    writeFileSync(join(repo, "notes.md"), "x\n");
    commitAll(repo, "Merge pull request #12 from example/cursor/fix-rounding");
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"]).code, 0);
    const scan = readiness(repo, ["scan"]);
    assert.match(scan.out, /Agent work in the history \(1 agent branch merge\)\. Offer --tier external-systems/);
  });

  test("on a host fallback, a missing tool blocks the checks, and with no real results part 1 gives no level", () => {
    const repo = materialize("healthy-node");
    mkdirSync(join(repo, ".cursor"));
    writeFileSync(join(repo, ".cursor/environment.json"), JSON.stringify({ install: "readiness-test-missing-toolchain restore && npm ci" }));
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, preinstall: "readiness-test-missing-toolchain check" } }, null, 2));
    commitAll(repo, "Declare the install");
    const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"]);
    assert.equal(r.code, 0, r.out);
    const report = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
    assert.equal(report.maturity.outcome, "not_assessed");
    assert.equal(report.maturity.confidence.level, "low");
    assert.equal(report.executive.heading, "Not assessed: no check could run on this machine");
    assert.deepEqual(report.actions, [], "no fix is offered for a limit of this machine");
    assert.match(report.executive.headline, /^Nothing could be checked on this machine, so this audit gives no level: readiness-test-missing-toolchain is not installed on this machine\./);
    assert.match(report.executive.coverage, /Level 1 isn't provable on this machine: it has no container runtime, so setup ran in a fresh copy on the host\./);
    assert.match(report.executive.coverage, /On this machine readiness-test-missing-toolchain is not installed, an environment limit rather than a repo defect\./);
    assert.ok(report.details.evidence.some((e: { result: string }) => e.result === "blocked"));
    assert.ok(report.details.evidence.filter((e: { result: string }) => e.result === "not_run").every((e: { where: string }) => e.where === "not run"), "a step that never ran doesn't say where it ran");
    assert.deepEqual(report.components.included.map((c: { level: number | null }) => c.level), [null]);
    const history = readFileSync(join(repo, ".agent-readiness/history/history.jsonl"), "utf8");
    assert.match(history, /"note":"no level: nothing could run on this machine/);
    const status = readiness(repo, ["history"]).out;
    assert.match(status, /repo not assessed/);
  });

  test("when one app's toolchain blocks the shared install, the other apps still install, run and get planted faults on their own", () => {
    const repo = materialize("nested-apps-dotnet");
    // A tool no machine has stands in for the .NET SDK, so the test doesn't depend on the runner.
    writeFileSync(join(repo, ".cursor/environment.json"), JSON.stringify({ install: "readiness-test-dotnet restore services/commerce-core/CommerceCore.csproj && cd apps/buyer-web && npm ci" }));
    commitAll(repo, "Install through one script");
    const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none"]);
    assert.equal(r.code, 0, r.out);
    const report = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
    const ev = (component: string, kind: string) => report.details.evidence.filter((e: { component: string; ran: string; summary: string }) => e.component === component && (e.summary.startsWith(kind) || e.summary.includes(kind)));
    assert.ok(report.details.evidence.some((e: { result: string; summary: string }) => e.result === "blocked" && /readiness-test-dotnet is not installed/.test(e.summary)), "the shared install is blocked by the missing toolchain");
    for (const app of ["buyer-web", "admin-web"]) {
      assert.ok(ev(app, "install passed").length > 0, `${app} installed on its own`);
      assert.ok(ev(app, "test passed").length > 0, `${app}'s tests ran`);
      assert.ok(ev(app, "planted faults").length > 0, `${app} got planted faults`);
      assert.ok(ev(app, "test passed (").some((e: { summary: string }) => /^test passed \(\d+ of \d+ tests\)$/.test(e.summary)), `${app}'s test count is in the report`);
    }
    assert.ok(report.details.evidence.some((e: { summary: string }) => /^caught 0 of \d+ planted faults; missed: \w+ at apps\/admin-web\/src\/roles\.js:\d+/.test(e.summary)), "the missed faults are named by operator and line");
    assert.equal(report.actions[0].itemId, "faults:admin-web", "the test gap can start now, without the clean container");
    assert.equal(report.actions[0].startNow, true);
    assert.match(report.executive.gaps[0].blocks, /^Can start now; blocks Level 2 for admin-web/);
    assert.equal(report.maturity.outcome, "blocked", "real results exist, and Level 1 still needs a clean container");
    assert.equal(report.executive.heading, "Level 1 unproven on this machine: no Level 1 check failed, and 3 were blocked here", "install, build and test, each blocked without a container");
    assert.ok(report.components.included.every((c: { level: number; capReasons: { state: string }[] }) => c.level === 0 && c.capReasons.every((x) => x.state === "blocked")), JSON.stringify(report.components.included));
  });

  test("a sealed audit refuses further writes", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    const r = readiness(repo, ["record", "--check", "scope.profile", "--result", "pass", "--summary", "x"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /No draft audit is open/);
    const sealed = JSON.parse(readFileSync(join(sealedDir(repo), "audit.json"), "utf8"));
    assert.throws(() => saveDraft(paths(repo), sealed), /sealed and refuses further writes/);
  });

  test("verify-seal passes, then catches an edited audit and an edited report", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    assert.equal(readiness(repo, ["verify-seal"]).code, 0);
    const f = join(sealedDir(repo), "audit.json");
    const original = readFileSync(f, "utf8");
    writeFileSync(f, original.replace('"tier": "local-exec"', '"tier": "read-only"'));
    const edited = readiness(repo, ["verify-seal"]);
    assert.equal(edited.code, 2);
    assert.match(edited.out, /edited after sealing/);
    writeFileSync(f, original);
    writeFileSync(join(sealedDir(repo), "report.md"), "# all green\n");
    assert.equal(readiness(repo, ["verify-seal"]).code, 2);
  });

  test("a pinned eval seed is labeled and never passes as a production result", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"], { SA_READINESS_EVAL_SEED: "eval-1" });
    const r = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
    assert.equal(r.audit.seedPinned, true);
    assert.match(readFileSync(join(repo, ".agent-readiness/latest/report.md"), "utf8"), /pinned seed; not a production result/);
    assert.equal(readiness(repo, ["verify-seal"]).code, 3);
    assert.equal(readiness(repo, ["verify-seal", "--allow-eval"]).code, 0);
  });

  test("tiers and modes refuse what they don't allow", () => {
    const repo = materialize("healthy-node");
    readiness(repo, ["init", "--tier", "read-only"]);
    readiness(repo, ["scan"]);
    assert.match(readiness(repo, ["replay"]).out, /read-only tier doesn't run repo code/);
    assert.match(readiness(repo, ["record", "--check", "verify.behavioral_oracle", "--result", "pass", "--strength", "executed", "--summary", "I checked"]).out, /can't create executed evidence/);
    assert.match(readiness(repo, ["outcomes"]).out, /needs the external-systems tier/);
    assert.match(readiness(repo, ["roadmap", "targets", "--merge-rate", "0.7", "--first-pass", "0.6", "--max-changes-requested", "0.3", "--min-prs", "5"]).out, /can't go below 10/);
    assert.equal(readiness(repo, ["roadmap", "targets", "--merge-rate", "0.7", "--first-pass", "0.6", "--max-changes-requested", "0.3"]).code, 0);
    assert.match(readiness(repo, ["draft-skill"]).out, /pass --remediate/);
    assert.match(readiness(repo, ["assets", "--org", "example-org"]).out, /needs --tier external-systems/);
    assert.match(readiness(repo, ["init", "--registry-env", "npm_token=abc"]).out, /takes variable names, not values/);
  });

  test("draft-env writes only allowed files once, and draft-skill writes only passing commands", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    assert.equal(readiness(repo, ["draft-env", "--remediate"]).code, 0);
    const env = JSON.parse(readFileSync(join(repo, ".cursor/environment.json"), "utf8"));
    assert.deepEqual(Object.keys(env).sort(), ["install", "name", "start"]);
    assert.match(readiness(repo, ["draft-env", "--remediate"]).out, /already exists/);
    assert.equal(readiness(repo, ["draft-skill", "--remediate"]).code, 0);
    const skill = readFileSync(join(repo, ".cursor/skills/verify/SKILL.md"), "utf8");
    assert.match(skill, /^---\nname: verify\ndescription: /);
    assert.match(skill, /npm run lint/);
    assert.match(readiness(repo, ["draft-skill", "--remediate", "--force", "--include", "cmd-made-up"]).out, /no passing run/);
  });

  test("feedback bundles hold the check, digests and note, and no source code", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    const r = readiness(repo, ["feedback", "bootstrap.cold_replay", "--note", "Our CI uses a different image"]);
    assert.equal(r.code, 0, r.out);
    const dir = join(repo, ".agent-readiness/feedback");
    const bundle = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
    assert.equal(bundle.check, "bootstrap.cold_replay");
    assert.equal(bundle.rubric, "2026-11-alpha");
    assert.ok(!JSON.stringify(bundle).includes("outputTail"));
    assert.ok(!JSON.stringify(bundle).includes("isAdult"));
  });

  test("history goes to its own branch and the roadmap and latest report stay for main", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    assert.match(readiness(repo, ["history", "push"]).out, /committed history to agent-readiness\/history/);
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "agent-readiness/history"], { cwd: repo, encoding: "utf8" });
    assert.match(files, /history\.jsonl/);
    assert.match(files, /audits\/aud-.*\/audit\.json/);
    assert.equal(readFileSync(join(repo, ".agent-readiness/.gitignore"), "utf8"), "work/\nhistory/\nfeedback/\ncli.log\n");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.match(status, /\.agent-readiness\//);
    execFileSync("git", ["add", ".agent-readiness"], { cwd: repo });
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean).sort();
    assert.deepEqual(staged, [".agent-readiness/.gitignore", ".agent-readiness/latest/report.html", ".agent-readiness/latest/report.json", ".agent-readiness/latest/report.md", ".agent-readiness/roadmap.json"]);
  });

  test("a run that starts from the history branch appends to it instead of replacing it", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    readiness(repo, ["history", "push"]);
    rmSync(join(repo, ".agent-readiness/history"), { recursive: true });
    assert.equal(readiness(repo, ["audit", "--runtime", "none", "--no-mutants"]).code, 0);
    readiness(repo, ["history", "push"]);
    const lines = execFileSync("git", ["show", "agent-readiness/history:history.jsonl"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
    assert.equal(lines.length, 2);
    const report = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
    assert.equal(report.progress.history.length, 2);
  });

  test("diff flags weakened tests between two audits", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    const f = join(repo, "test/pricing.test.js");
    writeFileSync(f, readFileSync(f, "utf8").replace('test("discount takes 10 off from 100"', 'test.skip("discount takes 10 off from 100"'));
    commitAll(repo, "Skip a test");
    assert.equal(readiness(repo, ["audit", "--runtime", "none", "--no-mutants"]).code, 0);
    const d = readiness(repo, ["diff"]);
    assert.equal(d.code, 1);
    assert.match(d.out, /new skip markers/);
    const report = readFileSync(join(repo, ".agent-readiness/latest/report.md"), "utf8");
    assert.match(report, /New skip or only markers: `test\/pricing\.test\.js`/);
  });

  test("validate and version", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    assert.match(readiness(repo, ["validate", ".agent-readiness/latest/report.json"]).out, /valid report/);
    assert.match(readiness(repo, ["validate", ".agent-readiness/roadmap.json"]).out, /valid roadmap/);
    writeFileSync(join(repo, "bad.json"), JSON.stringify({ schema: "agent-readiness/report@1" }));
    assert.match(readiness(repo, ["validate", "bad.json"]).out, /not a valid report/);
    assert.match(readiness(repo, ["version"]).out, /agent-readiness skill 0\.1\.0 \(agent-readiness-v0\.1\.0\), rubric 2026-11-alpha/);
  });
});
