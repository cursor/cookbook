// Small-sample statistics for the eval baseline. Runs of one case aren't independent of each other
// (same fixture, same prompt), so the bootstrap resamples cases, not runs.

const Z95 = 1.959964;

export interface Rate {
  passed: number;
  runs: number;
  rate: number | null;
  // The 95% Wilson score interval: honest at 0 or n passes, where the normal interval collapses.
  lower: number | null;
  upper: number | null;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function wilson(passed: number, runs: number, z = Z95): Rate {
  if (runs === 0) return { passed, runs, rate: null, lower: null, upper: null };
  const p = passed / runs;
  const denom = 1 + (z * z) / runs;
  const centre = (p + (z * z) / (2 * runs)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / runs + (z * z) / (4 * runs * runs))) / denom;
  return { passed, runs, rate: r3(p), lower: r3(Math.max(0, centre - half)), upper: r3(Math.min(1, centre + half)) };
}

// A seeded PRNG, so a baseline's intervals are the same every time it's recomputed.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MeanCi {
  n: number;
  mean: number | null;
  low: number | null;
  high: number | null;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// The mean of every score, with a 95% percentile bootstrap interval that resamples whole cases.
export function bootstrapMean(byCase: number[][], opts: { resamples?: number; seed?: number } = {}): MeanCi {
  const groups = byCase.filter((g) => g.length);
  const all = groups.flat();
  if (!all.length) return { n: 0, mean: null, low: null, high: null };
  const rand = mulberry32(opts.seed ?? 20261102);
  const means: number[] = [];
  for (let i = 0; i < (opts.resamples ?? 2000); i++) {
    const pick: number[] = [];
    for (let j = 0; j < groups.length; j++) pick.push(...groups[Math.floor(rand() * groups.length)]);
    means.push(mean(pick));
  }
  means.sort((a, b) => a - b);
  const q = (p: number) => means[Math.min(means.length - 1, Math.max(0, Math.floor(p * means.length)))];
  return { n: all.length, mean: r3(mean(all)), low: r3(q(0.025)), high: r3(q(0.975)) };
}

// The mean per-case difference a - b over cases both have, with a bootstrap interval over cases.
export function bootstrapDiff(a: Map<string, number[]>, b: Map<string, number[]>, opts: { resamples?: number; seed?: number } = {}): MeanCi {
  const diffs = [...a.keys()].filter((k) => a.get(k)!.length && b.get(k)?.length).map((k) => [mean(a.get(k)!) - mean(b.get(k)!)]);
  return bootstrapMean(diffs, opts);
}

// k of n per case, against what the baseline's pass rate predicts for n runs: one run short is a
// flag (one flake in a handful is expected), two or more is a regression.
export function kOfN(passed: number, runs: number, baseRate: number): "ok" | "flag" | "regression" {
  const short = Math.round(baseRate * runs) - passed;
  return short >= 2 ? "regression" : short === 1 ? "flag" : "ok";
}
