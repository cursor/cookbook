import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { cases as resilienceCases } from "../support/evals/cases/resilience.ts";
import { gradeCase } from "../support/evals/lib/grade.ts";
import type { Trajectory } from "../support/evals/lib/types.ts";
import { caseEnv, prepare } from "../support/evals/lib/workspace.ts";
import { addContractCommand, checkOnly, discoverContract } from "../skill/agent-readiness/scripts/lib/contract.ts";
import { buildProfile } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { CUT_OFF, REWROTE, hostExecutor, newBudget, replayInstructions, runContract } from "../skill/agent-readiness/scripts/lib/replay.ts";
import type { Executor } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { repoStates } from "../skill/agent-readiness/scripts/lib/score.ts";
import { instructionItems, vendoredSkills } from "../skill/agent-readiness/scripts/lib/static.ts";
import type { ContractCommand, InstructionItem } from "../skill/agent-readiness/scripts/lib/types.ts";
import { materialize, readiness } from "../support/tools/fixture.ts";
import { makeAudit } from "./helpers.ts";

const rubric = loadRubric();
const tmp = () => mkdtempSync(join(tmpdir(), "readiness-sandbox-"));

function gitRepo(files: Record<string, string>): string {
  const dir = tmp();
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Contributor A", "-c", "user.email=a@example.com", "commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

const cmd = (id: string, kind: ContractCommand["kind"], command: string, component = "app"): ContractCommand => ({ id, kind, component, cwd: ".", command, source: "readiness", reason: kind, timeoutSec: 60 });

function recordingExecutor(outputs: (command: string, n: number) => { exitCode: number; output?: string; durationMs?: number }): Executor & { ran: { command: string; timeoutSec: number }[] } {
  const ran: { command: string; timeoutSec: number }[] = [];
  const ex = {
    where: "container" as const,
    strength: "clean_replay" as const,
    image: "node:22-bookworm",
    imageSource: "audit" as const,
    root: tmp(),
    ran,
    exec: async (command: string, _cwd: string, timeoutSec: number) => {
      ran.push({ command, timeoutSec });
      const r = outputs(command, ran.filter((x) => x.command === command).length);
      return { timedOut: false, durationMs: r.durationMs ?? 1, output: r.output ?? "", exitCode: r.exitCode };
    },
    offline: () => (ex.networkOff = true),
    networkOff: null as boolean | null,
    close: () => {},
  };
  return ex;
}

describe("write-mode lint runs check-only", () => {
  const scripts = { lint: "biome check --write --unsafe .", "lint:all": "npm run lint:js && npm run fmt", "lint:js": "eslint . --fix --cache", fmt: "prettier --write .", plain: "eslint .", version: "black --version" };

  test("write flags are removed and formatters switch to their check mode", () => {
    const cases: [string, string][] = [
      ["ruff check --fix . && ruff format .", "ruff check . && ruff format --check ."],
      ["npx prettier -w src", "npx prettier --check src"],
      ["black src", "black --check src"],
      ["isort .", "isort --check-only ."],
      ["dprint fmt", "dprint check"],
      ["npx @biomejs/biome@1.9 check --apply-unsafe .", "npx @biomejs/biome@1.9 check ."],
      ["tsc --noEmit && eslint --fix-type problem --fix src", "tsc --noEmit && eslint src"],
      ["FORCE_COLOR=0 npx --yes stylelint '**/*.css' --fix", "FORCE_COLOR=0 npx --yes stylelint '**/*.css'"],
    ];
    for (const [from, to] of cases) assert.equal(checkOnly(from, {}, "npm").command, to, from);
  });

  test("a script call is inlined, including the scripts it calls, and run with the package's binaries", () => {
    assert.deepEqual(checkOnly("npm run lint", scripts, "npm"), { command: "npm exec -c 'biome check .'", changes: ["without --write", "without --unsafe"] });
    assert.equal(checkOnly("npm run lint:all", scripts, "npm").command, "npm exec -c 'eslint . --cache && prettier --check .'");
    assert.equal(checkOnly("corepack pnpm run lint", scripts, "pnpm").command, "corepack pnpm exec sh -c 'biome check .'");
    assert.equal(checkOnly("corepack yarn run lint", scripts, "yarn").command, "corepack yarn exec sh -c 'biome check .'");
  });

  test("a command that writes nothing comes back unchanged", () => {
    for (const c of ["npm run plain", "isort --check-only .", "prettier --check .", "npm run version", "eslint --fix-dry-run ."]) assert.deepEqual(checkOnly(c, scripts, "npm"), { command: c, changes: [] }, c);
  });

  test("the scan's lint command and an agent's both run check-only, and the declared command is kept", () => {
    const repo = gitRepo({ "package.json": JSON.stringify({ name: "app", scripts: { lint: "biome check --write --unsafe .", test: "node --test" } }), "package-lock.json": "{}", ".nvmrc": "22\n" });
    const profile = buildProfile(repo, repo, rubric);
    const lint = discoverContract(profile, repo, rubric, []).find((c) => c.kind === "lint")!;
    assert.equal(lint.command, "npm exec -c 'biome check .'");
    assert.equal(lint.declared, "npm run lint");
    assert.match(lint.reason, /run check-only \(without --write, without --unsafe\) so it can't rewrite the code/);
    const cmds: ContractCommand[] = [];
    const added = addContractCommand(cmds, { kind: "lint", component: "app", cwd: ".", command: "npx eslint . --fix", source: "agent", reason: "the documented lint" }, profile);
    assert.deepEqual([added.command, added.declared], ["npx eslint .", "npx eslint . --fix"]);
  });
});

describe("lint runs before the build, and a check that rewrites code fails", () => {
  test("lint runs after the install and before the build; type-check and tests after it", async () => {
    const ex = recordingExecutor(() => ({ exitCode: 0 }));
    await runContract(ex, [cmd("b", "build", "build"), cmd("l", "lint", "lint"), cmd("y", "typecheck", "typecheck"), cmd("t", "test", "test"), cmd("i", "install", "install", "*")], { components: new Set(["app"]), budget: newBudget(10, 10), registryValues: [] });
    assert.deepEqual(ex.ran.map((r) => r.command), ["install", "lint", "build", "typecheck", "test"]);
  });

  test("a lint that fails before the build runs once more after it, and the second result stands", async () => {
    const ex = recordingExecutor((c, n) => ({ exitCode: c === "lint" && n === 1 ? 1 : 0, output: "Cannot find module '@acme/core'" }));
    const results = await runContract(ex, [cmd("i", "install", "install", "*"), cmd("b", "build", "build"), cmd("l", "lint", "lint")], { components: new Set(["app"]), budget: newBudget(10, 10), registryValues: [] });
    assert.deepEqual(ex.ran.map((r) => r.command), ["install", "lint", "build", "lint"]);
    const lint = results.find((r) => r.cmd.kind === "lint")!;
    assert.deepEqual([lint.status, lint.note], ["pass", "failed before the build and passed after it"]);
    assert.equal(results.filter((r) => r.cmd.kind === "lint").length, 1, "one result per command");
    const failing = recordingExecutor((c) => ({ exitCode: c === "lint" ? 1 : 0 }));
    const twice = await runContract(failing, [cmd("i", "install", "install", "*"), cmd("b", "build", "build"), cmd("l", "lint", "lint")], { components: new Set(["app"]), budget: newBudget(10, 10), registryValues: [] });
    assert.deepEqual(twice.filter((r) => r.cmd.kind === "lint").map((r) => [r.status, r.note]), [["fail", "failed before the build and again after it"]]);
    const noBuild = recordingExecutor((c) => ({ exitCode: c === "lint" ? 1 : 0 }));
    await runContract(noBuild, [cmd("l", "lint", "lint")], { components: new Set(["app"]), budget: newBudget(10, 10), registryValues: [] });
    assert.deepEqual(noBuild.ran.map((r) => r.command), ["lint"], "without a build there is nothing to retry after");
  });

  test("a lint that still rewrites a file fails, and the file is put back from the audited commit", async () => {
    const tree = tmp();
    const copy = tmp();
    for (const d of [tree, copy]) {
      mkdirSync(join(d, "src"));
      writeFileSync(join(d, "src/a.js"), "export const a = 1;\n");
    }
    const rewrite = `node -e "require('fs').writeFileSync('src/a.js', 'export const a = 1\\n')"`;
    const [r] = await runContract(hostExecutor(copy, [], false), [cmd("l", "lint", rewrite)], { components: new Set(["app"]), budget: newBudget(10, 10), registryValues: [], tree });
    assert.equal(r.status, "fail");
    assert.equal(r.diagnosis!.detail, `it changed 1 file (src/a.js), ${REWROTE}`);
    assert.equal(readFileSync(join(copy, "src/a.js"), "utf8"), "export const a = 1;\n", "restored for the steps after it");
  });
});

describe("instruction replay stays inside the total budget", () => {
  const items = (): InstructionItem[] => ["npm run a", "npm run b"].map((text, i) => ({ id: `ins-00${i + 1}`, source: "AGENTS.md", line: i + 1, kind: "command", text, category: "replay", staticResult: "pass", result: "not_run", reason: "waiting for replay" }));

  test("once --budget-total is spent no instruction starts, and each is listed as cut off", async () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1 }] });
    audit.instructions = items();
    const budget = newBudget(15, 1);
    budget.startedAt = Date.now() - 61000;
    const ex = recordingExecutor(() => ({ exitCode: 0 }));
    await replayInstructions(audit, ex, ex.root, budget, [], null);
    assert.deepEqual(ex.ran, []);
    assert.deepEqual(audit.instructions.map((i) => [i.result, i.reason]), [["not_run", CUT_OFF], ["not_run", CUT_OFF]]);
    assert.equal(repoStates(audit, rubric).instructions.state, "unknown", "cut off is unproven, not passed");
  });

  test("each instruction gets at most what is left of the budget", async () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1 }] });
    audit.instructions = items();
    const budget = newBudget(15, 1);
    budget.startedAt = Date.now() - 50000;
    const ex = recordingExecutor(() => ({ exitCode: 0 }));
    await replayInstructions(audit, ex, ex.root, budget, [], null);
    assert.ok(ex.ran.length > 0 && ex.ran.every((r) => r.timeoutSec <= 10), JSON.stringify(ex.ran));
  });
});

