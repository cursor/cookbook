import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Arm, EvalCase } from "./types.ts";

const CASES = join(dirname(fileURLToPath(import.meta.url)), "..", "cases");

export interface Job {
  c: EvalCase;
  m: string;
  r: number;
  arm: Arm;
}

export async function loadCases(): Promise<EvalCase[]> {
  const out: EvalCase[] = [];
  for (const f of readdirSync(CASES).filter((x) => x.endsWith(".ts")).sort()) {
    const mod = (await import(join(CASES, f))) as { cases?: EvalCase[]; default?: EvalCase };
    const list = mod.cases ?? (mod.default ? [mod.default] : []);
    const prefix = basename(f, ".ts");
    for (const c of list) out.push({ ...c, id: `${prefix}/${c.id}` });
  }
  return out;
}

export function select(all: EvalCase[], flags: Record<string, string | true>): EvalCase[] {
  const tag = typeof flags.tag === "string" ? flags.tag : undefined;
  const only = typeof flags.case === "string" ? flags.case.split(",") : undefined;
  // A hill-climb round never sees the held-out cases unless asked to report them.
  const holdoutOut = Boolean(flags["hill-climb"]) && !flags["include-holdout"];
  return all.filter((c) => (!tag || c.tags.includes(tag as EvalCase["tags"][number])) && (!only || only.some((o) => c.id === o || c.id.endsWith("/" + o))) && !(holdoutOut && c.tags.includes("holdout")));
}

// Every run a selection makes: each driven case once per arm, model and repeat (the scripted arm
// has no model), and each scripted negative case once per repeat.
export function planJobs(selected: EvalCase[], arms: Arm[], models: string[], repeats: number): Job[] {
  const driven = selected.filter((c) => !c.attack);
  const scripted = selected.filter((c) => c.attack);
  return [
    ...driven.flatMap((c) => arms.flatMap((arm) => (arm === "scripted" ? ["scripted"] : models).flatMap((m) => Array.from({ length: repeats }, (_, i) => ({ c, m, r: i + 1, arm }))))),
    ...scripted.flatMap((c) => Array.from({ length: repeats }, (_, i) => ({ c, m: "scripted", r: i + 1, arm: "agent" as Arm }))),
  ];
}
