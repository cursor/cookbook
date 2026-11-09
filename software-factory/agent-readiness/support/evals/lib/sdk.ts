import { Agent } from "@cursor/sdk";
import { protectedDigest } from "./protected.ts";
import type { EvalCase, Snapshot, ToolCall, Trajectory, Workspace } from "./types.ts";
import { applyTurnHook, caseEnv, fillPrompt, repoPreamble, skillPreamble } from "./workspace.ts";

// skill: false runs the skill-off control arm: no skill preamble, and prepare() installed no skill.
export async function runWithSdk(ws: Workspace, c: EvalCase, model: string, apiKey: string, timeoutMs: number, opts: { skill?: boolean } = {}): Promise<Trajectory> {
  const env = caseEnv(c);
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const started = Date.now();
  const toolCalls: ToolCall[] = [];
  const snapshots: Snapshot[] = [{ call: "start", phase: "after", digest: protectedDigest(ws.dir) }];
  let text = "";
  let tokens = 0;
  let error: string | null = null;
  const agent = await Agent.create({ apiKey, name: `agent-readiness eval ${c.id}`, model: { id: model }, local: { cwd: ws.dir, settingSources: ["project"] } });
  try {
    for (const [i, turn] of c.turns.entries()) {
      applyTurnHook(ws, turn);
      const prompt = (i === 0 ? (opts.skill === false ? repoPreamble(ws.dir) : skillPreamble(ws.dir)) : "") + fillPrompt(turn.prompt, ws);
      const run = await agent.send(prompt);
      const timer = setTimeout(() => {
        if (run.supports("cancel")) void run.cancel();
      }, timeoutMs);
      try {
        for await (const ev of run.stream()) {
          if (ev.type === "tool_call") snapshots.push({ call: ev.call_id, phase: ev.status === "running" ? "before" : "after", digest: protectedDigest(ws.dir) });
          if (ev.type === "tool_call" && ev.status !== "running") toolCalls.push({ id: ev.call_id, name: ev.name, status: ev.status, args: (ev.args ?? {}) as Record<string, unknown> });
          if (ev.type === "assistant") for (const block of ev.message.content) if (block.type === "text") text += block.text;
        }
        const result = await run.wait();
        tokens += result.usage?.totalTokens ?? 0;
        if (result.status !== "finished") error = `turn ${i + 1} ended ${result.status}${result.error ? `: ${JSON.stringify(result.error)}` : ""}`;
      } finally {
        clearTimeout(timer);
      }
      text += "\n\n";
      if (error) break;
    }
  } catch (e) {
    error = (e as Error).message;
  } finally {
    await agent[Symbol.asyncDispose]();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { driver: "sdk", toolCalls, snapshots, text, durationMs: Date.now() - started, tokens, error };
}

export async function askModel(prompt: string, model: string, apiKey: string, cwd: string): Promise<string> {
  // No settings layer at all: a judge needs no rules, skills or hooks.
  const agent = await Agent.create({ apiKey, name: "agent-readiness judge", model: { id: model }, local: { cwd, settingSources: [] } });
  try {
    const run = await agent.send(prompt);
    let text = "";
    for await (const ev of run.stream()) if (ev.type === "assistant") for (const b of ev.message.content) if (b.type === "text") text += b.text;
    await run.wait();
    return text;
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}