describe("instructions that can't be replayed as written are skipped", () => {
  test("placeholders, questions, package changes and write-mode lint are listed as skipped; a real wrong instruction still fails", () => {
    const agents = ["- One test: `node --test test/<name>.test.js`", "- New app: `npm init -y`", "- Sign in: `npm login --scope=@acme`", "- Add a helper: `npm i -D date-fns`", "- Lint and fix: `npm run lint`", "- Wrong manager: `pnpm add date-fns`", "- Test: `npm test`"].join("\n");
    const repo = gitRepo({ "package.json": JSON.stringify({ name: "app", scripts: { lint: "eslint . --fix", test: "node --test" } }), "package-lock.json": "{}", "AGENTS.md": agents + "\n" });
    const items = instructionItems(repo, buildProfile(repo, repo, rubric));
    const by = new Map(items.map((i) => [i.text, i]));
    assert.match(by.get("node --test test/<name>.test.js")!.reason!, /placeholder/);
    assert.match(by.get("npm init -y")!.reason!, /asks questions/);
    assert.match(by.get("npm login --scope=@acme")!.reason!, /asks questions/);
    assert.match(by.get("npm i -D date-fns")!.reason!, /adds or removes packages/);
    assert.match(by.get("npm run lint")!.reason!, /rewrites files as written; the commands check runs it check-only \(without --fix\)/);
    for (const t of ["node --test test/<name>.test.js", "npm init -y", "npm i -D date-fns", "npm run lint"]) assert.deepEqual([by.get(t)!.category, by.get(t)!.result], ["skipped", "not_run"], t);
    assert.deepEqual([by.get("pnpm add date-fns")!.result, by.get("pnpm add date-fns")!.reason], ["fail", "uses pnpm, but the repo uses npm"], "the static check still wins for first-party instructions");
    assert.equal(by.get("npm test")!.category, "replay");
  });

  test("a vendored skill's commands are skipped, its copy is checked once, and a first-party skill is still replayed", () => {
    const vendored = "---\nname: ui-kit\ndescription: Adds ui-kit components.\n---\n\n- `npx ui-kit@latest search --json`\n- `pnpm add date-fns`\n";
    const repo = gitRepo({
      "package.json": JSON.stringify({ name: "app", scripts: { test: "node --test", changelog: "node changelog.js" } }),
      "package-lock.json": "{}",
      "skills-lock.json": JSON.stringify({ version: 1, skills: { "ui-kit": { source: "example-ui/skills" } } }),
      ".agents/skills/ui-kit/SKILL.md": vendored,
      ".cursor/skills/ui-kit/SKILL.md": vendored,
      ".agents/skills/licensed/SKILL.md": "---\nname: licensed\ndescription: x\n---\n\n- `npx licensed-tool check`\n",
      ".agents/skills/licensed/LICENSE.txt": "MIT\n",
      ".agents/skills/sourced/SKILL.md": "---\nname: sourced\ndescription: x\nsource: example-org/skills\n---\n\n- `npx sourced-tool run`\n",
      ".cursor/skills/release-notes/SKILL.md": "---\nname: release-notes\ndescription: x\n---\n\n- `npm run changelog`\n",
    });
    mkdirSync(join(repo, ".claude/skills"), { recursive: true });
    symlinkSync("../../.agents/skills/sourced", join(repo, ".claude/skills/sourced"));
    const profile = buildProfile(repo, repo, rubric);
    const found = vendoredSkills(repo, profile.instructionFiles);
    assert.equal(found.get(".agents/skills/ui-kit/SKILL.md"), "example-ui/skills, listed in skills-lock.json");
    assert.equal(found.get(".agents/skills/licensed/SKILL.md"), "it ships its own license");
    assert.equal(found.get(".agents/skills/sourced/SKILL.md"), "from example-org/skills");
    assert.equal(found.has(".cursor/skills/release-notes/SKILL.md"), false);
    const items = instructionItems(repo, profile).filter((i) => i.kind === "command");
    const sources = (text: string) => items.filter((i) => i.text === text).map((i) => i.source);
    assert.deepEqual(sources("pnpm add date-fns"), [".agents/skills/ui-kit/SKILL.md"], "the identical copy in .cursor/skills is checked once");
    assert.deepEqual(sources("npx sourced-tool run"), [".agents/skills/sourced/SKILL.md"], "the symlinked .claude/skills copy is checked once");
    for (const i of items.filter((x) => x.source.startsWith(".agents/"))) {
      assert.equal(i.category, "skipped", i.text);
      assert.match(i.reason!, /^not replayed: it comes from a vendored skill \(.+\), so it documents that tool, not this repo$/);
    }
    assert.deepEqual(items.filter((i) => i.text === "npm run changelog").map((i) => i.category), ["replay"]);
  });

  test("the instructions condition names what was skipped", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1 }] });
    audit.instructions = [
      { id: "ins-001", source: "AGENTS.md", line: 1, kind: "command", text: "npm test", category: "replay", staticResult: "pass", result: "pass" },
      { id: "ins-002", source: ".agents/skills/x/SKILL.md", line: 2, kind: "command", text: "pnpm add x", category: "skipped", staticResult: "pass", result: "not_run", reason: "vendored" },
    ];
    const s = repoStates(audit, rubric).instructions;
    assert.equal(s.state, "met");
    assert.equal(s.reason, "1 of 2 instruction items check out; 1 was skipped as vendored-skill, placeholder, interactive or package-adding commands");
  });
});

