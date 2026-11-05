import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inventory, orgSkillBuilders } from "./lib/assets.ts";
import { addContractCommand, checkComponent, discoverContract } from "./lib/contract.ts";
import { compareAudits, weakeningFlags } from "./lib/diff.ts";
import { addEvidence, recordObservation } from "./lib/evidence.ts";
import { ghAvailable, ghJson } from "./lib/gh.ts";
import { auditIds, loadSealedAudit, pushHistory, readHistory, readRoadmap, writeRoadmap } from "./lib/history.ts";
import { MAX_PRS, computeOutcomes, fetchPrs, loadPrsFile } from "./lib/outcomes.ts";
import { buildProfile } from "./lib/profile.ts";
import { redact } from "./lib/redact.ts";
import { evidenceFromPhase, hostExecutor, newBudget, registryValuesOf, replay, runContract } from "./lib/replay.ts";
import { latestRubricVersion, loadRubric } from "./lib/rubric.ts";
import { SCAN_BOUND_MINUTES, sampledScope } from "./lib/scope.ts";
import { validateAgainst } from "./lib/schema.ts";
import { blockedBy, componentStates } from "./lib/score.ts";
import { buildSealedReport, recheck, seal, verifySeal } from "./lib/seal.ts";
import { composeServices, renderEnvFiles, renderVerifySkill, serviceKey, writeFiles } from "./lib/skill.ts";
import { staticSignals } from "./lib/signals.ts";
import { instructionItems, safetyScan } from "./lib/static.ts";
import type { Audit, CommandKind, Narration, Result, Roadmap, ScanBound, ScenarioId, ScenarioSpec, Strength, Tier } from "./lib/types.ts";
import { addDays, exists, fail, git, nowIso, randomHex, readJson, readText, sha256, today, writeJson } from "./lib/util.ts";
import { commitReader, currentDraftId, initAudit, loadDraft, paths, refreshTree, releaseManifest, resolveRepo, saveDraft, scratchTree } from "./lib/workspace.ts";

const BOOLEAN = new Set(["force", "remediate", "inherit-env", "no-mutants", "no-instructions", "no-outcomes", "json", "push", "allow-eval", "allow-unkeyed", "dockerfile", "instructions", "strict", "help"]);

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [key, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (inline !== undefined) flags[key] = inline;
      else if (BOOLEAN.has(key)) flags[key] = true;
      else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) fail(`--${key} needs a value`);
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function str(a: Args, key: string, fallback?: string): string {
  const v = a.flags[key];
  if (typeof v === "string") return v;
  if (fallback !== undefined) return fallback;
  return fail(`Missing --${key}`);
}

function opt(a: Args, key: string): string | undefined {
  const v = a.flags[key];
  return typeof v === "string" ? v : undefined;
}

function csv(v: string | undefined): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

const SCENARIOS: ScenarioId[] = ["first_pr", "bug_fixes", "features", "repo_wide"];
const TIERS: Tier[] = ["read-only", "local-exec", "external-systems"];

const log = (s: string) => process.stdout.write(s + "\n");

function repoOf(a: Args): string {
  return resolveRepo(opt(a, "repo") ?? process.cwd());
}

function requireTier(audit: Audit, needed: Tier, what: string): void {
  if (TIERS.indexOf(audit.tier) < TIERS.indexOf(needed)) fail(`${what} needs the ${needed} tier; this audit is ${audit.tier}.`);
}

// Scenarios are optional: every audit reports one standard level per component and a repo rollup.
function scenarioIds(a: Args): ScenarioId[] {
  const ids = csv(opt(a, "scenario"));
  const goal = opt(a, "goal");
  if (goal) {
    log(`--goal is now --scenario: added the ${goal} scenario for every component. Levels are standard without it.`);
    ids.push(goal);
  }
  for (const id of ids) if (!SCENARIOS.includes(id as ScenarioId)) fail(`--scenario takes ${SCENARIOS.join(", ")}; got ${id}.`);
  return [...new Set(ids)] as ScenarioId[];
}

// Signs that agents already open PRs here: agent branch names in merges, or agent co-author trailers.
function agentHistory(repo: string): string | null {
  const r = git(["log", `--since=${addDays(today(), -90)}`, "--format=%s%n%b", "-n", "500"], repo);
  const text = r.stdout;
  const branches = text.match(/\b(cursor|codex|claude|copilot|devin)\/[\w./-]+/gi) ?? [];
  const trailers = text.match(/^Co-authored-by: .*(Cursor|Codex|Claude|Copilot|Devin)/gim) ?? [];
  if (branches.length + trailers.length === 0) return null;
  return [branches.length ? `${branches.length} agent branch ${branches.length === 1 ? "merge" : "merges"}` : "", trailers.length ? `${trailers.length} agent co-author ${trailers.length === 1 ? "trailer" : "trailers"}` : ""].filter(Boolean).join(" and ");
}

