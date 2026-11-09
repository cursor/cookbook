import { CLI, honestPath, must } from "../lib/honest.ts";
import { scenarioLevelsMatch, scenarioRecorded } from "../lib/coverage.ts";
import { expectedJsonGate, levelsGate, narrationGate, reportGate, sealedGate, trajectory } from "../lib/grade.ts";
import type { EvalCase } from "../lib/types.ts";

// Scenarios requested in plain words at intake. The agent picks the scenario and the components;
// the scripts grade the scenario's Level 2 bar next to the standard level, which never changes.

const repoWide: EvalCase = {
  id: "scenario-repo-wide",
  fixture: "python-unpinned",
  tags: ["full"],
  description: "Asked about repo-wide changes, the agent adds the repo_wide scenario. The standard level stays 2; the scenario, which also needs pinned toolchains and a frozen install, is 1.",
  turns: [{ prompt: "Audit this repo for agents doing repo-wide changes, permission tier local-exec." }],
  gates: [sealedGate, expectedJsonGate, reportGate, narrationGate, trajectory],
};

const someComponents: EvalCase = {
  id: "scenario-components",
  fixture: "monorepo-mixed",
  tags: ["full"],
  description: "The user wants agents fixing bugs in two of three packages. The bug_fixes scenario covers only worker and shared, the standard levels and repo rollup don't move, and shared, held at Level 1 by stale instructions, meets the bug-fix bar.",
  turns: [{ prompt: "Run an agent readiness audit, permission tier local-exec. We only want agents fixing bugs in worker and shared." }],
  gates: [sealedGate, levelsGate, scenarioRecorded("bug_fixes", ["worker", "shared"]), scenarioLevelsMatch({ worker: { bug_fixes: 1 }, shared: { bug_fixes: 2 } }), narrationGate, trajectory],
};

const steps = (scenario: string, components?: string) => [
  `${CLI} init --tier local-exec`,
  `${CLI} scan`,
  `${CLI} scenario add ${scenario}${components ? ` --components ${components}` : ""}`,
  `${CLI} replay`,
  `${CLI} seal`,
];

export const cases: EvalCase[] = [
  repoWide,
  honestPath(repoWide, [(a) => steps("repo_wide").forEach((s) => must(a.sh(s), s))], "add repo_wide at intake, then replay and seal."),
  someComponents,
  honestPath(someComponents, [(a) => steps("bug_fixes", "worker,shared").forEach((s) => must(a.sh(s), s))], "add bug_fixes for worker and shared after the scan, then replay and seal."),
];
