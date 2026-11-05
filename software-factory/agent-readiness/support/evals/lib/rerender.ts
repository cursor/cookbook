import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRubric } from "../../../skill/agent-readiness/scripts/lib/rubric.ts";
import { buildSealedReport } from "../../../skill/agent-readiness/scripts/lib/seal.ts";
import type { Audit, HistoryLine, ReportJson, Roadmap } from "../../../skill/agent-readiness/scripts/lib/types.ts";
import type { Workspace } from "./types.ts";

// Rebuilds the latest report from a run's sealed audits with the current scripts, so a change
// that only affects rendering can be judged on earlier runs. Roadmap edits made between
// audits (owner, targets) aren't replayed.
export function rerenderLatest(ws: Workspace): ReportJson | null {
  const f = join(ws.dir, ".agent-readiness/history/history.jsonl");
  if (!existsSync(f)) return null;
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as HistoryLine);
  const before: HistoryLine[] = [];
  let roadmap: Roadmap | null = null;
  let report: ReportJson | null = null;
  for (const line of lines) {
    if (line.kind === "audit") {
      const storedAt = `.agent-readiness/history/audits/${line.id}`;
      const audit = JSON.parse(readFileSync(join(ws.dir, storedAt, "audit.json"), "utf8")) as Audit;
      const r = buildSealedReport(audit, loadRubric(audit.rubric), [...before], roadmap, ws.dir, storedAt, report);
      roadmap = r.roadmap;
      report = r.report;
    }
    before.push(line);
  }
  return report;
}
