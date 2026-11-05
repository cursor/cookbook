import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanText } from "./redact.ts";
import type { Audit, HistoryLine, ReportJson, Roadmap } from "./types.ts";
import { ensureDir, exists, fail, git, nowIso, readJson, readText, writeJson, writeText } from "./util.ts";
import type { Paths } from "./workspace.ts";

export const HISTORY_BRANCH = "agent-readiness/history";

function guardSecrets(label: string, text: string): void {
  const hits = scanText(text);
  if (hits.length > 0) fail(`Refusing to write ${label}: it contains ${hits.map((h) => `${h.type} (line ${h.line})`).join(", ")}. Nothing was written.`);
}

export function storeAudit(p: Paths, audit: Audit, report: ReportJson, md: string, html: string): string {
  const dir = join(p.history, "audits", audit.id);
  const auditText = JSON.stringify(audit, null, 2) + "\n";
  const reportText = JSON.stringify(report, null, 2) + "\n";
  guardSecrets(`audit ${audit.id}`, auditText + reportText + md + html);
  writeText(join(dir, "audit.json"), auditText);
  writeText(join(dir, "report.json"), reportText);
  writeText(join(dir, "report.md"), md);
  writeText(join(dir, "report.html"), html);
  return dir;
}

export function writeLatest(p: Paths, report: ReportJson, md: string, html: string): void {
  writeJson(join(p.latest, "report.json"), report);
  writeText(join(p.latest, "report.md"), md);
  writeText(join(p.latest, "report.html"), html);
}

export function readRoadmap(p: Paths): Roadmap | null {
  return exists(p.roadmap) ? readJson<Roadmap>(p.roadmap) : null;
}

export function writeRoadmap(p: Paths, roadmap: Roadmap): void {
  writeJson(p.roadmap, roadmap);
}

// A fresh clone has only the remote-tracking branch, and reading neither would start the history
// over and let the next push overwrite it.
export function showFromBranch(repo: string, path: string): string | null {
  for (const ref of [HISTORY_BRANCH, `origin/${HISTORY_BRANCH}`]) {
    const r = git(["show", `${ref}:${path}`], repo);
    if (r.ok) return r.stdout;
  }
  return null;
}

export function appendHistory(p: Paths, line: HistoryLine): void {
  const f = join(p.history, "history.jsonl");
  const text = JSON.stringify(line) + "\n";
  guardSecrets("the history line", text);
  ensureDir(p.history);
  const prev = mergeHistory(branchHistory(p.repo) ?? "", exists(f) ? readText(f) : "");
  writeText(f, prev + text);
}

export function readHistory(p: Paths): HistoryLine[] {
  const f = join(p.history, "history.jsonl");
  return parseHistory(mergeHistory(branchHistory(p.repo) ?? "", exists(f) ? readText(f) : ""));
}

// Lines from every copy, each id once, in date order and otherwise in the order first written.
export function mergeHistory(...texts: string[]): string {
  const seen = new Set<string>();
  const out: { line: string; date: string }[] = [];
  for (const line of texts.flatMap((t) => t.split("\n")).filter((l) => l.trim())) {
    const h = JSON.parse(line) as HistoryLine;
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push({ line, date: h.date ?? "" });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out.length ? out.map((x) => x.line).join("\n") + "\n" : "";
}

// The history branch as this clone knows it: the local branch and the remote one, merged, so a
// stale local branch doesn't hide CI's newer lines.
function branchHistory(repo: string): string | null {
  const texts = [HISTORY_BRANCH, `origin/${HISTORY_BRANCH}`].map((ref) => git(["show", `${ref}:history.jsonl`], repo)).filter((r) => r.ok).map((r) => r.stdout);
  return texts.length ? mergeHistory(...texts) : null;
}

// A sealed file from the local history folder, or from the history branch when the audit came from there.
export function readSealedFile(p: Paths, dir: string, name: string): string | null {
  if (exists(join(dir, name))) return readText(join(dir, name));
  const m = dir.match(/^[^:]+:(audits\/.+)$/);
  return m ? showFromBranch(p.repo, `${m[1]}/${name}`) : null;
}

function parseHistory(text: string): HistoryLine[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as HistoryLine);
}

export function auditIds(p: Paths): string[] {
  const dir = join(p.history, "audits");
  return exists(dir) ? readdirSync(dir).sort() : [];
}