function cmdInit(a: Args): void {
  const scenarios: ScenarioSpec[] = scenarioIds(a).map((id) => ({ id, components: ["*"] }));
  const tier = str(a, "tier", "local-exec") as Tier;
  if (!TIERS.includes(tier)) fail(`--tier must be one of ${TIERS.join(", ")}`);
  const registryEnv = csv(opt(a, "registry-env"));
  for (const k of registryEnv) if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) fail(`--registry-env takes variable names, not values: ${k}`);
  for (const k of registryEnv) if (k.startsWith("SA_")) fail(`--registry-env can't pass ${k}: the audit's own settings, such as the seal key, never reach the repo's code.`);
  const { audit, local } = initAudit({ repo: repoOf(a), scenarios, tier, registryEnv, inheritEnv: Boolean(a.flags["inherit-env"]), force: Boolean(a.flags.force) });
  log(`Opened ${audit.id} (${tier}) at ${audit.repo.commit.slice(0, 7)}${scenarios.length ? `, with the ${scenarios.map((s) => s.id).join(" and ")} ${scenarios.length > 1 ? "scenarios" : "scenario"} for every component` : ""}${audit.repo.dirtyTree ? "; uncommitted changes are not audited" : ""}.`);
  log(`Audit tree: ${local.tree}`);
  if (audit.seed.pinned) log("Planted-fault seed is pinned by SA_READINESS_EVAL_SEED: this is an eval run, not a production audit.");
}

function cmdScan(a: Args): void {
  const repo = repoOf(a);
  const { audit, local, paths: p } = loadDraft(repo);
  const rubric = loadRubric(audit.rubric);
  const boundMinutes = Number(str(a, "budget-scan", String(SCAN_BOUND_MINUTES)));
  if (!(boundMinutes > 0)) fail("--budget-scan takes the scan's time bound in minutes, more than 0.");
  const bound: ScanBound = { until: Date.now() + boundMinutes * 60000, scope: { boundMinutes, files: 0, fileCap: null, secrets: { scanned: 0, total: 0 }, assetHistory: { read: 0, total: 0 } } };
  refreshTree(repo, audit.repo.commit, local.tree);
  const profile = buildProfile(repo, local.tree, rubric, audit.repo.commit);
  profile.scope = bound.scope;
  audit.profile = profile;
  audit.safety = safetyScan(local.tree, profile, bound);
  audit.instructions = instructionItems(local.tree, profile);
  for (const item of audit.instructions.filter((i) => i.staticResult === "fail")) {
    const ev = addEvidence(audit, { checkId: "context.instructions_verified", condition: "instructions", strength: "static", where: "static", result: "fail", summary: `${item.source}:${item.line} \`${item.text}\`: ${item.staticReason}` });
    item.evidenceId = ev.id;
  }
  const blocking = audit.safety.filter((s) => s.blocking);
  const { scanned, total } = bound.scope.secrets;
  // A secret scan the bound cut short can't show the repo is clean, only that it found none so far.
  const cutShort = !blocking.length && scanned < total ? `the secret scan read ${scanned} of ${total} files before the scan's ${boundMinutes}-minute bound (--budget-scan)` : undefined;
  addEvidence(audit, { checkId: "safety.execution_boundary", condition: "safety", strength: "static", where: "static", result: blocking.length ? "fail" : cutShort ? "not_run" : "pass", summary: blocking.length ? blocking.map((b) => `${b.file}${b.line ? ":" + b.line : ""} ${b.detail}`).join("; ") : cutShort ? `no blocking findings in the files read; ${cutShort}` : `no blocking findings; ${audit.safety.length} ${audit.safety.length === 1 ? "item" : "items"} listed for review`, ...(cutShort ? { blocked: cutShort } : {}) });
  if (profile.components.some((c) => c.assessed)) addEvidence(audit, { checkId: "bootstrap.cold_replay", condition: "toolchain", component: "*", strength: "static", where: "static", result: profile.toolchain.pinned ? "pass" : "fail", summary: profile.toolchain.pinned ? `toolchain pinned in ${profile.toolchain.files.join(", ")}` : `missing ${profile.toolchain.missing.join(" and ")}` });
  audit.assets = inventory(repo, local.tree, audit.instructions, bound);
  const sampled = sampledScope(audit);
  if (sampled) log(`Sampled: ${sampled}.`);
  const assessedIds = new Set(profile.components.filter((c) => c.assessed).map((c) => c.id));
  const agentCmds = audit.contract.filter((c) => c.source !== "readiness" && !c.source.includes("scripts.") && !c.source.startsWith(".cursor/environment.json"));
  for (const c of agentCmds.filter((x) => x.component !== "*" && !assessedIds.has(x.component))) log(`Dropped ${c.id} (${c.command}): ${c.component} isn't an assessed component after this scan.`);
  audit.contract = [...discoverContract(profile, local.tree, rubric, audit.safety), ...agentCmds.filter((x) => x.component === "*" || assessedIds.has(x.component))];
  audit.signals = staticSignals(local.tree, profile, audit.contract);
  saveDraft(p, audit);
  log(`Scanned ${audit.repo.name}: ${profile.repoType}, package manager ${profile.packageManager ?? "none"}.`);
  for (const c of profile.components) log(`  ${c.id.padEnd(14)} ${String(Math.round(c.changeShare * 100)).padStart(3)}% of changes  ${c.assessed ? "assessed" : `not assessed: ${c.notAssessedReason}`}`);
  const agentWork = agentHistory(repo);
  if (agentWork && audit.tier !== "external-systems") log(`Agent work in the history (${agentWork}). Offer --tier external-systems so the report can measure agent PRs against other PRs; it reads pull requests through gh.`);
  log(`Contract: ${audit.contract.length} commands. Instructions: ${audit.instructions.length} items, ${audit.instructions.filter((i) => i.result === "fail").length} wrong. Safety: ${blocking.length} blocking, ${audit.safety.length - blocking.length} listed.`);
  if (a.flags.strict) {
    const wrong = audit.instructions.filter((i) => i.result === "fail");
    for (const i of wrong) log(`  wrong instruction ${i.source}:${i.line} \`${i.text}\`: ${i.reason}`);
    for (const s of blocking) log(`  blocking safety finding ${s.file}${s.line ? ":" + s.line : ""}: ${s.detail}`);
    if (wrong.length || blocking.length) fail("Static checks failed.", 1);
  }
}

