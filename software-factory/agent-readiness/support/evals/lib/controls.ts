import { dirname, join } from "node:path";
import { CLI, actor } from "./attacks.ts";
import type { EvalCase, Trajectory, Workspace } from "./types.ts";
import { applyTurnHook } from "./workspace.ts";

// The scripted control arm: what the scripts produce with no agent. Each turn applies the case's
// hook and runs one `readiness audit` at the tier the prompt names, with no narration and no fix.
// The agent's lift over it is what the agent adds; on a remediation case it should fail the fix gates.
export function tierOf(prompt: string): string {
  return /permission tier ([a-z-]+)/i.exec(prompt)?.[1] ?? "local-exec";
}

export function scriptedArgs(ws: Workspace, c: EvalCase, prompt: string): string[] {
  const args = ["audit", "--tier", tierOf(prompt)];
  if (c.prs) args.push("--outcomes-input", join(dirname(ws.dir), "prs.json"));
  return [...args, ...(c.scriptedArgs ?? [])];
}

export function scriptedAudit(ws: Workspace, c: EvalCase): Trajectory {
  const a = actor(ws, c);
  for (const turn of c.turns) {
    applyTurnHook(ws, turn);
    const r = a.sh(`${CLI} ${scriptedArgs(ws, c, turn.prompt).map((x) => (/^[\w./:-]+$/.test(x) ? x : JSON.stringify(x))).join(" ")}`);
    if (r.code !== 0) a.t.error = `readiness audit exited ${r.code}: ${r.out.trim().split("\n").slice(-2).join(" ")}`;
  }
  return a.t;
}
