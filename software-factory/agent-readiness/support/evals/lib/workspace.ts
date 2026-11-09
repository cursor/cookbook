import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { skillDigest } from "../../../skill/agent-readiness/scripts/lib/workspace.ts";
import { SKILL, commitAll, materialize, materializePrs } from "../../tools/fixture.ts";
import type { EvalCase, Turn, Workspace } from "./types.ts";

export const EVAL_SEED = "eval-seed";

export function installedSkillDigest(dir: string): string {
  const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", `import("${join(dir, ".cursor/skills/agent-readiness/scripts/lib/workspace.ts")}").then(m => process.stdout.write(m.skillDigest()))`], { encoding: "utf8" });
  return out.trim();
}

// skill: false is the skill-off control arm: the same repo and prompt with no skill installed.
export function prepare(c: EvalCase, opts: { skill?: boolean } = {}): Workspace {
  const now = new Date().toISOString();
  const root = mkdtempSync(join(tmpdir(), `eval-${c.id.replace(/[^\w-]/g, "_")}-`));
  const dir = materialize(c.fixture, { now, into: root });
  if (opts.skill !== false) {
    cpSync(SKILL, join(dir, ".cursor/skills/agent-readiness"), { recursive: true });
    commitAll(dir, "Add the agent readiness skill", 0, now);
  }
  const ws: Workspace = { dir, fixture: c.fixture, now, skillDigestBefore: skillDigest(), headBefore: "" };
  if (c.setup) {
    c.setup(ws);
    // A setup that commits its own steps can leave nothing for this commit.
    if (execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim()) commitAll(dir, "Case setup", 0, now);
  }
  ws.headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  if (c.prs) copyFileSync(materializePrs(c.fixture, now, c.prs), join(root, "prs.json"));
  writeFileSync(join(root, "eval.env"), Object.entries(caseEnv(c)).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("\n") + "\n");
  writeFileSync(join(root, "case.json"), JSON.stringify({ id: c.id, fixture: c.fixture, dir, now, headBefore: ws.headBefore, skillDigestBefore: ws.skillDigestBefore, prompts: c.turns.map((t) => fillPrompt(t.prompt, ws)), env: caseEnv(c) }, null, 2));
  return ws;
}

function harnessCommitsFile(ws: Workspace): string {
  return join(dirname(ws.dir), "harness-commits.txt");
}

export function applyTurnHook(ws: Workspace, turn: Turn | undefined): boolean {
  if (!turn?.before) return false;
  const from = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws.dir, encoding: "utf8" }).trim();
  turn.before(ws);
  const made = execFileSync("git", ["rev-list", `${from}..HEAD`], { cwd: ws.dir, encoding: "utf8" }).trim();
  if (made) appendFileSync(harnessCommitsFile(ws), made + "\n");
  return true;
}

export function harnessCommits(ws: Workspace): Set<string> {
  const f = harnessCommitsFile(ws);
  return new Set(existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
}

export function fillPrompt(prompt: string, ws: Workspace): string {
  return prompt.replaceAll("{root}", dirname(ws.dir)).replaceAll("{dir}", ws.dir);
}

export function loadWorkspace(root: string): { ws: Workspace; id: string; prompts: string[]; env: Record<string, string> } {
  const meta = JSON.parse(readFileSync(join(root, "case.json"), "utf8")) as { id: string; fixture: string; dir: string; now: string; headBefore: string; skillDigestBefore: string; prompts: string[]; env: Record<string, string> };
  return { ws: { dir: meta.dir, fixture: meta.fixture, now: meta.now, headBefore: meta.headBefore, skillDigestBefore: meta.skillDigestBefore }, id: meta.id, prompts: meta.prompts, env: meta.env };
}

export function caseEnv(c: EvalCase): Record<string, string> {
  const env: Record<string, string> = { SA_READINESS_EVAL_SEED: EVAL_SEED, ...(c.env ?? {}) };
  if (process.env.SA_READINESS_IMAGE && c.remediation && !env.SA_READINESS_IMAGE) env.SA_READINESS_IMAGE = process.env.SA_READINESS_IMAGE;
  return env;
}

export function externalPreamble(dir: string): string {
  return `This is an evaluation workspace. First run \`source ${join(dirname(dir), "eval.env")}\` in your shell; if your shell doesn't keep state between commands, prefix each command with it.\n`;
}

export function repoPreamble(dir: string): string {
  return `You are working in the git repository at ${dir}. Run every command from that directory.\n`;
}

export function skillPreamble(dir: string): string {
  return [
    repoPreamble(dir).trimEnd(),
    "Agent skills available in this repository:",
    "- agent-readiness (.cursor/skills/agent-readiness/SKILL.md): Audit whether coding agents can work in this repository, from evidence the audit's scripts execute. Use when asked for an agent readiness audit or report, what blocks agents here, or to re-audit after fixes.",
    "",
  ].join("\n");
}
