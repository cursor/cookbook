import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadCases, planJobs, select } from "../support/evals/lib/plan.ts";
import type { Arm } from "../support/evals/lib/types.ts";

const workflow = readFileSync(join(import.meta.dirname, "..", "support/examples/github-workflows/skill-evals.yml"), "utf8");

function flag(line: string, name: string): number {
  const m = line.match(new RegExp(`--${name} (\\d+)`));
  assert.ok(m, `the skill-evals step has no --${name}`);
  return Number(m[1]);
}

describe("the example GitHub workflow", () => {
  test("the skill-evals step's --max-runs covers the full suite with every arm it can be given", async () => {
    const line = workflow.split("\n").find((l) => l.includes("npm run evals -- --tag ${{ steps.set.outputs.tag }}"));
    assert.ok(line, "no skill-evals step");
    const repeats = flag(line, "repeats");
    const cap = flag(line, "max-runs");
    const all = await loadCases();
    for (const tag of ["smoke", "full"]) {
      for (const arms of [["agent"], ["agent", "scripted"], ["agent", "scripted", "skill-off"]] as Arm[][]) {
        const runs = planJobs(select(all, { tag }), arms, ["model"], repeats).length;
        assert.ok(runs <= cap, `--tag ${tag} --arm ${arms.join(",")} plans ${runs} runs at ${repeats} repeats, over --max-runs ${cap}`);
      }
    }
  });
});
