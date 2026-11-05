import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReportJson } from "../../skill/agent-readiness/scripts/lib/types.ts";
import { ACCELERATOR, readiness } from "../tools/fixture.ts";
import { claimsNotInTree } from "./lib/claims.ts";
import { LAST_RUN, goldenProblems, levelViolations, loadGoldens, loadLastRun, rankViolations, scoringDigest, staleResults } from "./lib/goldens.ts";
import type { Golden, GoldenResult, LastRun } from "./lib/goldens.ts";

// Clones each pinned public repo, audits it at local-exec in a clean container, and checks exact
// levels where goldens.json gives them, the ranking of component levels, and that the report claims
// nothing outside the tree. Needs network and Docker or Podman, so it isn't part of `npm run check`.
//
// --only a,b reruns those goldens and keeps the others' stored results; any stored result recorded
// under other scoring is listed as pending in last-run.json. --check runs nothing and exits 1 when a
// stored result is stale or failed, or a ranking or exact level doesn't hold.

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const only = arg("--only")?.split(",") ?? null;
const keep = process.argv.includes("--keep");
const set = loadGoldens();
const problems = goldenProblems(set);
if (problems.length) {
  console.error(`goldens.json is invalid:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
const digest = scoringDigest();
const commit = (() => {
  try {
    return git(ACCELERATOR, ["rev-parse", "HEAD"]).trim();
  } catch {
    return "unknown";
  }
})();

function run(g: Golden): GoldenResult {
  const started = Date.now();
  const root = mkdtempSync(join(tmpdir(), `golden-${g.id}-`));
  const dir = join(root, g.id);
  const failures: string[] = [];
  const base = { id: g.id, sha: g.sha, scoring: digest, commit };
  try {
    git(root, ["clone", "--quiet", "--filter=blob:none", "--no-checkout", `https://github.com/${g.repo}`, g.id]);
    try {
      git(dir, ["-c", "advice.detachedHead=false", "checkout", "--quiet", g.sha]);
    } catch {
      // GitHub sometimes refuses the lazy blob fetch a blobless checkout makes; a full clone works.
      rmSync(dir, { recursive: true, force: true });
      git(root, ["clone", "--quiet", "--no-checkout", `https://github.com/${g.repo}`, g.id]);
      git(dir, ["-c", "advice.detachedHead=false", "checkout", "--quiet", g.sha]);
    }
    const committed = git(dir, ["show", "-s", "--format=%cI", g.sha]).trim();
    const now = new Date(new Date(committed).getTime() + 86400000).toISOString();
    const r = readiness(dir, ["audit", "--tier", "local-exec"], { SA_READINESS_NOW: now, SA_READINESS_EVAL_SEED: `golden-${g.id}` });
    if (r.code !== 0) failures.push(`audit exited ${r.code}: ${r.out.slice(-400)}`);
    const report = JSON.parse(readFileSync(join(dir, ".agent-readiness/latest/report.json"), "utf8")) as ReportJson;
    const audits = join(dir, ".agent-readiness/history/audits");
    const audit = JSON.parse(readFileSync(join(audits, readdirSync(audits).sort().pop()!, "audit.json"), "utf8"));
    const levels = Object.fromEntries(report.components.included.map((c) => [c.id, c.level]));
    for (const id of g.expect.included) if (!(id in levels)) failures.push(`${id} wasn't assessed`);
    for (const x of g.expect.excluded) {
      const got = report.components.excluded.find((c) => c.id === x.id);
      if (!got) failures.push(`${x.id} wasn't listed as not assessed`);
      else if (got.toolchain !== x.toolchain) failures.push(`${x.id} is listed as ${got.toolchain}, not ${x.toolchain}`);
    }
    failures.push(...levelViolations(g, levels), ...claimsNotInTree(report, audit, dir, g.sha));
    const minutes = Math.round((Date.now() - started) / 6000) / 10;
    return { ...base, minutes, repoLevel: report.maturity.outcome === "not_assessed" ? null : report.maturity.level, outcome: report.maturity.outcome, levels, excluded: report.components.excluded.map((c) => ({ id: c.id, toolchain: c.toolchain, reason: c.reason })), failures };
  } catch (e) {
    failures.push((e as Error).message.slice(0, 400));
    return { ...base, minutes: Math.round((Date.now() - started) / 6000) / 10, repoLevel: null, outcome: "error", levels: {}, excluded: [], failures };
  } finally {
    if (keep) console.log(`kept ${dir}`);
    else rmSync(root, { recursive: true, force: true });
  }
}

function judge(stored: LastRun): string[] {
  const levels = Object.fromEntries(stored.results.flatMap((r) => Object.entries(r.levels).map(([c, l]) => [`${r.id}:${c}`, l])));
  return [...rankViolations(set, levels), ...set.goldens.flatMap((g) => levelViolations(g, stored.results.find((r) => r.id === g.id)?.levels ?? {}))];
}

const previous = loadLastRun();
if (process.argv.includes("--check")) {
  const stale = staleResults(set, previous, digest);
  const failed = (previous?.results ?? []).filter((r) => r.failures.length);
  const violations = previous ? judge(previous) : [];
  for (const s of stale) console.log(`STALE ${s.id}: ${s.why}`);
  for (const r of failed) console.log(`FAIL ${r.id}: ${r.failures.join("; ")}`);
  for (const v of violations) console.log(`LEVEL ${v}`);
  console.log(stale.length + failed.length + violations.length ? "Goldens need a rerun." : "Goldens are fresh and every assertion holds.");
  process.exit(stale.length + failed.length + violations.length ? 1 : 0);
}

const fresh: GoldenResult[] = [];
for (const g of set.goldens.filter((x) => !only || only.includes(x.id))) {
  const r = run(g);
  fresh.push(r);
  console.log(`${r.id}: ${r.outcome}, repo ${r.repoLevel ?? "not assessed"}, ${JSON.stringify(r.levels)} in ${r.minutes} min${r.failures.length ? `\n  FAIL ${r.failures.join("\n  FAIL ")}` : ""}`);
}
const results = set.goldens.map((g) => fresh.find((r) => r.id === g.id) ?? previous?.results.find((r) => r.id === g.id)).filter((r): r is GoldenResult => Boolean(r));
const stored: LastRun = { ranAt: new Date().toISOString(), results, violations: [], pending: [] };
stored.violations = rankViolations(set, Object.fromEntries(results.flatMap((r) => Object.entries(r.levels).map(([c, l]) => [`${r.id}:${c}`, l]))));
stored.pending = staleResults(set, stored, digest).map((s) => ({ id: s.id, reason: `${s.why}; not rerun in this pass` }));
for (const v of stored.violations) console.log(`RANK ${v}`);
for (const p of stored.pending) console.log(`PENDING ${p.id}: ${p.reason}`);
writeFileSync(LAST_RUN, JSON.stringify(stored, null, 2) + "\n");
const failed = fresh.some((r) => r.failures.length) || stored.violations.length > 0;
console.log(failed ? "Goldens failed." : stored.pending.length ? "The rerun goldens passed; the pending ones need a rerun on a machine that can run them." : "Goldens passed: every exact level and ranking holds, and no report claims anything outside its tree.");
process.exitCode = failed ? 1 : 0;
