import { basename } from "node:path";
import { isTestFile } from "./mutate.ts";
import type { Audit, HistoryLine } from "./types.ts";
import { git } from "./util.ts";

export interface Weakening {
  changedTestFiles: { path: string; added: number; removed: number }[];
  deletedTestFiles: string[];
  removedTestCases: number;
  newSkipMarkers: { path: string; text: string }[];
  ciChanged: string[];
  lockfileChanged: string[];
  comparable: boolean;
}

const SKIP = /\b(it|test|describe)\.(skip|only|todo)\(|\bx(it|describe|test)\(|@pytest\.mark\.(skip|xfail)|\bpytest\.skip\(|@unittest\.skip/;
const TEST_CASE = /\b(it|test)\(\s*['"`]|^\s*def test_|^\s*async def test_/;
const CI_FILE = /^\.github\/workflows\/|^\.gitlab-ci\.yml$|^\.circleci\/|^\.buildkite\//;
const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock", "Pipfile.lock", "requirements.txt"]);

export function weakening(repo: string, fromCommit: string, toCommit: string): Weakening {
  const empty: Weakening = { changedTestFiles: [], deletedTestFiles: [], removedTestCases: 0, newSkipMarkers: [], ciChanged: [], lockfileChanged: [], comparable: true };
  if (fromCommit === toCommit) return empty;
  const ok = git(["cat-file", "-e", `${fromCommit}^{commit}`], repo).ok && git(["cat-file", "-e", `${toCommit}^{commit}`], repo).ok;
  if (!ok) return { ...empty, comparable: false };
  const numstat = git(["diff", "--numstat", fromCommit, toCommit], repo).stdout.split("\n").filter(Boolean);
  for (const line of numstat) {
    const [a, r, path] = line.split("\t");
    if (isTestFile(path)) empty.changedTestFiles.push({ path, added: Number(a) || 0, removed: Number(r) || 0 });
    if (CI_FILE.test(path)) empty.ciChanged.push(path);
    if (LOCKFILES.has(basename(path))) empty.lockfileChanged.push(path);
  }
  empty.deletedTestFiles = git(["diff", "--name-only", "--diff-filter=D", fromCommit, toCommit], repo)
    .stdout.split("\n")
    .filter((p) => p && isTestFile(p));
  const testPaths = empty.changedTestFiles.map((f) => f.path);
  if (testPaths.length) {
    const patch = git(["diff", "-U0", fromCommit, toCommit, "--", ...testPaths], repo).stdout;
    let current = "";
    let added = 0;
    let removed = 0;
    for (const line of patch.split("\n")) {
      if (line.startsWith("+++ b/")) current = line.slice(6);
      else if (line.startsWith("+") && !line.startsWith("+++")) {
        if (SKIP.test(line)) empty.newSkipMarkers.push({ path: current, text: line.slice(1).trim().slice(0, 120) });
        if (TEST_CASE.test(line.slice(1))) added++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        if (TEST_CASE.test(line.slice(1))) removed++;
      }
    }
    empty.removedTestCases = Math.max(0, removed - added);
  }
  return empty;
}

export function weakeningText(w: Weakening): string {
  if (!w.comparable) return "The previous audit's commit isn't in this clone, so weakened tests couldn't be checked.";
  const parts: string[] = [];
  parts.push(w.changedTestFiles.length ? `Checked for weakened tests since the last audit: ${w.changedTestFiles.map((f) => `\`${f.path}\` (+${f.added}, -${f.removed})`).join(", ")}.` : "No test files changed since the last audit.");
  parts.push(w.deletedTestFiles.length ? `Deleted test files: ${w.deletedTestFiles.map((p) => `\`${p}\``).join(", ")}.` : "No test files were deleted.");
  parts.push(w.removedTestCases ? `${w.removedTestCases} test cases were removed overall.` : "No test cases were removed overall.");
  parts.push(w.newSkipMarkers.length ? `New skip or only markers: ${w.newSkipMarkers.map((s) => `\`${s.path}\``).join(", ")}.` : "No skip markers were added.");
  parts.push(w.ciChanged.length ? `CI files changed: ${w.ciChanged.map((p) => `\`${p}\``).join(", ")}.` : "The CI workflow is unchanged.");
  parts.push(w.lockfileChanged.length ? `Lockfiles changed: ${w.lockfileChanged.map((p) => `\`${p}\``).join(", ")}.` : "The lockfile is unchanged.");
  return parts.join(" ");
}

export function weakeningFlags(w: Weakening): string[] {
  const flags: string[] = [];
  if (w.deletedTestFiles.length) flags.push("deleted test files");
  if (w.removedTestCases > 0) flags.push("removed test cases");
  if (w.newSkipMarkers.length) flags.push("new skip markers");
  if (w.ciChanged.length) flags.push("CI changed");
  return flags;
}

export interface LevelChange {
  component: string;
  activity: string;
  from: number | null;
  to: number | null;
}

// activity is "standard" for a component's own level, or the scenario id for a scenario under it.
export function levelChanges(a: HistoryLine, b: HistoryLine): LevelChange[] {
  const out: LevelChange[] = [];
  const level = (h: HistoryLine, c: string) => (h.noLevel ? null : (h.levels?.[c] ?? null));
  if ((a.noLevel ? null : a.repoLevel) !== (b.noLevel ? null : b.repoLevel)) out.push({ component: "*", activity: "standard", from: a.noLevel ? null : a.repoLevel, to: b.noLevel ? null : b.repoLevel });
  for (const c of new Set([...Object.keys(a.levels ?? {}), ...Object.keys(b.levels ?? {})])) {
    if (level(a, c) !== level(b, c)) out.push({ component: c, activity: "standard", from: level(a, c), to: level(b, c) });
  }
  for (const c of new Set([...Object.keys(a.scenarioLevels ?? {}), ...Object.keys(b.scenarioLevels ?? {})])) {
    const ids = new Set([...Object.keys(a.scenarioLevels?.[c] ?? {}), ...Object.keys(b.scenarioLevels?.[c] ?? {})]);
    for (const id of ids) {
      const from = (a.scenarioLevels?.[c] as Record<string, number> | undefined)?.[id] ?? null;
      const to = (b.scenarioLevels?.[c] as Record<string, number> | undefined)?.[id] ?? null;
      if (from !== to) out.push({ component: c, activity: id, from, to });
    }
  }
  return out;
}

export function compareAudits(repo: string, a: Audit, b: Audit, ha: HistoryLine | undefined, hb: HistoryLine | undefined) {
  return {
    from: a.id,
    to: b.id,
    rubricChanged: a.rubric !== b.rubric ? { from: a.rubric, to: b.rubric } : null,
    levels: ha && hb ? levelChanges(ha, hb) : [],
    weakening: weakening(repo, a.repo.commit, b.repo.commit),
  };
}
