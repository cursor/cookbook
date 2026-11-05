import type { Baseline } from "./baseline.ts";

// The release-gate policy (November 4, 2026):
// - Hard gates, k of n per case at 5 repeats or more: a case one run short of passing every gate
//   in every repeat is a flag; two or more runs short is a regression, and fails the release.
//   "Every gate in every repeat" across all cases is reported as a stat, not required.
// - Headline judge: the pooled mean over in-sample case-runs is at least 0.8, and the lower bound of
//   its 95% bootstrap interval (resampling cases) is at least 0.75.
// - Page judge: reported only.
export const RELEASE_POLICY = { repeats: 5, judgeMean: 0.8, judgeLower: 0.75 } as const;

export interface CaseVerdict {
  id: string;
  passed: number;
  usable: number;
  short: number;
  verdict: "ok" | "flag" | "regression";
  holdout: boolean;
}

export interface ReleaseVerdict {
  pass: boolean;
  // One line per finding, ending with the verdict line.
  lines: string[];
  cases: CaseVerdict[];
  // Cases that passed every gate in every repeat, reported only.
  strict: string;
  judge: { mean: number | null; low: number | null; high: number | null; pass: boolean };
  page: { mean: number | null; low: number | null; high: number | null };
}

const counts = (s: string) => s.split("/").map(Number) as [number, number];

export function caseVerdicts(b: Baseline): CaseVerdict[] {
  return Object.entries(b.cases).map(([id, c]) => {
    const [passed, usable] = counts(c.allGatesPass);
    const short = usable - passed;
    return { id, passed, usable, short, verdict: usable === 0 || short >= 2 ? "regression" : short === 1 ? "flag" : "ok", holdout: Boolean(c.holdout) };
  });
}

export function releaseVerdict(b: Baseline): ReleaseVerdict {
  const lines: string[] = [];
  const fail = (why: string) => lines.push(`FAIL ${why}`);
  const cases = caseVerdicts(b);
  if (b.repeats < RELEASE_POLICY.repeats) fail(`the run has ${b.repeats} repeats; the policy needs ${RELEASE_POLICY.repeats}`);
  for (const c of cases.filter((x) => x.verdict === "regression")) fail(`${c.id}${c.holdout ? " (held out)" : ""}: ${c.usable === 0 ? "no usable run" : `${c.passed}/${c.usable} runs pass every gate, ${c.short} short`}`);
  for (const c of cases.filter((x) => x.verdict === "flag")) lines.push(`FLAG ${c.id}${c.holdout ? " (held out)" : ""}: ${c.passed}/${c.usable} runs pass every gate, 1 short`);
  for (const [id, c] of Object.entries(b.cases)) if (c.infraLost) lines.push(`NOTE ${id}: ${c.infraLost} of ${c.runs} runs lost to infrastructure, left out`);
  const j = b.totals.judge;
  const judgePass = j.mean !== null && j.low !== null && j.mean >= RELEASE_POLICY.judgeMean && j.low >= RELEASE_POLICY.judgeLower;
  const judgeLine = `headline judge pooled mean ${j.mean ?? "n/a"} (needs ${RELEASE_POLICY.judgeMean}), 95% CI ${j.low ?? "n/a"} to ${j.high ?? "n/a"}, lower bound ${j.low ?? "n/a"} (needs ${RELEASE_POLICY.judgeLower}), over ${j.n} in-sample runs`;
  if (judgePass) lines.push(`OK ${judgeLine}`);
  else fail(j.n === 0 ? "the headline judge scored no run" : judgeLine);
  const p = b.totals.page;
  lines.push(`REPORT page judge pooled mean ${p.mean ?? "n/a"}, 95% CI ${p.low ?? "n/a"} to ${p.high ?? "n/a"} (not a release criterion)`);
  const strictN = cases.filter((c) => c.usable > 0 && c.short === 0).length;
  const strict = `${strictN}/${cases.length}`;
  const flags = cases.filter((c) => c.verdict === "flag").length;
  const regressions = cases.filter((c) => c.verdict === "regression").length;
  lines.push(`REPORT hard gates, k of n: ${cases.length - flags - regressions} cases clean, ${flags} flagged (1 short), ${regressions} regressed (2 or more short); every gate in every repeat: ${strict} cases (not a release criterion)`);
  const pass = !lines.some((l) => l.startsWith("FAIL "));
  lines.push(`RELEASE ${pass ? "PASS" : "FAIL"}`);
  return { pass, lines, cases, strict, judge: { mean: j.mean, low: j.low, high: j.high, pass: judgePass }, page: { mean: p.mean, low: p.low, high: p.high } };
}