describe("the read-only tier", () => {
  test("audit --tier read-only scans and seals with no replay, and the report gives no level", () => {
    const repo = materialize("healthy-node");
    const r = readiness(repo, ["audit", "--tier", "read-only"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Read-only tier: scanned only\. No repo code ran/);
    assert.doesNotMatch(r.out, /Replaying|read-only tier doesn't run repo code/);
    const report = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
    assert.equal(report.maturity.outcome, "not_assessed");
    assert.equal(report.executive.heading, "Not assessed: the read-only tier runs no repo code");
    const dir = join(repo, ".agent-readiness/history/audits", report.audit.id);
    const audit = JSON.parse(readFileSync(join(dir, "audit.json"), "utf8"));
    assert.deepEqual(audit.evidence.filter((e: { strength: string }) => e.strength === "executed" || e.strength === "clean_replay"), []);
    const log = readFileSync(join(repo, ".agent-readiness/cli.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).argv[0]);
    assert.deepEqual(log, ["audit"]);
    assert.equal(readiness(repo, ["verify-seal"]).code, 0);
  });

  test("the read-only-tier eval case passes a scripted read-only audit and fails one that replays", () => {
    const c = { ...resilienceCases.find((x) => x.id === "read-only-tier")!, id: "resilience/read-only-tier" };
    const none: Trajectory = { driver: "external", toolCalls: [], text: "", durationMs: 0, tokens: null, error: null };
    const ws = prepare(c);
    const cli = join(ws.dir, ".cursor/skills/agent-readiness/scripts/readiness.ts");
    assert.equal(readiness(ws.dir, ["audit", "--tier", "read-only"], caseEnv(c), cli).code, 0);
    const gates = gradeCase(ws, none, c);
    assert.deepEqual(gates.filter((g) => !g.pass), [], JSON.stringify(gates));
    const replayed: Trajectory = { ...none, driver: "sdk", toolCalls: [{ name: "shell", status: "completed", args: { command: `node ${cli} replay --no-mutants` } }] };
    assert.match(gradeCase(ws, replayed, c).find((g) => g.name === "no replay or run")!.detail, /replay --no-mutants/);
    const local = prepare(c);
    assert.equal(readiness(local.dir, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"], caseEnv(c), join(local.dir, ".cursor/skills/agent-readiness/scripts/readiness.ts")).code, 0);
    assert.equal(gradeCase(local, none, c).find((g) => g.name.startsWith("read-only audit"))!.pass, false, "a local-exec audit fails the read-only gate");
  });
});

describe("new fixtures on a host fallback", { concurrency: 2 }, () => {
  const host = (fixture: string) => {
    const repo = materialize(fixture);
    const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none"], { SA_READINESS_EVAL_SEED: "fixture-seed" });
    assert.equal(r.code, 0, r.out);
    const report = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
    return { out: r.out, report, audit: JSON.parse(readFileSync(join(repo, ".agent-readiness/history/audits", report.audit.id, "audit.json"), "utf8")) };
  };
  const ran = (audit: { evidence: { command?: string }[] }) => audit.evidence.map((e) => e.command ?? "").filter(Boolean);

  test("write-mode-lint: no write flag runs, lint passes before the build, and faults are planted", () => {
    const { audit } = host("write-mode-lint");
    assert.deepEqual(ran(audit).filter((c) => c.includes("--fix")), []);
    const lint = audit.evidence.find((e: { kind?: string }) => e.kind === "lint");
    assert.deepEqual([lint.command, lint.result], ["npm exec -c 'node scripts/lint.mjs'", "pass"]);
    assert.ok(audit.evidence.findIndex((e: { kind?: string }) => e.kind === "lint") < audit.evidence.findIndex((e: { kind?: string }) => e.kind === "build"), "lint before build");
    assert.match(audit.evidence.find((e: { condition?: string }) => e.condition === "faults").summary, /^caught \d+ of \d+ planted faults/);
  });

  test("vendored-skill: the vendored, placeholder and package commands are skipped and none runs", () => {
    const { audit, report } = host("vendored-skill");
    assert.equal(audit.instructions.filter((i: { category: string }) => i.category === "skipped").length, 6);
    assert.deepEqual(ran(audit).filter((c) => /ui-kit|date-fns|<name>/.test(c)), []);
    assert.equal(audit.instructions.filter((i: { source: string }) => i.source.startsWith(".claude/")).length, 0, "the copy is checked once");
    assert.equal(report.details.checks.find((c: { id: string }) => c.id === "context.instructions_verified").ok, true);
  });
});