function cmdContract(a: Args): void {
  const repo = repoOf(a);
  const { audit, local, paths: p } = loadDraft(repo);
  const sub = a.positional[1] ?? "list";
  if (sub === "add") {
    const cmd = addContractCommand(audit.contract, {
      kind: str(a, "kind") as CommandKind,
      component: str(a, "component"),
      cwd: str(a, "cwd", "."),
      command: str(a, "cmd"),
      source: str(a, "source", "agent"),
      reason: str(a, "reason"),
    }, audit.profile, commitReader(repo, audit.repo.commit));
    saveDraft(p, audit);
    log(`Added ${cmd.id}: ${cmd.command}`);
    return;
  }
  for (const c of audit.contract) log(`${c.id.padEnd(24)} ${c.kind.padEnd(9)} ${c.cwd.padEnd(18)} ${c.command}   (${c.source})`);
}

function cmdScenario(a: Args): void {
  const repo = repoOf(a);
  const { audit, paths: p } = loadDraft(repo);
  const sub = a.positional[1] ?? "list";
  audit.scenarios ??= [];
  if (sub === "add" || sub === "remove") {
    const id = a.positional[2] as ScenarioId;
    if (!SCENARIOS.includes(id)) fail(`Usage: readiness scenario ${sub} <${SCENARIOS.join("|")}>${sub === "add" ? " [--components a,b]" : ""}`);
    audit.scenarios = audit.scenarios.filter((s) => s.id !== id);
    if (sub === "add") {
      const components = csv(opt(a, "components"));
      if (components.length && !audit.profile) fail("Run `readiness scan` first: a scenario names components the scan found.");
      const assessed = audit.profile!.components.filter((x) => x.assessed).map((x) => x.id);
      for (const c of components) {
        const found = audit.profile!.components.find((x) => x.id === c);
        const choices = assessed.length ? `Use one of: ${assessed.join(", ")}.` : "No component was assessed.";
        if (!found) fail(`No component named ${c}. ${choices}`);
        if (!found.assessed) fail(`${c} isn't assessed (${found.notAssessedReason ?? "not supported"}), so it has no level for a scenario to break down. ${choices}`);
      }
      audit.scenarios.push({ id, components: components.length ? components : ["*"] });
      log(`Added the ${id} scenario for ${components.length ? components.join(", ") : "every assessed component"}. It's reported under ${components.length === 1 ? "that component" : "those components"}, next to the standard level.`);
    } else log(`Removed the ${id} scenario.`);
    saveDraft(p, audit);
    return;
  }
  if (audit.scenarios.length === 0) log("No scenarios: the report gives one standard level per component and a repo rollup.");
  for (const s of audit.scenarios) log(`${s.id}: ${s.components.includes("*") ? "every assessed component" : s.components.join(", ")}`);
}

async function cmdRun(a: Args): Promise<void> {
  const repo = repoOf(a);
  const { audit, local, paths: p } = loadDraft(repo);
  requireTier(audit, "local-exec", "run");
  if (!audit.profile) fail("Run `readiness scan` first.");
  const rubric = loadRubric(audit.rubric);
  const scratch = scratchTree(repo, audit.repo.commit);
  const ex = hostExecutor(scratch.dir, audit.environment.registryEnv, audit.environment.inheritEnv, "host");
  const registryValues = registryValuesOf(audit);
  const component = opt(a, "component");
  if (component) checkComponent(audit.profile, component);
  if (opt(a, "cmd")) {
    const cmd = addContractCommand(audit.contract, { kind: str(a, "kind") as CommandKind, component: str(a, "component"), cwd: str(a, "cwd", "."), command: str(a, "cmd"), source: str(a, "source", "agent"), reason: str(a, "reason") }, audit.profile, commitReader(repo, audit.repo.commit));
    log(`Added ${cmd.id} to the contract.`);
  }
  const id = opt(a, "id");
  const selected = audit.contract.filter((c) => (id ? c.id === id : true) && (!component || c.component === component || c.component === "*") && c.kind !== "start");
  const comps = new Set(audit.profile.components.filter((c) => c.assessed && (!component || c.id === component)).map((c) => c.id));
  try {
    const results = await runContract(ex, selected, { components: comps, budget: newBudget(rubric.budgets.componentMinutes, rubric.budgets.totalMinutes), registryValues, onResult: (r) => log(`  ${r.cmd.kind.padEnd(9)} ${r.cmd.component.padEnd(12)} ${r.status}${r.diagnosis ? ` (${r.diagnosis.detail})` : ""}`) });
    for (const r of results) evidenceFromPhase(audit, ex, r, registryValues);
    if (a.flags.instructions) {
      for (const item of audit.instructions.filter((i) => i.category === "replay" && i.staticResult === "pass")) {
        const out = await ex.exec(item.text, ".", 300);
        const ok = out.exitCode === 0 && !out.timedOut;
        const redacted = redact(out.output, registryValues);
        const ev = addEvidence(audit, { checkId: "context.instructions_verified", condition: "instructions", strength: "executed", where: "host", result: ok ? "pass" : "fail", command: item.text, exitCode: out.exitCode, outputTail: redacted.slice(-1500), outputDigest: sha256(redacted), summary: `${item.source}:${item.line} \`${item.text}\` ${ok ? "replays" : "fails"}` });
        const prior = audit.evidence.find((e) => e.id === item.evidenceId);
        if (prior && (prior.where === "container" || prior.where === "fresh_copy")) {
          log(`  ${item.source}:${item.line} ${item.text}: ${ok ? "pass" : "fail"} on the host; the replay's ${item.result} stands`);
          continue;
        }
        item.result = ok ? "pass" : "fail";
        item.evidenceId = ev.id;
        log(`  ${item.source}:${item.line} ${item.text}: ${item.result}`);
      }
    }
  } finally {
    scratch.dispose();
  }
  saveDraft(p, audit);
}

