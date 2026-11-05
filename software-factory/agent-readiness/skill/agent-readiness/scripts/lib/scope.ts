import type { Audit } from "./types.ts";

// The scan's default time bound (--budget-scan). A 25,000-file monorepo scans in well under it;
// what runs past it is sampled, and the report says so.
export const SCAN_BOUND_MINUTES = 3;

// Set as `blocked` on a command or planted-fault result the replay's time budget cut off.
export const BUDGET_OUT = "the audit's time budget ran out (--budget-total or --budget-component)";
export const CUT_OFF = "not replayed: cut off by the time budget (--budget-total)";

const FAULTS_CUT = /; the time budget cut off \d+ of \d+/;

const n = (x: number) => x.toLocaleString("en-US");

// What the audit read only part of on a large repo, in one clause per part, or null when it read
// everything. The coverage line and the scan's log both use it.
export function sampledScope(audit: Pick<Audit, "profile" | "evidence" | "instructions">): string | null {
  const s = audit.profile?.scope;
  const parts: string[] = [];
  if (s?.fileCap) parts.push(`the scan listed only the first ${n(s.fileCap)} files`);
  if (s && s.secrets.scanned < s.secrets.total) parts.push(`the secret scan read ${n(s.secrets.scanned)} of ${n(s.secrets.total)} files before the scan's ${s.boundMinutes}-minute bound`);
  if (s && s.assetHistory.read < s.assetHistory.total) parts.push(`git history was read for ${n(s.assetHistory.read)} of ${n(s.assetHistory.total)} agent assets`);
  const cut = audit.evidence.filter((e) => e.blocked === BUDGET_OUT);
  const commands = cut.filter((e) => e.condition !== "faults").length;
  const faults = [...new Set(audit.evidence.filter((e) => e.condition === "faults" && (e.blocked === BUDGET_OUT || FAULTS_CUT.test(e.summary))).map((e) => e.component ?? "*"))];
  if (commands) parts.push(`the time budget cut off ${commands} ${commands === 1 ? "command" : "commands"}`);
  if (faults.length) parts.push(`planted faults in ${faults.join(", ")} stopped at the time budget`);
  const instructions = audit.instructions.filter((i) => i.reason === CUT_OFF).length;
  if (instructions) parts.push(`${instructions} documented ${instructions === 1 ? "command wasn't" : "commands weren't"} run before the time budget ran out`);
  return parts.length ? parts.join("; ") : null;
}
