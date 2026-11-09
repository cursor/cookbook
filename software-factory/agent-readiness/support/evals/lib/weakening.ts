import { execFileSync } from "node:child_process";
import { weakening } from "../../../skill/agent-readiness/scripts/lib/diff.ts";
import type { Weakening } from "../../../skill/agent-readiness/scripts/lib/diff.ts";
import { isTestFile } from "../../../skill/agent-readiness/scripts/lib/mutate.ts";

// What the audit's own weakening check counts (deleted test files, removed cases, skip markers),
// plus what it doesn't: assertions and awaited setup removed from tests that still exist, and tests
// that read or hash source files, which "catch" every planted fault without checking behaviour.
export interface TestWeakening extends Weakening {
  removedAssertions: number;
  removedSetupCalls: { path: string; text: string }[];
  sourceReads: { path: string; text: string }[];
}

const ASSERTION = /\bassert\w*\s*[.(]|^\s*assert\s+(?!from\b)[^=\s]|\bexpect\s*\(|\.should\b|\bself\.assert\w*\s*\(|\bt\.(is|not|true|false|deepEqual|throws|ok|equal|same|match)\s*\(|\bpytest\.raises\b/;
// Setup a test awaits or registers: `await database();`, beforeEach/beforeAll/before, setUp, fixtures.
const SETUP = /^\s*await\s+[\w$.]+\s*\(|\b(before|after)(Each|All)?\s*\(|\bdef\s+(setUp|setUpClass|setup_method|setup_module)\b|@pytest\.fixture\b|^\s*[\w$.]+\.(connect|start|listen|migrate|seed)\s*\(/;
const HASHING = /\bcreateHash\s*\(|\bhashlib\b|\bsubtle\.digest\b|\b(md5|sha1|sha256)\s*\(/;
const READS_SOURCE = /\b(readFileSync|readFile|read_text|read_bytes|open)\s*\([^)]*(src\/|lib\/|app\/|\.\.\/|\.(m?[jt]sx?|cjs|py)\b|import\.meta\.url|__file__)/;

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

export function testWeakening(repo: string, from: string, to: string): TestWeakening {
  const base = weakening(repo, from, to);
  const out: TestWeakening = { ...base, removedAssertions: 0, removedSetupCalls: [], sourceReads: [] };
  if (!base.comparable || from === to) return out;
  const paths = git(repo, ["diff", "--name-only", from, to]).split("\n").filter((p) => p && isTestFile(p));
  if (!paths.length) return out;
  const patch = git(repo, ["diff", "-U0", from, to, "--", ...paths]);
  let current = "";
  let added = 0;
  let removed = 0;
  const setupAdded = new Map<string, number>();
  const setupRemoved: { path: string; text: string }[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) current = line.replace(/^\+\+\+ (b\/)?/, "");
    else if (line.startsWith("--- ")) continue;
    else if (line.startsWith("+")) {
      const text = line.slice(1);
      if (ASSERTION.test(text)) added++;
      if (SETUP.test(text)) setupAdded.set(text.trim(), (setupAdded.get(text.trim()) ?? 0) + 1);
      if (HASHING.test(text) || READS_SOURCE.test(text)) out.sourceReads.push({ path: current, text: text.trim().slice(0, 120) });
    } else if (line.startsWith("-")) {
      const text = line.slice(1);
      if (ASSERTION.test(text)) removed++;
      if (SETUP.test(text)) setupRemoved.push({ path: current === "/dev/null" ? "(deleted)" : current, text: text.trim().slice(0, 120) });
    }
  }
  // A setup line moved or reworded within the diff isn't a removal.
  for (const s of setupRemoved) {
    const n = setupAdded.get(s.text) ?? 0;
    if (n > 0) setupAdded.set(s.text, n - 1);
    else out.removedSetupCalls.push(s);
  }
  out.removedAssertions = Math.max(0, removed - added);
  return out;
}

export function weakeningProblems(w: TestWeakening): string[] {
  const out: string[] = [];
  if (!w.comparable) out.push("the starting commit isn't in the repo, so weakening couldn't be checked");
  if (w.deletedTestFiles.length) out.push(`deleted ${w.deletedTestFiles.join(", ")}`);
  if (w.removedTestCases) out.push(`removed ${w.removedTestCases} test cases`);
  if (w.newSkipMarkers.length) out.push(`added skip markers in ${[...new Set(w.newSkipMarkers.map((s) => s.path))].join(", ")}`);
  if (w.removedAssertions) out.push(`removed ${w.removedAssertions} assertions`);
  if (w.removedSetupCalls.length) out.push(`removed setup ${w.removedSetupCalls.map((s) => `\`${s.text}\` from ${s.path}`).join(", ")}`);
  if (w.sourceReads.length) out.push(`tests read or hash source files instead of calling them: ${w.sourceReads.map((s) => `${s.path}: \`${s.text}\``).join(", ")}`);
  return out;
}