async function cmdReplay(a: Args): Promise<void> {
  const repo = repoOf(a);
  const { audit, local, paths: p } = loadDraft(repo);
  const rubric = loadRubric(audit.rubric);
  const before = audit.evidence.length;
  try {
    await replay(audit, repo, local.tree, rubric, {
      component: opt(a, "component"),
      mutants: !a.flags["no-mutants"],
      instructions: !a.flags["no-instructions"],
      runtime: str(a, "runtime", process.env.SA_READINESS_RUNTIME || "auto"),
      image: opt(a, "image") ?? (process.env.SA_READINESS_IMAGE || undefined),
      budgetComponentMinutes: Number(str(a, "budget-component", String(rubric.budgets.componentMinutes))),
      budgetTotalMinutes: Number(str(a, "budget-total", String(rubric.budgets.totalMinutes))),
      log,
    });
  } catch (e) {
    // Whatever ran before the error is real evidence; keep it so `status` and a rerun can use it.
    if (audit.evidence.length > before) {
      saveDraft(p, audit);
      log(`Kept ${audit.evidence.length - before} results from before the error.`);
    }
    throw e;
  }
  saveDraft(p, audit);
}

function cmdRecord(a: Args): void {
  const repo = repoOf(a);
  const { audit, paths: p } = loadDraft(repo);
  const ev = recordObservation(audit, loadRubric(audit.rubric), { checkId: str(a, "check"), component: opt(a, "component"), result: str(a, "result") as Result, strength: str(a, "strength", "static") as Strength, summary: str(a, "summary") });
  saveDraft(p, audit);
  log(`Recorded ${ev.id} (${ev.strength}).`);
}

function lockPatterns(audit: Audit): string[] {
  return ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"].filter((f) => !audit.profile?.lockfiles.includes(f));
}

function cmdOutcomes(a: Args): void {
  const repo = repoOf(a);
  const { audit, paths: p } = loadDraft(repo);
  if (!audit.profile) fail("Run `readiness scan` first.");
  const rubric = loadRubric(audit.rubric);
  const d = rubric.outcomes.defaultFilter;
  const filter = {
    branchPrefixes: opt(a, "branch-prefix") !== undefined ? csv(opt(a, "branch-prefix")) : d.branchPrefixes,
    labels: opt(a, "label") !== undefined ? csv(opt(a, "label")) : d.labels,
    authors: opt(a, "author") !== undefined ? csv(opt(a, "author")) : d.authors,
    coAuthorTrailers: opt(a, "co-author") !== undefined ? csv(opt(a, "co-author")) : d.coAuthorTrailers,
  };
  const days = Number(str(a, "window-days", String(rubric.outcomes.windowDays)));
  let prs;
  let source: "gh" | "file";
  let truncated = false;
  const input = opt(a, "input");
  if (input) {
    prs = loadPrsFile(resolve(input));
    source = "file";
  } else {
    requireTier(audit, "external-systems", "Reading pull requests from GitHub");
    if (!ghAvailable()) fail("gh isn't authenticated. Run `gh auth login`, or pass --input with a recorded PR file.");
    const slug = opt(a, "repo-slug") ?? ghJson<{ nameWithOwner: string }>(["repo", "view", "--json", "nameWithOwner"], repo).nameWithOwner;
    ({ prs, truncated } = fetchPrs(slug, days));
    source = "gh";
  }
  audit.outcomes = computeOutcomes(prs, audit.profile.components, rubric, filter, days, source, lockPatterns(audit), truncated);
  saveDraft(p, audit);
  const o = audit.outcomes;
  log(`Outcomes ${o.window.from} to ${o.window.to}: ${o.agent.opened} agent PRs (${o.agent.merged} merged), ${o.control.opened} other PRs. Filter: ${JSON.stringify(filter)}.`);
  if (source === "file") log("Outcomes from a recorded PR file make this an eval audit: verify-seal won't accept it as a production result.");
  if (truncated) log(`gh returned ${MAX_PRS} PRs, its cap, so the window may hold more. Level 3 isn't measured from a partial window.`);
}

function cmdNarrate(a: Args): void {
  const repo = repoOf(a);
  const { audit, paths: p } = loadDraft(repo);
  const n: Narration = opt(a, "file") ? readJson<Narration>(resolve(str(a, "file"))) : { ...(audit.narration ?? {}) };
  if (opt(a, "headline")) n.headline = str(a, "headline");
  if (opt(a, "ask")) n.ask = str(a, "ask");
  for (const kv of csv(opt(a, "gap"))) {
    const [k, v] = kv.split("=");
    n.gaps = { ...(n.gaps ?? {}), [k]: v };
  }
  for (const kv of csv(opt(a, "title"))) {
    const [k, v] = kv.split("=");
    n.titles = { ...(n.titles ?? {}), [k]: v };
  }
  audit.narration = n;
  saveDraft(p, audit);
  log("Narration saved. `readiness seal` checks it against the part 1 rules and the computed numbers.");
}

