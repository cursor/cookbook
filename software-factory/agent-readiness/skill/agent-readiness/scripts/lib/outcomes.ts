import { ghJson } from "./gh.ts";
import type { Rubric } from "./rubric.ts";
import type { Component, OutcomeStats, OutcomesSnapshot, PrRecord, RateValue } from "./types.ts";
import { addDays, fail, fmtShortDate, median, readJson, today } from "./util.ts";

export interface Filter {
  branchPrefixes: string[];
  labels: string[];
  authors: string[];
  coAuthorTrailers: string[];
}

export function isAgentPr(pr: PrRecord, f: Filter): boolean {
  if (f.branchPrefixes.some((p) => pr.headRefName.startsWith(p))) return true;
  if (f.labels.some((l) => pr.labels.includes(l))) return true;
  if (f.authors.some((a) => pr.author === a)) return true;
  if (f.coAuthorTrailers.some((t) => (pr.coAuthors ?? []).some((c) => coAuthorMatches(c, t)))) return true;
  return false;
}

// Whole words, so "Cursor" matches "Cursor Agent" and a one-letter filter doesn't match every name.
export function coAuthorMatches(name: string, trailer: string): boolean {
  const t = trailer.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return t.length > 0 && new RegExp(`(^|[^\\w])${t}([^\\w]|$)`, "i").test(name);
}

export function emptyStats(): OutcomeStats {
  return { opened: 0, merged: 0, firstTimeCiPass: 0, firstTimeCiKnown: 0, changesRequested: 0, medianDaysToMerge: null, addingPaths: {}, mergedByActivity: {} };
}

