import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCELERATOR, SKILL } from "../../tools/fixture.ts";

export const PERMISSIVE = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC0-1.0"];
export const TOOLCHAINS = ["js-ts", "python", "go", "dotnet"] as const;

export interface Golden {
  id: string;
  repo: string;
  sha: string;
  license: string;
  toolchains: (typeof TOOLCHAINS)[number][];
  shape: "single" | "monorepo";
  reason: string;
  expect: {
    // Components the audit must assess, and ones it must list as not assessed with their toolchain.
    included: string[];
    excluded: { id: string; toolchain: string }[];
    // Exact standard levels for the components whose level is stable at the pinned SHA. null means
    // the audit must give that component no level.
    levels?: Record<string, number | null>;
  };
}

export interface GoldenSet {
  schema: "agent-readiness/goldens@1";
  // Highest first. Every component in a tier must sit strictly above every component in the
  // next tier; within a tier no order is asserted. Entries are "<golden id>:<component id>".
  rank: string[][];
  goldens: Golden[];
}

export interface GoldenResult {
  id: string;
  sha: string;
  minutes: number;
  repoLevel: number | null;
  outcome: string;
  levels: Record<string, number | null>;
  excluded: { id: string; toolchain: string; reason: string }[];
  failures: string[];
  // scoringDigest() of the scripts that produced this result, and the accelerator commit they ran from.
  scoring: string;
  commit: string;
}

export interface LastRun {
  ranAt: string;
  results: GoldenResult[];
  violations: string[];
  // Goldens whose stored result predates the current scoring, with why they weren't rerun.
  pending: { id: string; reason: string }[];
}

export const SCORING_FILES = ["scripts/lib/score.ts", "scripts/lib/levels.ts"];

// One digest over the files that turn evidence into levels. A golden result recorded under another
// digest is stale: it no longer shows what the current scoring gives.
export function scoringDigest(): string {
  const h = createHash("sha256");
  for (const f of SCORING_FILES) h.update(f).update("\0").update(readFileSync(join(SKILL, f))).update("\n");
  return h.digest("hex");
}

export const LAST_RUN = join(ACCELERATOR, "support", "evals", "goldens", "last-run.json");

export function loadLastRun(): LastRun | null {
  return existsSync(LAST_RUN) ? (JSON.parse(readFileSync(LAST_RUN, "utf8")) as LastRun) : null;
}

export function loadGoldens(): GoldenSet {
  return JSON.parse(readFileSync(join(ACCELERATOR, "support", "evals", "goldens", "goldens.json"), "utf8")) as GoldenSet;
}

export function goldenProblems(set: GoldenSet): string[] {
  const out: string[] = [];
  if (set.goldens.length < 4 || set.goldens.length > 6) out.push(`${set.goldens.length} goldens; the set needs 4 to 6`);
  for (const g of set.goldens) {
    if (!/^[0-9a-f]{40}$/.test(g.sha)) out.push(`${g.id}: the commit must be a full 40-character SHA`);
    if (!PERMISSIVE.includes(g.license)) out.push(`${g.id}: ${g.license} isn't a permissive license`);
    if (!g.reason.trim()) out.push(`${g.id}: no reason given`);
    if (g.expect.included.length + g.expect.excluded.length === 0) out.push(`${g.id}: expects no components`);
    for (const id of Object.keys(g.expect.levels ?? {})) if (!g.expect.included.includes(id)) out.push(`${g.id}: an exact level for ${id}, which it doesn't expect to assess`);
  }
  for (const t of TOOLCHAINS) if (!set.goldens.some((g) => g.toolchains.includes(t))) out.push(`no golden covers ${t}`);
  if (!set.goldens.some((g) => g.shape === "monorepo" && g.expect.included.length + g.expect.excluded.length > 1)) out.push("no golden is a monorepo with nested apps");
  const known = new Set(set.goldens.flatMap((g) => g.expect.included.map((c) => `${g.id}:${c}`)));
  for (const e of set.rank.flat()) if (!known.has(e)) out.push(`rank names ${e}, which no golden expects to assess`);
  if (set.rank.length < 3) out.push("the ranking needs at least three tiers to span low to high");
  if (!set.goldens.some((g) => Object.values(g.expect.levels ?? {}).some((l) => l !== null))) out.push("no golden asserts an exact level");
  return out;
}

// Levels are null when the audit gave none; a missing or null level breaks every assertion it's in.
export function rankViolations(set: GoldenSet, levels: Record<string, number | null | undefined>): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < set.rank.length; i++) {
    for (const hi of set.rank[i]) {
      for (const lo of set.rank[i + 1]) {
        const a = levels[hi];
        const b = levels[lo];
        if (a === null || a === undefined || b === null || b === undefined) out.push(`${hi} (${a ?? "no level"}) vs ${lo} (${b ?? "no level"}): both need a level`);
        else if (!(a > b)) out.push(`${hi} is Level ${a}, which should be above ${lo} at Level ${b}`);
      }
    }
  }
  return out;
}

// Each exact level a golden asserts, against the levels one audit of it gave.
export function levelViolations(g: Golden, levels: Record<string, number | null | undefined>): string[] {
  return Object.entries(g.expect.levels ?? {}).flatMap(([id, want]) => {
    const got = levels[id];
    if (got === undefined) return [`${g.id}:${id} has no result`];
    return (got ?? null) === want ? [] : [`${g.id}:${id} is ${got === null ? "no level" : `Level ${got}`}, expected ${want === null ? "no level" : `Level ${want}`}`];
  });
}

// Results that no longer show what the current scoring gives, and goldens with no result at all.
export function staleResults(set: GoldenSet, run: LastRun | null, digest = scoringDigest()): { id: string; why: string }[] {
  return set.goldens.flatMap((g) => {
    const r = run?.results.find((x) => x.id === g.id);
    if (!r) return [{ id: g.id, why: "no recorded result" }];
    if (r.sha !== g.sha) return [{ id: g.id, why: `recorded at ${r.sha.slice(0, 7)}, pinned at ${g.sha.slice(0, 7)}` }];
    if (r.scoring !== digest) return [{ id: g.id, why: `recorded under scoring ${String(r.scoring ?? "unknown").slice(0, 12)}, current is ${digest.slice(0, 12)}` }];
    return [];
  });
}