// One wording for a level wherever status prints it, matching part 4 of the report.
function levelText(row: { level: number | null; couldBe: number | null; unproven: boolean } | undefined): string {
  if (!row || row.level === null) return "not assessed";
  if (row.unproven) return "Level 1 unproven on this machine (could be 1)";
  return `Level ${row.level}${row.couldBe !== null ? ` (could be ${row.couldBe})` : ""}`;
}

function cmdStatus(a: Args): void {
  const repo = repoOf(a);
  const { audit, paths: p } = loadDraft(repo);
  const rubric = loadRubric(audit.rubric);
  const comps = audit.profile?.components.filter((c) => c.assessed) ?? [];
  // The ids narration may use, from the report the seal would build right now.
  const preview = audit.profile ? buildSealedReport(JSON.parse(JSON.stringify(audit)) as Audit, rubric, readHistory(p), readRoadmap(p), repo, "") : null;
  const part1 = preview ? { heading: preview.report.executive.heading, gaps: preview.report.executive.gaps.map((g) => ({ itemId: g.itemId, text: g.text })), roadmapItems: preview.roadmap.items.map((i) => i.id) } : null;
  const levels = preview?.report.components.included ?? [];
  const summary = {
    id: audit.id,
    tier: audit.tier,
    commit: audit.repo.commit.slice(0, 7),
    environment: audit.environment,
    repoLevel: preview ? (preview.report.maturity.outcome === "not_assessed" ? "not assessed" : levelText(preview.report.maturity)) : null,
    scenarios: audit.scenarios ?? [],
    components: comps.map((c) => {
      const s = componentStates(audit, rubric, c.id);
      const row = levels.find((x) => x.id === c.id);
      return {
        id: c.id,
        changeShare: c.changeShare,
        conditions: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, `${v.state}: ${v.reason}`])),
        level: levelText(row),
        scenarios: Object.fromEntries((row?.scenarios ?? []).map((x) => [x.id, levelText(x)])),
      };
    }),
    contract: audit.contract.map((c) => `${c.id}: ${c.command}`),
    evidence: audit.evidence.map((e) => `${e.id} ${e.checkId} ${e.component ?? ""} ${blockedBy(e) ? `blocked (${blockedBy(e)})` : `${e.result} (${e.result === "not_run" ? "not run" : e.strength})`}: ${e.summary}`),
    instructionsWrong: audit.instructions.filter((i) => i.result === "fail").map((i) => `${i.source}:${i.line} ${i.text}: ${i.reason}`),
    safety: audit.safety.map((s) => `${s.blocking ? "BLOCKING" : "listed"} ${s.kind} ${s.file}${s.line ? ":" + s.line : ""}: ${s.detail}`),
    outcomes: audit.outcomes ? { window: audit.outcomes.window, agent: audit.outcomes.agent.opened, control: audit.outcomes.control.opened } : null,
    part1,
  };
  if (a.flags.json) log(JSON.stringify(summary, null, 2));
  else {
    log(`${summary.id} (${summary.tier}) at ${summary.commit}. Repo level: ${summary.repoLevel ?? "not computed"}`);
    for (const c of summary.components) log(`  ${c.id}: ${c.level}${Object.keys(c.scenarios).length ? `; scenarios ${Object.entries(c.scenarios).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}\n    ${Object.entries(c.conditions).map(([k, v]) => `${k} ${v}`).join("\n    ")}`);
    if (summary.instructionsWrong.length) log(`Wrong instructions:\n  ${summary.instructionsWrong.join("\n  ")}`);
    if (summary.safety.length) log(`Safety:\n  ${summary.safety.join("\n  ")}`);
    if (part1) {
      log(`Part 1 now: ${part1.heading}`);
      log(part1.gaps.length ? `Part 1 gaps (narrate with --gap <id>=<text>):\n  ${part1.gaps.map((g) => `${g.itemId}: ${g.text}`).join("\n  ")}` : "Part 1 has no gaps to narrate.");
    }
  }
}

function cmdSeal(a: Args): void {
  const repo = repoOf(a);
  const { audit, local, paths: p } = loadDraft(repo);
  const r = seal(audit, local, p, log);
  log(`Report: ${join(p.latest, "report.md")}`);
  log(`Stored: ${r.dir}`);
  log(`Headline: ${r.report.executive.headline}`);
}

function cmdVerify(a: Args): void {
  const p = paths(repoOf(a));
  const { audit } = loadSealedAudit(p, a.positional[1] ?? "latest");
  const r = verifySeal(p, audit.id, { releaseRepo: opt(a, "release-repo"), releaseRef: opt(a, "release-ref"), tierExternal: opt(a, "tier") === "external-systems" || audit.tier === "external-systems", allowUnkeyed: Boolean(a.flags["allow-unkeyed"]) });
  for (const l of r.lines) log(l);
  if (!r.ok) fail("Seal verification failed.", 2);
  if (!r.production && !a.flags["allow-eval"]) fail(`This is an eval audit (${audit.seed.pinned ? "pinned seed" : "outcomes from a recorded PR file"}), not a production result. Pass --allow-eval to accept it.`, 3);
}

async function cmdRecheck(a: Args): Promise<void> {
  const p = paths(repoOf(a));
  const r = await recheck(p, { runtime: str(a, "runtime", process.env.SA_READINESS_RUNTIME || "auto"), image: opt(a, "image") ?? (process.env.SA_READINESS_IMAGE || undefined), log });
  log(`Recheck ${r.line.id}: ${r.line.result}${r.line.note ? ` (${r.line.note})` : ""}. ${r.line.noLevel ? "Repo level: not assessed on this machine." : `Repo level: ${r.line.repoLevel}; components: ${JSON.stringify(r.line.levels)}.`}`);
  if (r.line.result === "failed") process.exitCode = 1;
}

function cmdDiff(a: Args): void {
  const p = paths(repoOf(a));
  const from = loadSealedAudit(p, a.positional[1] ?? "previous").audit;
  const to = loadSealedAudit(p, a.positional[2] ?? "latest").audit;
  const history = readHistory(p);
  const d = compareAudits(p.repo, from, to, history.find((h) => h.id === from.id), history.find((h) => h.id === to.id));
  if (a.flags.json) log(JSON.stringify(d, null, 2));
  else {
    log(`${d.from} -> ${d.to}${d.rubricChanged ? ` (rubric ${d.rubricChanged.from} -> ${d.rubricChanged.to})` : ""}`);
    for (const l of d.levels) log(`  ${l.component} ${l.activity}: ${l.from} -> ${l.to}`);
    const flags = weakeningFlags(d.weakening);
    log(flags.length ? `  Review: ${flags.join(", ")}` : "  No weakened-test flags.");
  }
  if (weakeningFlags(d.weakening).some((f) => f !== "CI changed")) process.exitCode = 1;
}

function cmdHistory(a: Args): void {
  const p = paths(repoOf(a));
  if (a.positional[1] === "push") {
    log(pushHistory(p, { push: Boolean(a.flags.push), remote: str(a, "remote", "origin") }));
    return;
  }
  const lines = readHistory(p);
  if (a.flags.json) log(JSON.stringify(lines, null, 2));
  else for (const h of lines) log(`${h.date} ${h.kind.padEnd(7)} ${h.result.padEnd(6)} ${h.id} repo ${h.noLevel ? "not assessed" : h.repoLevel}${h.note ? ` (${h.note})` : ""}`);
}

// Targets are scored by the audit they apply to: the open draft, else the last sealed audit. Only
// a repo with neither falls back to the rubric new audits use.
function auditRubric(p: ReturnType<typeof paths>): string | undefined {
  const draft = currentDraftId(p);
  if (draft) return loadDraft(p.repo, draft).audit.rubric;
  const last = readHistory(p).filter((h) => h.kind === "audit").at(-1);
  return last?.rubric;
}

function cmdRoadmap(a: Args): void {
  const p = paths(repoOf(a));
  const sub = a.positional[1] ?? "show";
  const rm: Roadmap = readRoadmap(p) ?? { schema: "agent-readiness/roadmap@1", owner: null, targets: null, items: [], updatedBy: "manual", updatedAt: nowIso() };
  if (sub === "owner") {
    const owner = a.positional[2];
    if (!owner) fail('Usage: readiness roadmap owner "<team or role>"');
    rm.owner = owner;
    writeRoadmap(p, rm);
    log(`Owner set to ${owner}.`);
    return;
  }
  if (sub === "targets") {
    const rubric = loadRubric(auditRubric(p));
    const minPrs = Number(str(a, "min-prs", String(rubric.level3.minAgentPRs)));
    if (minPrs < rubric.level3.absoluteMinAgentPRs) fail(`--min-prs can't go below ${rubric.level3.absoluteMinAgentPRs}.`);
    rm.targets = { mergeRate: Number(str(a, "merge-rate")), firstPass: Number(str(a, "first-pass")), maxChangesRequested: Number(str(a, "max-changes-requested")), minAgentPrs: minPrs };
    for (const [k, v] of Object.entries(rm.targets)) if (Number.isNaN(v) || (k !== "minAgentPrs" && (v < 0 || v > 1))) fail(`Target ${k} must be a number between 0 and 1.`);
    writeRoadmap(p, rm);
    log(`Level 3 targets recorded: ${JSON.stringify(rm.targets)}.`);
    return;
  }
  if (a.flags.json) log(JSON.stringify(rm, null, 2));
  else for (const i of rm.items) log(`${String(i.order).padStart(2)}. [${i.status}] ${i.title} (${i.unlocks})`);
}

