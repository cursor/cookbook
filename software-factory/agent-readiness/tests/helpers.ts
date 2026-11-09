import { partialCoverage } from "../skill/agent-readiness/scripts/lib/levels.ts";
import { buildReport } from "../skill/agent-readiness/scripts/lib/render.ts";
import { updateRoadmap } from "../skill/agent-readiness/scripts/lib/roadmap.ts";
import { latestRubricVersion, loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { compute } from "../skill/agent-readiness/scripts/lib/seal.ts";
import { noRealResults } from "../skill/agent-readiness/scripts/lib/score.ts";
import type { Audit, Component, ContractCommand, Diagnosis, Evidence, HistoryLine, InstructionItem, OutcomesSnapshot, ReportJson, SafetyFinding, ScenarioSpec, Targets, Where } from "../skill/agent-readiness/scripts/lib/types.ts";

// Mirrors the seal's report build without git or files.
export function reportFor(audit: Audit, history: HistoryLine[] = [], targets: Targets | null = null, previousReport: ReportJson | null = null): ReportJson {
  const rubric = loadRubric(audit.rubric);
  const c = compute(audit, rubric, history, targets);
  const comps = audit.profile!.components;
  const noResults = noRealResults(audit, c.states);
  const rm = updateRoadmap(targets ? { schema: "agent-readiness/roadmap@1", owner: null, targets, items: [], updatedBy: "x", updatedAt: "2026-10-27T15:00:00.000Z" } : null, { audit, rubric, components: comps, states: c.states, active: c.active, outcomes: audit.outcomes, decisionsOnly: Boolean(noResults) });
  const line: HistoryLine = { id: audit.id, kind: "audit", date: "2026-10-27", commit: "abc", rubric: audit.rubric, scriptsDigest: "x", result: "sealed", levels: Object.fromEntries([...c.levels.entries()].map(([id, l]) => [id, l.level])), repoLevel: c.repo.level, scenarioLevels: {}, shares: {}, active: [...c.active], seedPinned: false };
  return buildReport({ audit, rubric, components: comps, states: c.states, levels: c.levels, scenarioLevels: c.scenarioLevels, rollup: c.repo, active: c.active, roadmap: rm.roadmap, top: rm.top, startNow: rm.startNow, history, currentLine: line, previousOutcomes: null, weakening: null, sealStatus: "Seal verified against release agent-readiness-v0.1.0", staleCopy: null, storedAt: ".agent-readiness/history/audits/x", partial: partialCoverage(rubric, comps), noResults, previousReport });
}

type R = "pass" | "fail";

export interface CompSpec {
  id: string;
  share: number;
  assessed?: boolean;
  test?: R | "missing" | "not_run";
  lint?: R;
  faults?: R | "not_run";
  where?: Where;
  diagnosis?: Diagnosis;
  reason?: string;
}

export interface AuditSpec {
  id?: string;
  scenarios?: ScenarioSpec[];
  install?: R;
  components: CompSpec[];
  instructions?: InstructionItem[];
  safety?: SafetyFinding[];
  toolchainPinned?: boolean;
  lockfile?: R;
  outcomes?: OutcomesSnapshot | null;
  createdAt?: string;
  // The rubric new audits use unless a test names an older one.
  rubric?: string;
}

export function makeAudit(spec: AuditSpec): Audit {
  const evidence: Evidence[] = [];
  const contract: ContractCommand[] = [];
  const at = spec.createdAt ?? "2026-10-27T15:00:00.000Z";
  const add = (e: Omit<Evidence, "id" | "at">) => evidence.push({ id: `ev-${String(evidence.length + 1).padStart(3, "0")}`, at, ...e });
  contract.push({ id: "cmd-repo-install", kind: "install", component: "*", cwd: ".", command: "npm ci", source: "readiness", reason: "frozen install", timeoutSec: 600 });
  add({ checkId: "bootstrap.cold_replay", condition: "clean.install", component: "*", kind: "install", contractId: "cmd-repo-install", strength: "clean_replay", where: "container", result: spec.install ?? "pass", command: "npm ci", summary: `install ${spec.install ?? "pass"}` });
  for (const c of spec.components) {
    const where = c.where ?? "container";
    const strength = where === "container" ? "clean_replay" : "executed";
    if (c.lint) {
      contract.push({ id: `cmd-${c.id}-lint`, kind: "lint", component: c.id, cwd: c.id, command: "npm run lint", source: "package.json scripts.lint", reason: "lint", timeoutSec: 600 });
      add({ checkId: "verify.canonical_interface", condition: "commands", component: c.id, kind: "lint", contractId: `cmd-${c.id}-lint`, strength, where, result: c.lint, command: "npm run lint", summary: `lint ${c.lint}` });
    }
    if (c.test !== "missing") {
      contract.push({ id: `cmd-${c.id}-test`, kind: "test", component: c.id, cwd: c.id, command: "npm test", source: "package.json scripts.test", reason: "test", timeoutSec: 600 });
      add({ checkId: "bootstrap.cold_replay", condition: "clean.test", component: c.id, kind: "test", contractId: `cmd-${c.id}-test`, strength, where, result: c.test ?? "pass", command: "npm test", summary: c.reason ?? `test ${c.test ?? "pass"}`, diagnosis: c.diagnosis });
    }
    if (c.faults) add({ checkId: "verify.behavioral_oracle", condition: "faults", component: c.id, strength, where, result: c.faults, summary: c.faults === "pass" ? "caught 5 of 5 planted faults" : c.faults === "fail" ? "caught 0 of 5 planted faults" : "tests must pass before faults can be planted" });
  }
  if (spec.lockfile) add({ checkId: "bootstrap.cold_replay", condition: "lockfile", component: "*", strength: "clean_replay", where: "container", result: spec.lockfile, summary: `lockfile ${spec.lockfile}` });
  const components: Component[] = spec.components.map((c) => ({ id: c.id, path: c.id, language: "js", manifest: `${c.id}/package.json`, scripts: {}, changes: Math.round(c.share * 100), changeShare: c.share, assessed: c.assessed ?? true, notAssessedReason: c.assessed === false ? "Terraform isn't supported yet" : undefined }));
  return {
    schema: "agent-readiness/audit@1",
    id: spec.id ?? "aud-2026-10-27-abc1234-0001",
    kind: "audit",
    createdAt: at,
    state: "draft",
    repo: { name: "example-org/example", commit: "abc1234def", dirtyTree: false },
    scenarios: spec.scenarios ?? [],
    tier: "local-exec",
    rubric: spec.rubric ?? latestRubricVersion(),
    skill: { version: "0.1.0", scriptsDigest: "0".repeat(64), rubricDigest: "0".repeat(64), release: null },
    seed: { value: "seed", pinned: false },
    environment: { containerRuntime: "docker", image: "node:22-bookworm-slim", registryEnv: [], inheritEnv: false },
    profile: {
      repoType: components.length > 1 ? "monorepo" : "single",
      packageManager: "npm",
      manifests: [],
      lockfiles: ["package-lock.json"],
      ciFiles: [],
      instructionFiles: [],
      toolchain: spec.toolchainPinned === false ? { pinned: false, files: [], missing: ["the Node version (.nvmrc or engines.node)"] } : { pinned: true, files: [".nvmrc"], missing: [] },
      environmentJson: null,
      components,
      satellites: [],
      historyDays: 90,
      totalChanges: 100,
    },
    assets: [],
    contract,
    instructions: spec.instructions ?? [],
    safety: spec.safety ?? [],
    evidence,
    mutants: [],
    outcomes: spec.outcomes ?? null,
    narration: null,
  };
}

export function instruction(result: "pass" | "fail", text = "npm test", reason?: string): InstructionItem {
  return { id: `ins-${text.length}`, source: "AGENTS.md", line: 3, kind: "command", text, category: "replay", staticResult: result === "fail" && reason?.startsWith("uses") ? "fail" : "pass", result, reason };
}

export function stats(opened: number, merged: number, firstPass: number, changesRequested: number) {
  return { opened, merged, firstTimeCiPass: firstPass, firstTimeCiKnown: opened, changesRequested, medianDaysToMerge: 1, addingPaths: {}, mergedByActivity: {} };
}

export function outcomes(from: string, to: string, agent: ReturnType<typeof stats>, control: ReturnType<typeof stats>, byComponent: Record<string, ReturnType<typeof stats>> = {}): OutcomesSnapshot {
  return { source: "file", window: { from, to, days: 30 }, filter: { branchPrefixes: ["cursor/"], labels: [], authors: [], coAuthorTrailers: [] }, agent, control, byComponent, matchedAgentPrs: [], multiComponentPrs: 0 };
}
