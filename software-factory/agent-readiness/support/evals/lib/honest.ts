import { readFileSync } from "node:fs";
import { join } from "node:path";
import { actor, CLI } from "./attacks.ts";
import type { Actor } from "./attacks.ts";
import type { EvalCase, Trajectory, Workspace } from "./types.ts";
import { applyTurnHook } from "./workspace.ts";

export { CLI };
export const GIT_COMMIT = "git -c user.name='Contributor A' -c user.email=a@example.com -c commit.gpgsign=false commit -q";

export type Step = (a: Actor, ws: Workspace) => void;

export function must(r: { code: number; out: string }, what: string): string {
  if (r.code !== 0) throw new Error(`${what} failed: ${r.out.slice(-800)}`);
  return r.out;
}

// Plays one step per turn, each after its turn's hook, recording calls the way the SDK driver does.
export function play(steps: Step[]): (ws: Workspace, c: EvalCase) => Trajectory {
  return (ws, c) => {
    if (steps.length !== c.turns.length) throw new Error(`${c.id}: ${steps.length} scripted steps for ${c.turns.length} turns`);
    const a = actor(ws, c);
    steps.forEach((step, i) => {
      applyTurnHook(ws, c.turns[i]);
      step(a, ws);
    });
    return a.t;
  };
}

// The honest path through an agent case, played by a script with the same setup, turn hooks and
// gates, so a case that fails even when everything is done right shows up without an API key.
// Unlike the scripted control arm (controls.ts), which only audits, it does what the prompt asks.
// Tagged negative because it runs with `--tag negative`, like honest-fix: no agent, no key.
export function honestPath(c: EvalCase, steps: Step[], why: string): EvalCase {
  return { ...c, id: `${c.id}-honest`, tags: ["full", "negative"], description: `Honest scripted path for ${c.id}: ${why}`, attack: play(steps) };
}

// Edits a repo file through the actor, so the write is recorded as a tool call.
export function edit(a: Actor, ws: Workspace, file: string, from: string, to: string): void {
  const f = join(ws.dir, file);
  const text = readFileSync(f, "utf8");
  if (!text.includes(from)) throw new Error(`${file} has no ${JSON.stringify(from)}`);
  a.write(f, text.replace(from, to));
}

export function commitAndAudit(a: Actor, message: string, tier = "local-exec"): void {
  must(a.sh(`git add -A && ${GIT_COMMIT} -m ${JSON.stringify(message)}`), "commit");
  must(a.sh(`${CLI} audit --tier ${tier}`), "audit");
}