function latestOrDraft(repo: string, ref?: string): Audit {
  if (ref && ref !== "latest") return loadSealedAudit(paths(repo), ref).audit;
  return loadSealedAudit(paths(repo), "latest").audit;
}

function cmdDraftSkill(a: Args): void {
  if (!a.flags.remediate) fail("draft-skill writes into the repo, so it only runs in remediate mode: pass --remediate.");
  const repo = repoOf(a);
  const audit = latestOrDraft(repo, opt(a, "audit"));
  const out = str(a, "out", ".cursor/skills/verify/SKILL.md");
  const p = paths(repo);
  const earlier = readHistory(p)
    .filter((h) => h.kind === "audit" && h.id !== audit.id)
    .slice(-3)
    .map((h) => loadSealedAudit(p, h.id).audit);
  const { text, commands } = renderVerifySkill(audit, loadRubric(audit.rubric), csv(opt(a, "include")), earlier);
  const written = writeFiles(repo, { [out]: text }, Boolean(a.flags.force));
  log(`Wrote ${written.join(", ")} from ${commands.length} commands that passed in ${audit.id}. Prove it with \`readiness recheck\` after committing.`);
}

function cmdDraftEnv(a: Args): void {
  if (!a.flags.remediate) fail("draft-env writes into the repo, so it only runs in remediate mode: pass --remediate.");
  const repo = repoOf(a);
  const audit = latestOrDraft(repo, opt(a, "audit"));
  const fromDiag = [...new Set(audit.evidence.filter((e) => e.diagnosis?.cause === "service" && e.diagnosis.service).map((e) => serviceKey(e.diagnosis!.service!)).filter((s): s is string => Boolean(s)))];
  const compose = composeServices(repo);
  const services = opt(a, "service") ? csv(opt(a, "service")) : [...new Set([...fromDiag, ...(compose?.services ?? [])])];
  const envExample = exists(join(repo, ".env.example"));
  const env = renderEnvFiles(audit, services, { dockerfile: Boolean(a.flags.dockerfile), envExample });
  const written = writeFiles(repo, env.files, Boolean(a.flags.force));
  log(`Wrote ${written.join(", ")}${services.length ? ` for ${services.join(", ")}` : ""}.`);
  if (compose?.services.length && !opt(a, "service")) log(`${compose.file} runs ${compose.services.join(", ")}; the start script starts ${compose.services.length === 1 ? "it" : "them"} without Docker.`);
  if (envExample) log("The install script copies .env.example to .env when there is no .env, so tests get its local defaults.");
  log("Commit these on a branch, then run a new audit to prove them. Committing .cursor/environment.json doesn't change a Cloud Agent environment by itself: a team admin has to point the environment at it.");
}

