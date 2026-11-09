import { CLI, honestPath, must } from "../lib/honest.ts";
import { TARGETS, capReasonIncludes, editAndCommit, outcomesShown, seedAudit, seedRecheck, seedTargets } from "../lib/coverage.ts";
import { auditCount, repoLevelIs } from "../lib/gates.ts";
import { narrationGate, sealedGate, trajectory } from "../lib/grade.ts";
import type { EvalCase } from "../lib/types.ts";

// Levels 3 and 4 end to end on healthy-node, which reaches Level 2. Its recorded PR files hold 20
// agent PRs in one 30-day window (prs.template.json) and 42 in the next (prs-later.template.json).
// Earlier windows are seeded by the harness as sealed audits dated 30 days back.

const AUDIT = "Run an agent readiness audit, permission tier external-systems. Our agent PRs for the last 30 days are in the recorded PR list at {root}/prs.json.";
const OUTCOMES = "--outcomes-input ../prs.json";

const level3: EvalCase = {
  id: "level-3-outcomes",
  fixture: "healthy-node",
  tags: ["full"],
  prs: "prs.template.json",
  description: "A Level 2 repo with 20 agent PRs in the window. Once the user records targets, the re-audit measures them against the control group and reaches Level 3.",
  turns: [
    { prompt: AUDIT },
    { prompt: "Record our Level 3 targets: a merge rate of at least 0.7, a first-time CI pass rate of at least 0.6, and change requests on at most 0.3 of agent PRs. Then re-audit with the same PR list." },
  ],
  gates: [sealedGate, repoLevelIs(3), outcomesShown, auditCount(2), narrationGate, trajectory],
};

const shortWindow: EvalCase = {
  id: "level-3-short-window",
  fixture: "healthy-node",
  tags: ["full"],
  prs: "prs.template.json",
  description: "The same PRs and recorded targets, measured over 28 days because the user asks for it. Level 3 is measured only over a 30-day window, so the repo stays at Level 2 and the report says why.",
  setup: (ws) => seedTargets(ws, shortWindow),
  turns: [{ prompt: "Run an agent readiness audit, permission tier external-systems. Our agent PRs are in the recorded PR list at {root}/prs.json. We only have four weeks of agent history, so measure outcomes over a 28-day window." }],
  gates: [sealedGate, repoLevelIs(2), capReasonIncludes("30-day window; this one was 28 days"), narrationGate, trajectory],
};

const streak: EvalCase = {
  id: "level-4-streak",
  fixture: "healthy-node",
  tags: ["full"],
  prs: "prs-later.template.json",
  description: "A sealed Level 3 audit of the previous 30 days is in history. This window has more than twice the agent PRs with a lower change-request rate, so two back-to-back windows make Level 4.",
  setup: (ws) => {
    seedTargets(ws, streak);
    seedAudit(ws, streak, { daysAgo: 30, prs: "prs.template.json" });
  },
  turns: [{ prompt: AUDIT }],
  gates: [sealedGate, repoLevelIs(4), auditCount(2), narrationGate, trajectory],
};

const brokenStreak: EvalCase = {
  id: "level-4-failed-recheck",
  fixture: "healthy-node",
  tags: ["full"],
  prs: "prs-later.template.json",
  description: "level-4-streak's twin: between the two windows a recheck failed on a broken test, since reverted. A failed recheck ends the run of Level 3 windows, so this window is the first again: Level 3, not 4.",
  setup: (ws) => {
    seedTargets(ws, brokenStreak);
    seedAudit(ws, brokenStreak, { daysAgo: 30, prs: "prs.template.json" });
    editAndCommit(ws, "test/pricing.test.js", "assert.equal(discount(100), 90);", "assert.equal(discount(100), 100);", "Change the discount test");
    seedRecheck(ws, brokenStreak, 15);
    editAndCommit(ws, "test/pricing.test.js", "assert.equal(discount(100), 100);", "assert.equal(discount(100), 90);", "Revert the discount test");
  },
  turns: [{ prompt: AUDIT }],
  gates: [sealedGate, repoLevelIs(3), capReasonIncludes("back-to-back windows"), auditCount(2), narrationGate, trajectory],
};

const audit = (extra = "") => `${CLI} audit --tier external-systems ${OUTCOMES}${extra}`;

export const cases: EvalCase[] = [
  level3,
  honestPath(level3, [(a) => must(a.sh(audit()), "audit"), (a) => (must(a.sh(`${CLI} roadmap targets ${TARGETS.join(" ")}`), "targets"), must(a.sh(audit()), "re-audit"))], "audit, record the targets, re-audit."),
  shortWindow,
  honestPath(shortWindow, [(a) => must(a.sh(audit(" --window-days 28")), "audit")], "one audit over a 28-day window."),
  streak,
  honestPath(streak, [(a) => must(a.sh(audit()), "audit")], "one audit of this window."),
  brokenStreak,
  honestPath(brokenStreak, [(a) => must(a.sh(audit()), "audit")], "one audit of this window."),
];
