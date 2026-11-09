import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { CondId, Effort, Level, ScenarioId, Strength } from "./types.ts";
import { SKILL_ROOT, readJson, readText, sha256 } from "./util.ts";

export interface RubricCheck {
  id: string;
  title: string;
  scope: "repo" | "component";
  informational?: boolean;
  minStrengthForPass?: Strength;
  why: string;
  sources: { claim: string; caveat: string; url: string }[];
}

export interface RubricTemplate {
  title: string;
  kind?: "fix" | "decision" | "rollout";
  effort: Effort;
  size: string;
  ownerRole: string;
  decision?: string;
  why: string;
  doneWhen: string;
  steps: { title: string; detail: string }[];
  researchCheck?: string;
}

export interface Rubric {
  version: string;
  scale: { level: Level; name: string; plain: string; meaning: string; measuredBy: "audit" | "outcomes" }[];
  strengths: Strength[];
  strengthLabels: Record<Strength, string>;
  checks: RubricCheck[];
  conditions: Record<CondId, { check: string; scope: "repo" | "component"; label: string }>;
  level1: CondId[];
  level2: CondId[];
  scenarios: { id: ScenarioId; label: string; level2: CondId[] }[];
  changes?: string[];
  // "measured-window" (from 2026-11-alpha): the window is exactly outcomes.windowDays long, and a
  // first-time CI rate needs outcomes.minRateN finished runs. Without it, neither is checked.
  level3: { minAgentPRs: number; absoluteMinAgentPRs: number; windowDays: number; rule?: "measured-window"; floor?: string };
  // "streak" (from 2026-11-alpha): consecutiveWindows back-to-back windows at Level 3 or above.
  // Without it, the 2026-10-alpha rule: compare with the last audit at Level 3 or above.
  level4: { consecutiveWindows: number; volumeMultiplier: number; rule?: "streak" };
  components: { maxAssessed: number; historyDays: number; botAuthorPatterns: string[]; generatedPatterns: string[]; lockfiles: string[] };
  repoLevel: { activeShare: number; hysteresisAudits: number; partialCoverageShare: number; rule: string; newComponentsJoin?: boolean };
  mutation: { perComponent: number; minForPass: number; languages: string[]; operators: string[]; runTimeoutSec: number; flakeRuns: number; targeting: string };
  budgets: { commandTimeoutSec: number; componentMinutes: number; totalMinutes: number };
  outcomes: {
    windowDays: number;
    minRateN: number;
    defaultFilter: { branchPrefixes: string[]; labels: string[]; authors: string[]; coAuthorTrailers: string[] };
    metrics: string[];
    activityLabels: Record<string, string[]>;
  };
  part1: { maxHeadlineWords: number; maxGaps: number; maxGapWords: number; bannedTerms: string[]; levelNames: string[] };
  effortX: Record<Effort, number>;
  matrixQuadrants: string[];
  // "relative" (from 2026-11-alpha): impact is placed against the largest action's impact.
  matrixImpact?: "relative";
  templates: Record<string, RubricTemplate>;
  notAssessed: string[];
}

export function rubricDir(): string {
  return join(SKILL_ROOT, "rubric");
}

export function latestRubricVersion(): string {
  const versions = readdirSync(rubricDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
  if (versions.length === 0) throw new Error("No rubric files found");
  return versions[versions.length - 1];
}

const cache = new Map<string, Rubric>();

export function loadRubric(version?: string): Rubric {
  const v = version ?? latestRubricVersion();
  const hit = cache.get(v);
  if (hit) return hit;
  const rubric = readJson<Rubric>(join(rubricDir(), `${v}.json`));
  cache.set(v, rubric);
  return rubric;
}

export function rubricDigest(version: string): string {
  return sha256(readText(join(rubricDir(), `${version}.json`)));
}

export function strengthRank(rubric: Rubric, s: Strength): number {
  return rubric.strengths.indexOf(s);
}

export function scenario(rubric: Rubric, id: string) {
  const a = rubric.scenarios.find((x) => x.id === id);
  if (!a) throw new Error(`Unknown scenario ${id}. Use one of: ${rubric.scenarios.map((x) => x.id).join(", ")}.`);
  return a;
}

export function check(rubric: Rubric, id: string): RubricCheck {
  const c = rubric.checks.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown check ${id}`);
  return c;
}