function cmdAssets(a: Args): void {
  const repo = repoOf(a);
  const org = opt(a, "org");
  if (org) {
    const tier = (opt(a, "tier") ?? "local-exec") as Tier;
    if (tier !== "external-systems") fail("--org reads GitHub, so it needs --tier external-systems.");
    const r = orgSkillBuilders(org, Number(str(a, "max-repos", "200")));
    if (a.flags.json) log(JSON.stringify(r, null, 2));
    else {
      log(`Skill builders in ${org} (${r.label}; ${r.reposScanned} repos, ${r.skillFiles} skills${r.capped ? ", capped" : ""}):`);
      for (const b of r.builders) log(`  ${b.name}: ${b.skillsWritten} skills written, ${b.recentCommits} commits in 90 days, in ${b.repos.length} repos`);
    }
    return;
  }
  const { audit } = loadDraft(repo);
  for (const x of audit.assets) log(`${x.kind.padEnd(12)} ${x.path.padEnd(48)} ${x.authors.map((y) => `${y.name} (${y.commits})`).join(", ")}  ${x.status}`);
}

function cmdFeedback(a: Args): void {
  const repo = repoOf(a);
  const p = paths(repo);
  const check = a.positional[1];
  if (!check) fail('Usage: readiness feedback <check-id> --note "..."');
  const audit = loadSealedAudit(p, opt(a, "audit") ?? "latest").audit;
  const rubric = loadRubric(audit.rubric);
  if (!rubric.checks.some((c) => c.id === check)) fail(`Unknown check ${check}`);
  const id = `fb-${today()}-${randomHex(3)}`;
  const bundle = {
    schema: "agent-readiness/feedback@1",
    id,
    createdAt: nowIso(),
    rubric: audit.rubric,
    skillVersion: audit.skill.version,
    scriptsDigest: audit.skill.scriptsDigest,
    audit: audit.id,
    check,
    component: opt(a, "component") ?? null,
    evidence: audit.evidence.filter((e) => e.checkId === check && (!opt(a, "component") || e.component === opt(a, "component"))).map((e) => ({ id: e.id, result: e.result, strength: e.strength, outputDigest: e.outputDigest ?? null })),
    note: redact(str(a, "note")),
  };
  const f = join(p.feedback, `${id}.json`);
  writeJson(f, bundle);
  log(`Wrote ${f}. It holds the rubric version, check, evidence digests and your note, and no source code. Send it to the account team.`);
}

function cmdVersion(a: Args): void {
  const m = releaseManifest();
  log(`agent-readiness skill ${m?.version ?? "unreleased"} (${m?.tag ?? "no release manifest"}), rubric ${latestRubricVersion()}`);
  const upstream = opt(a, "upstream");
  if (upstream) {
    if (str(a, "tier", "local-exec") !== "external-systems") fail("--upstream reads GitHub, so it needs --tier external-systems.");
    const tags = ghJson<{ name: string }[]>(["api", `repos/${upstream}/tags`, "--paginate"]).map((t) => t.name).filter((t) => t.startsWith("agent-readiness-v")).sort();
    const latest = tags[tags.length - 1];
    if (!latest) log(`No agent-readiness release tags in ${upstream}.`);
    else if (m && latest !== m.tag) log(`STALE: this copy is ${m.tag}; ${upstream} has ${latest}. Copy the newer skill.`);
    else log(`Up to date with ${upstream} (${latest}).`);
  }
}

