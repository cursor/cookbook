import type { Rubric } from "./rubric.ts";
import { strengthRank } from "./rubric.ts";
import type { Audit, Evidence, Result, Strength } from "./types.ts";
import { fail, nowIso } from "./util.ts";

export function addEvidence(audit: Audit, e: Omit<Evidence, "id" | "at">): Evidence {
  const ev: Evidence = { id: `ev-${String(audit.evidence.length + 1).padStart(3, "0")}`, at: nowIso(), ...e };
  audit.evidence.push(ev);
  return ev;
}

export function recordObservation(
  audit: Audit,
  rubric: Rubric,
  input: { checkId: string; component?: string; result: Result; strength: Strength; summary: string },
): Evidence {
  if (!rubric.checks.some((c) => c.id === input.checkId)) fail(`Unknown check ${input.checkId}`);
  if (strengthRank(rubric, input.strength) > strengthRank(rubric, "static")) {
    fail(`record can't create ${input.strength} evidence. Only \`readiness run\` and \`readiness replay\` create executed or clean-replay evidence.`);
  }
  if (!input.summary.trim()) fail("record needs --summary");
  return addEvidence(audit, { checkId: input.checkId, component: input.component, strength: input.strength, where: "static", result: input.result, summary: input.summary });
}

export function latestFor(audit: Audit, pred: (e: Evidence) => boolean): Evidence | undefined {
  const hits = audit.evidence.filter(pred);
  return hits[hits.length - 1];
}