export function loadSealedAudit(p: Paths, ref: string): { audit: Audit; dir: string } {
  let id = ref;
  if (ref === "latest" || ref === "previous") {
    const audits = readHistory(p).filter((h) => h.kind === "audit");
    const pick = ref === "latest" ? audits[audits.length - 1] : audits[audits.length - 2];
    if (!pick) fail(`No ${ref} sealed audit in ${p.history}`);
    id = pick.id;
  }
  const dir = join(p.history, "audits", id);
  if (exists(join(dir, "audit.json"))) return { audit: readJson<Audit>(join(dir, "audit.json")), dir };
  const fromBranch = showFromBranch(p.repo, `audits/${id}/audit.json`);
  if (fromBranch) return { audit: JSON.parse(fromBranch) as Audit, dir: `${HISTORY_BRANCH}:audits/${id}` };
  return fail(`No sealed audit ${id}`);
}

export function storeRecheck(p: Paths, id: string, record: unknown): string {
  const f = join(p.history, "rechecks", `${id}.json`);
  const text = JSON.stringify(record, null, 2) + "\n";
  guardSecrets(`recheck ${id}`, text);
  writeText(f, text);
  return f;
}

export function pushHistory(p: Paths, opts: { push: boolean; remote: string }): string {
  if (!exists(p.history)) fail(`Nothing to push: ${p.history} doesn't exist`);
  const wt = join(mkdtempSync(join(tmpdir(), "readiness-history-")), "wt");
  const hasLocal = git(["rev-parse", "--verify", HISTORY_BRANCH], p.repo).ok;
  const hasRemote = git(["rev-parse", "--verify", `${opts.remote}/${HISTORY_BRANCH}`], p.repo).ok;
  const remoteRef = `${opts.remote}/${HISTORY_BRANCH}`;
  const localSha = hasLocal ? git(["rev-parse", HISTORY_BRANCH], p.repo).stdout.trim() : "";
  const show = (ref: string) => {
    const r = git(["show", `${ref}:history.jsonl`], p.repo);
    return r.ok ? r.stdout : "";
  };
  const branchText = hasLocal ? show(HISTORY_BRANCH) : "";
  const remoteText = hasRemote ? show(remoteRef) : "";
  try {
    // Commit on the remote's tip, so a push after CI's rechecks fast-forwards instead of failing,
    // and lay the local branch's files over it so nothing sealed locally is lost.
    if (hasRemote) {
      const r = git(["worktree", "add", "-B", HISTORY_BRANCH, wt, remoteRef], p.repo);
      if (!r.ok) fail(r.stderr);
      if (localSha) git(["checkout", localSha, "--", "."], wt);
    } else if (hasLocal) git(["worktree", "add", wt, HISTORY_BRANCH], p.repo);
    else {
      const r = git(["worktree", "add", "--detach", wt], p.repo);
      if (!r.ok) fail(r.stderr);
      git(["checkout", "--orphan", HISTORY_BRANCH], wt);
      git(["rm", "-rf", "--quiet", "."], wt);
    }
    const localText = exists(join(p.history, "history.jsonl")) ? readText(join(p.history, "history.jsonl")) : "";
    cpSync(p.history, wt, { recursive: true });
    writeText(join(wt, "history.jsonl"), mergeHistory(remoteText, branchText, localText));
    git(["add", "-A"], wt);
    const status = git(["status", "--porcelain"], wt).stdout.trim();
    let message = "history branch already up to date";
    if (status) {
      const c = git(["-c", "user.name=agent-readiness", "-c", "user.email=agent-readiness@example.com", "commit", "-q", "-m", `Agent readiness history ${nowIso().slice(0, 10)}`], wt);
      if (!c.ok) fail(`Could not commit history: ${c.stderr}`);
      message = `committed history to ${HISTORY_BRANCH}`;
    }
    if (opts.push) {
      const pr = git(["push", opts.remote, HISTORY_BRANCH], wt);
      if (!pr.ok) fail(`Could not push ${HISTORY_BRANCH}: ${pr.stderr}`);
      message += ` and pushed to ${opts.remote}`;
    }
    return message;
  } finally {
    git(["worktree", "remove", "--force", wt], p.repo);
    rmSync(join(wt, ".."), { recursive: true, force: true });
  }
}