function cmdValidate(a: Args): void {
  const file = a.positional[1];
  if (!file) fail("Usage: readiness validate <file> [--kind audit|report|roadmap]");
  const data = readJson<Record<string, unknown>>(resolve(file));
  const schema = String(data.schema ?? "");
  const kind = (opt(a, "kind") ?? (schema.includes("report") ? "report" : schema.includes("roadmap") ? "roadmap" : "audit")) as "audit" | "report" | "roadmap";
  const errors = validateAgainst(kind, data);
  if (errors.length) fail(`${file} is not a valid ${kind}:\n- ${errors.join("\n- ")}`);
  log(`${file} is a valid ${kind}.`);
}

async function cmdAudit(a: Args): Promise<void> {
  cmdInit(a);
  cmdScan(a);
  if (loadDraft(repoOf(a)).audit.tier === "read-only") log("Read-only tier: scanned only. No repo code ran, so the report gives no level; a local-exec audit can prove one.");
  else await cmdReplay(a);
  if (opt(a, "outcomes-input") || (opt(a, "tier") === "external-systems" && !a.flags["no-outcomes"])) {
    cmdOutcomes({ positional: a.positional, flags: { ...a.flags, ...(opt(a, "outcomes-input") ? { input: str(a, "outcomes-input") } : {}) } });
  }
  if (opt(a, "narration")) cmdNarrate({ positional: a.positional, flags: { ...a.flags, file: str(a, "narration") } });
  cmdSeal(a);
}

const HELP = `readiness <command> [options]

Audit
  init --tier <read-only|local-exec|external-systems> [--scenario first_pr,bug_fixes,features,repo_wide] [--registry-env A,B] [--force]
  scan [--strict] [--budget-scan M]   profile, agent assets, static checks and the verification contract; --strict exits 1 on wrong instructions or blocking safety findings; past M minutes (default ${SCAN_BOUND_MINUTES}) the secret scan and asset history are sampled
  contract [list|add --kind K --component C --cmd "..." --reason "..." [--cwd D] [--source file:line]]
  scenario [list|add <id> [--components a,b]|remove <id>]   optional breakdowns reported under the components they name
  replay [--component C] [--no-mutants] [--runtime auto|docker|podman|none] [--image ref] [--budget-component M] [--budget-total M]
  run [--component C] [--id cmd-id] [--instructions] [--cmd "..." --kind K --component C --reason "..."]
  record --check ID --result pass|fail|not_run --summary "..." [--component C] [--strength static|asserted]
  outcomes [--input prs.json] [--window-days 30] [--branch-prefix a,b] [--label L] [--author A] [--co-author T]
  narrate [--file narration.json] [--headline "..."] [--ask "..."] [--gap id=text] [--title id=text]
  status [--json]
  seal
  audit --tier T [--scenario S] [--outcomes-input f] [--narration f] [--budget-scan M] [--budget-total M]   init, scan, replay, outcomes and seal in one go

After an audit
  verify-seal [audit-id|latest] [--release-repo owner/repo --release-ref tag --tier external-systems] [--allow-eval] [--allow-unkeyed]   with SA_READINESS_SEAL_KEY set, only keyed seals pass unless --allow-unkeyed
  recheck [--runtime auto|docker|podman|none] [--image ref]
  diff [from] [to] [--json]
  history [--json] | history push [--push] [--remote origin]
  roadmap [show|owner "<team>"|targets --merge-rate R --first-pass R --max-changes-requested R [--min-prs N]]   --min-prs defaults to 20 and never goes below 10
  draft-skill --remediate [--out .cursor/skills/verify/SKILL.md] [--include cmd-id,...] [--force]
  draft-env --remediate [--service postgres,redis] [--dockerfile] [--force]
  assets [--org owner --tier external-systems]
  feedback <check-id> --note "..." [--component C]
  version [--upstream owner/repo --tier external-systems]
  validate <file> [--kind audit|report|roadmap]
`;

function logInvocation(argv: string[], code: number): void {
  try {
    const repo = resolveRepo(process.cwd());
    const p = paths(repo);
    if (!exists(p.records)) return;
    appendFileSync(join(p.records, "cli.log"), JSON.stringify({ at: nowIso(), argv: argv.map((x) => redact(x)), code }) + "\n");
  } catch {
    return;
  }
}

async function main(): Promise<void> {
  const a = parse(process.argv.slice(2));
  const cmd = a.positional[0];
  if (!cmd || a.flags.help || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  const table: Record<string, (a: Args) => void | Promise<void>> = {
    init: cmdInit,
    scan: cmdScan,
    contract: cmdContract,
    scenario: cmdScenario,
    run: cmdRun,
    replay: cmdReplay,
    record: cmdRecord,
    outcomes: cmdOutcomes,
    narrate: cmdNarrate,
    status: cmdStatus,
    seal: cmdSeal,
    "verify-seal": cmdVerify,
    recheck: cmdRecheck,
    diff: cmdDiff,
    history: cmdHistory,
    roadmap: cmdRoadmap,
    "draft-skill": cmdDraftSkill,
    "draft-env": cmdDraftEnv,
    assets: cmdAssets,
    feedback: cmdFeedback,
    version: cmdVersion,
    validate: cmdValidate,
    audit: cmdAudit,
  };
  const fn = table[cmd];
  if (!fn) fail(`Unknown command ${cmd}. Run \`readiness help\`.`);
  await fn(a);
}

main()
  .catch((e: Error & { exitCode?: number }) => {
    process.stderr.write(`readiness: ${e.message}\n`);
    process.exitCode = e.exitCode ?? 1;
  })
  .finally(() => logInvocation(process.argv.slice(2), Number(process.exitCode ?? 0)));