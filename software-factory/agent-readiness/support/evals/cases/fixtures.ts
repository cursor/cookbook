import { expected, fixtureNames } from "../../tools/fixture.ts";
import type { EvalCase } from "../lib/types.ts";

const SMOKE = new Set(["healthy-node", "hidden-service", "tautological-tests", "agents-md-drift"]);
// Never used to decide a hill-climb round (`--hill-climb` leaves them out) and reported apart from
// the rest, so a round's gain can be checked on fixtures it wasn't tuned on. No hill-climb round
// targeted these, and evals/labels/ builds no label from them.
export const HOLDOUT = new Set(["standalone-nested-mixed", "vendored-skill", "write-mode-lint"]);

export const cases: EvalCase[] = fixtureNames().flatMap((fixture) => {
  const exp = expected(fixture);
  return exp.runs.filter((run) => !run.registryEnv).map((run) => {
    let prompt = "Run an agent readiness audit, permission tier local-exec.";
    if (run.scenarios) prompt += ` Add the ${run.scenarios.join(" and ")} ${run.scenarios.length > 1 ? "scenarios" : "scenario"} for every component.`;
    if (exp.outcomes) prompt += " For outcomes, use the recorded PR list at {root}/prs.json.";
    if (run.registryEnv) prompt += ` Our private registry token is in the ${Object.keys(run.registryEnv).join(", ")} environment variable.`;
    return {
      id: run.name === "default" ? fixture : `${fixture}/${run.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      fixture,
      tags: [...(SMOKE.has(fixture) && run.name === "default" ? ["smoke"] : []), "full", ...(HOLDOUT.has(fixture) ? ["holdout"] : [])],
      expectedRun: run.name,
      turns: [{ prompt }],
      env: run.runtime ? { ...run.registryEnv, SA_READINESS_RUNTIME: run.runtime } : run.registryEnv,
      prs: exp.outcomes,
      ...(run.scenarios ? { scriptedArgs: ["--scenario", run.scenarios.join(",")] } : {}),
      description: exp.purpose,
    } as EvalCase;
  });
});