export function stats(prs: PrRecord[], rubric: Rubric, pathPatterns: string[]): OutcomeStats {
  const s = emptyStats();
  const days: number[] = [];
  for (const pr of prs) {
    s.opened++;
    if (pr.mergedAt) {
      s.merged++;
      days.push((Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 86400000);
      for (const [activity, labels] of Object.entries(rubric.outcomes.activityLabels)) {
        if (pr.labels.some((l) => labels.includes(l.toLowerCase()))) s.mergedByActivity[activity] = (s.mergedByActivity[activity] ?? 0) + 1;
      }
    }
    if (pr.firstCheck) {
      s.firstTimeCiKnown++;
      if (pr.firstCheck === "success") s.firstTimeCiPass++;
    }
    if (pr.changesRequested) s.changesRequested++;
    for (const p of pathPatterns) if (pr.files.some((f) => f === p || f.endsWith("/" + p))) s.addingPaths[p] = (s.addingPaths[p] ?? 0) + 1;
  }
  const m = median(days);
  s.medianDaysToMerge = m === null ? null : Math.round(m * 10) / 10;
  return s;
}

export function componentsTouched(pr: PrRecord, comps: Component[]): string[] {
  const out = new Set<string>();
  for (const f of pr.files) {
    let best: Component | null = null;
    for (const c of comps) {
      if ((c.path === "." || f.startsWith(c.path + "/")) && (!best || c.path.length > best.path.length)) best = c;
    }
    if (best) out.add(best.id);
  }
  return [...out];
}

export function computeOutcomes(prs: PrRecord[], comps: Component[], rubric: Rubric, filter: Filter, windowDays: number, source: "gh" | "file", pathPatterns: string[] = [], truncated = false): OutcomesSnapshot {
  const to = today();
  const from = addDays(to, -windowDays);
  const inWindow = prs.filter((p) => p.createdAt.slice(0, 10) >= from && p.createdAt.slice(0, 10) <= to);
  const agent = inWindow.filter((p) => isAgentPr(p, filter));
  const control = inWindow.filter((p) => !isAgentPr(p, filter));
  const byComponent: Record<string, OutcomeStats> = {};
  let multi = 0;
  for (const c of comps) byComponent[c.id] = emptyStats();
  const grouped = new Map<string, PrRecord[]>();
  for (const pr of agent) {
    const touched = componentsTouched(pr, comps);
    if (touched.length > 1) multi++;
    for (const id of touched) grouped.set(id, [...(grouped.get(id) ?? []), pr]);
  }
  for (const [id, list] of grouped) byComponent[id] = stats(list, rubric, pathPatterns);
  return {
    source,
    window: { from, to, days: windowDays },
    filter,
    agent: stats(agent, rubric, pathPatterns),
    control: stats(control, rubric, pathPatterns),
    byComponent,
    matchedAgentPrs: agent.map((p) => p.number),
    multiComponentPrs: multi,
    ...(truncated ? { truncated } : {}),
  };
}

export function rate(count: number, n: number, rubric: Rubric, window: string): RateValue {
  return { count, n, rate: n >= rubric.outcomes.minRateN ? Math.round((count / n) * 1000) / 1000 : null, window };
}

export function windowLabel(o: OutcomesSnapshot): string {
  return `${fmtShortDate(o.window.from)} to ${fmtShortDate(o.window.to)}, ${o.window.to.slice(0, 4)}`;
}

export function describeRate(r: RateValue): string {
  if (r.rate === null) return `${r.count} of ${r.n} (too few for a rate)`;
  return `${Math.round(r.rate * 100)}% (${r.count} of ${r.n})`;
}

interface GhPr {
  number: number;
  headRefName: string;
  author: { login: string } | null;
  labels: { name: string }[];
  createdAt: string;
  mergedAt: string | null;
  state: string;
  files: { path: string }[];
  reviews: { state: string }[];
  commits: { oid: string; messageBody?: string; authors?: { name: string; email: string }[] }[];
}

interface CheckRuns {
  total_count?: number;
  check_runs: { conclusion: string | null; status: string }[];
}

export const MAX_PRS = 300;

export function fetchPrs(repoSlug: string, windowDays: number, maxPrs = MAX_PRS): { prs: PrRecord[]; truncated: boolean } {
  const since = addDays(today(), -windowDays);
  const list = ghJson<GhPr[]>(["pr", "list", "--repo", repoSlug, "--state", "all", "--limit", String(maxPrs), "--search", `created:>=${since}`, "--json", "number,headRefName,author,labels,createdAt,mergedAt,state,files,reviews,commits"]);
  return { prs: toRecords(repoSlug, list), truncated: list.length >= maxPrs };
}

function toRecords(repoSlug: string, list: GhPr[]): PrRecord[] {
  return list.map((p) => {
    let firstCheck: PrRecord["firstCheck"] = null;
    const first = p.commits[0]?.oid;
    if (first) {
      try {
        const runs = ghJson<CheckRuns>(["api", `repos/${repoSlug}/commits/${first}/check-runs?per_page=100`, "-q", "{total_count, check_runs: [.check_runs[] | {conclusion, status}]}"]);
        // Unknown until every run finished, when runs sit past the first page, or when every run
        // was skipped, which proves nothing.
        const all = runs.check_runs;
        const ran = all.filter((r) => r.conclusion !== "skipped" && r.conclusion !== "neutral");
        const complete = (runs.total_count ?? all.length) <= all.length;
        if (complete && all.length && all.every((r) => r.status === "completed") && ran.length) firstCheck = ran.every((r) => r.conclusion === "success") ? "success" : "failure";
      } catch {
        firstCheck = null;
      }
    }
    const coAuthors = p.commits.flatMap((c) => [...(c.messageBody ?? "").matchAll(/Co-authored-by:\s*([^\n<]+)/gi)].map((m) => m[1].trim()));
    return {
      number: p.number,
      headRefName: p.headRefName,
      author: p.author?.login ?? "",
      labels: p.labels.map((l) => l.name),
      createdAt: p.createdAt,
      mergedAt: p.mergedAt,
      state: p.state,
      files: p.files.map((f) => f.path),
      firstCheck,
      changesRequested: p.reviews.some((r) => r.state === "CHANGES_REQUESTED"),
      coAuthors,
    };
  });
}

export function loadPrsFile(path: string): PrRecord[] {
  const data = readJson<PrRecord[] | { prs: PrRecord[] }>(path);
  const prs = Array.isArray(data) ? data : data.prs;
  if (!Array.isArray(prs)) fail(`${path} must hold an array of PR records`);
  return prs;
}
