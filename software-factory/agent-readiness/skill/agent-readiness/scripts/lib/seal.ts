import { createHmac } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { refreshAssetStatus } from "./assets.ts";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { weakening, weakeningText } from "./diff.ts";
import { ghJson } from "./gh.ts";
import { HISTORY_BRANCH, appendHistory, loadSealedAudit, readHistory, readRoadmap, readSealedFile, storeAudit, storeRecheck, writeLatest, writeRoadmap } from "./history.ts";
import type { LevelResult } from "./levels.ts";
import { activeComponents, capAt, componentLevel, level3Run, outcomeLevel, partialCoverage, previousAtLevel3, recheckStates, repoLevel, scenariosFor, statesOf } from "./levels.ts";
import { emptyStats } from "./outcomes.ts";
import { makeExecutor, newBudget, registryValuesOf, revealMutants, runContract } from "./replay.ts";
import { allowedNumbers, buildReport, danglingEvidence, renderMarkdown, validatePart1 } from "./render.ts";
import { renderHtml } from "./render-html.ts";
import { updateRoadmap } from "./roadmap.ts";
import type { Rubric } from "./rubric.ts";
import { loadRubric } from "./rubric.ts";
import { validateAgainst } from "./schema.ts";
import type { CompStates } from "./score.ts";
import { componentStates, noRealResults } from "./score.ts";
import type { Audit, CondId, CondState, HistoryLine, Level, OutcomeStats, ReportJson, Roadmap, ScenarioId, Targets } from "./types.ts";
import { SUPPORTED_DOC } from "./support.ts";
import { SKILL_ROOT, exists, fail, fmtShortDate, gitOrThrow, nowIso, randomHex, readText, sha256, stableStringify, today } from "./util.ts";
import type { LocalInfo, Paths } from "./workspace.ts";
import { clearCurrent, exportTree, realSeed, releaseManifest, skillDigest } from "./workspace.ts";

// An unkeyed digest only shows the audit wasn't edited by accident: anyone with the scripts can
// recompute it. With SA_READINESS_SEAL_KEY, a CI secret, the digest is an HMAC only the key's
// holder can produce.
export function sealKey(): string | null {
  return process.env.SA_READINESS_SEAL_KEY || null;
}

export function auditDigest(audit: Audit, key: string | null = null): string {
  const copy = JSON.parse(JSON.stringify(audit)) as Audit;
  if (copy.sealed) copy.sealed.digest = "";
  const text = stableStringify(copy);
  return key ? createHmac("sha256", key).update(text).digest("hex") : sha256(text);
}

export function sealStatusFor(scriptsDigest: string, keyed = Boolean(sealKey())): string {
  const m = releaseManifest();
  const seal = keyed ? "the seal is keyed" : "the seal is an unkeyed digest, which shows edits but not who sealed it";
  if (!m) return `Seal not verified: no release manifest ships with this copy; ${seal}`;
  if (m.scriptsDigest === scriptsDigest) return `Scripts match the ${m.tag} manifest bundled with this copy; the published release isn't checked here, and ${seal}`;
  return `Seal not verified: the scripts differ from release ${m.tag}; ${seal}`;
}

export interface ComponentResult {
  level: Level;
  couldBe: Level | null;
  outcomeReasons: string[];
}

export interface Computed {
  states: Map<string, CompStates>;
  // Tier 2: each assessed component's standard level, with Levels 3 and 4 from its agent PRs.
  levels: Map<string, ComponentResult>;
  // Tier 3: only the scenarios a user added, under the components they apply to.
  scenarioLevels: Map<string, Map<ScenarioId, LevelResult>>;
  // Tier 1: the repo rollup over the active components.
  repo: { level: Level; couldBe: Level | null; setBy: string[]; outcomeReasons: string[] };
  active: Set<string>;
}

export function compute(audit: Audit, rubric: Rubric, history: HistoryLine[], targets: Targets | null = null): Computed {
  const comps = audit.profile!.components.filter((c) => c.assessed);
  const states = new Map<string, CompStates>();
  for (const c of comps) states.set(c.id, componentStates(audit, rubric, c.id));
  const levels = new Map<string, ComponentResult>();
  const scenarioLevels = new Map<string, Map<ScenarioId, LevelResult>>();
  const o = audit.outcomes;
  const run = { production: !audit.seed.pinned && o?.source !== "file", from: o?.window.from, minOpened: rubric.level3.absoluteMinAgentPRs };
  for (const c of comps) {
    const s = statesOf(states.get(c.id)!);
    const proven = componentLevel(rubric, s);
    const measured = outcomeLevel(rubric, { level2: proven.level === 2, targets, outcomes: o ? { agent: o.byComponent[c.id] ?? emptyStats(), control: o.control, truncated: o.truncated, windowDays: o.window.days } : null, previousAtLevel3: previousAtLevel3(history, c.id), level3Run: level3Run(history, c.id, run) });
    levels.set(c.id, { level: measured.level ?? proven.level, couldBe: measured.level ? null : proven.couldBe, outcomeReasons: measured.reasons });
    const m = new Map<ScenarioId, LevelResult>();
    for (const id of scenariosFor(rubric, audit.scenarios ?? [], c.id)) m.set(id, componentLevel(rubric, s, id));
    scenarioLevels.set(c.id, m);
  }
  const active = activeComponents(rubric, audit.profile!.components, history);
  const r = repoLevel(new Map([...levels.entries()].map(([id, l]) => [id, { level: l.level, couldBe: l.couldBe, missing: [], unknown: [] }])), active);
  const outcomeReasons = [...new Set(r.setBy.flatMap((id) => levels.get(id)?.outcomeReasons ?? []))];
  return { states, levels, scenarioLevels, repo: { ...r, outcomeReasons }, active };
}

export interface SealResult {
  report: ReportJson;
  markdown: string;
  dir: string;
}

export interface SealedReport {
  report: ReportJson;
  roadmap: Roadmap;
  line: HistoryLine;
}

// references/supported.md relative to the repo root, or null when the skill runs from elsewhere.
export function supportDocIn(repo: string): string | null {
  const rel = relative(realpathSync(repo), realpathSync(join(SKILL_ROOT, SUPPORTED_DOC)));
  return rel.startsWith("..") || isAbsolute(rel) ? null : rel.split(sep).join("/");
}

export function buildSealedReport(audit: Audit, rubric: Rubric, history: HistoryLine[], prevRoadmap: Roadmap | null, repo: string, storedAt: string, previousReport: ReportJson | null = null): SealedReport {
  if (!audit.profile) fail("Run `readiness scan` before sealing.");
  refreshAssetStatus(audit.assets, audit.instructions);
  const c = compute(audit, rubric, history, prevRoadmap?.targets ?? null);
  const noResults = noRealResults(audit, c.states);
  // With no real results there is nothing to plan fixes from; only the decisions stay open.
  const rm = updateRoadmap(prevRoadmap, { audit, rubric, components: audit.profile.components, states: c.states, active: c.active, outcomes: audit.outcomes, decisionsOnly: Boolean(noResults) });
  const prevAuditLine = [...history].reverse().find((h) => h.kind === "audit");
  let weak: string | null = null;
  let previousOutcomes: { window: string; agent: OutcomeStats } | null = null;
  if (prevAuditLine) weak = weakeningText(weakening(repo, prevAuditLine.commit, audit.repo.commit));
  const prevWithOutcomes = [...history].reverse().find((h) => h.kind === "audit" && h.outcomes);
  if (prevWithOutcomes?.outcomes && audit.outcomes) {
    const [from, to] = prevWithOutcomes.outcomes.window.split(" to ");
    previousOutcomes = { window: `${fmtShortDate(from)} to ${fmtShortDate(to)}, ${to.slice(0, 4)}`, agent: prevWithOutcomes.outcomes.agent };
  }
  const o = audit.outcomes;
  const line: HistoryLine = {
    id: audit.id,
    kind: "audit",
    date: today(),
    commit: audit.repo.commit,
    rubric: audit.rubric,
    scriptsDigest: audit.skill.scriptsDigest,
    result: "sealed",
    note: noResults ? `no level: ${noResults}` : undefined,
    levels: Object.fromEntries([...c.levels.entries()].map(([id, l]) => [id, l.level])),
    repoLevel: c.repo.level,
    scenarioLevels: Object.fromEntries([...c.scenarioLevels.entries()].filter(([, m]) => m.size).map(([id, m]) => [id, Object.fromEntries([...m.entries()].map(([k, v]) => [k, v.level]))])),
    ...(noResults ? { noLevel: true } : {}),
    shares: Object.fromEntries(audit.profile.components.map((x) => [x.id, x.changeShare])),
    active: [...c.active],
    outcomes: o ? { window: `${o.window.from} to ${o.window.to}`, agent: o.agent, control: o.control, byComponent: o.byComponent, source: o.source } : null,
    seedPinned: audit.seed.pinned,
  };
  const report = buildReport({
    audit,
    rubric,
    components: audit.profile.components,
    states: c.states,
    levels: c.levels,
    scenarioLevels: c.scenarioLevels,
    rollup: c.repo,
    active: c.active,
    roadmap: rm.roadmap,
    top: rm.top,
    startNow: rm.startNow,
    history,
    currentLine: line,
    previousOutcomes,
    weakening: weak,
    sealStatus: sealStatusFor(audit.skill.scriptsDigest),
    staleCopy: null,
    storedAt,
    partial: partialCoverage(rubric, audit.profile.components),
    noResults,
    supportDoc: supportDocIn(repo),
    previousReport,
  });
  return { report, roadmap: rm.roadmap, line };
}

// A last pass before sealing: every contract command, evidence item and narration key must name
// something the scan and the report know, so nothing an agent added is silently dropped.
export function consistencyErrors(audit: Audit, report: ReportJson, roadmap: Roadmap): string[] {
  const comps = audit.profile?.components ?? [];
  const known = new Set(comps.map((c) => c.id));
  const assessed = new Set(comps.filter((c) => c.assessed).map((c) => c.id));
  const errors: string[] = [];
  for (const c of audit.contract) {
    if (c.component !== "*" && !assessed.has(c.component)) errors.push(`contract command ${c.id} names ${c.component}, which ${known.has(c.component) ? "isn't assessed" : "the scan didn't find"}; remove it or rescan`);
  }
  for (const e of audit.evidence) {
    if (e.component && e.component !== "*" && !known.has(e.component)) errors.push(`evidence ${e.id} names ${e.component}, which the scan didn't find`);
  }
  for (const s of audit.scenarios ?? []) {
    for (const id of s.components.filter((x) => x !== "*" && !assessed.has(x))) errors.push(`the ${s.id} scenario names ${id}, which ${known.has(id) ? "isn't assessed" : "the scan didn't find"}; remove it with \`readiness scenario remove ${s.id}\` and add it again`);
  }
  const gaps = report.executive.gaps.map((g) => g.itemId);
  const items = roadmap.items.map((i) => i.id);
  for (const k of Object.keys(audit.narration?.gaps ?? {})) {
    if (!gaps.includes(k)) errors.push(`the narration rewrites gap ${k}, which isn't in part 1 (part 1 gaps: ${gaps.join(", ") || "none"}); run \`readiness status\` for the ids`);
  }
  for (const k of Object.keys(audit.narration?.titles ?? {})) {
    if (!items.includes(k)) errors.push(`the narration retitles ${k}, which isn't a roadmap item (items: ${items.join(", ") || "none"})`);
  }
  return errors;
}

// Earlier audit lines feed the active set and the Level 4 run, so only lines that match their
// sealed audit count. Recheck lines carry no seal and can only lower a level.
export function trustedHistory(p: Paths, history: HistoryLine[], log: (s: string) => void = () => {}): HistoryLine[] {
  const key = sealKey();
  const dropped: string[] = [];
  const kept = history.filter((h) => {
    if (h.kind !== "audit") return true;
    try {
      const { audit } = loadSealedAudit(p, h.id);
      const s = audit.sealed;
      // The same rule as verify-seal: with a key, only keyed seals that verify with it. Without
      // one, an unkeyed seal must match; a keyed one can't be checked here and is kept.
      const sealOk = Boolean(s) && (key ? s!.keyed === true && auditDigest(audit, key) === s!.digest : s!.keyed === true || auditDigest(audit, null) === s!.digest);
      const lineOk = !s?.historyLineDigest || sha256(stableStringify(h)) === s.historyLineDigest;
      if (sealOk && lineOk) return true;
    } catch {
      // No sealed audit for this line.
    }
    dropped.push(h.id);
    return false;
  });
  if (dropped.length) log(`Left out ${dropped.length} history ${dropped.length === 1 ? "line" : "lines"} that don't match a sealed audit: ${dropped.join(", ")}.`);
  return kept;
}

// The last audit's sealed report.json, only when it still matches that audit's seal, so "what
// changed" is never read from an edited file. Null on a first audit or when it can't be read.
export function previousSealedReport(p: Paths, history: HistoryLine[]): ReportJson | null {
  const prev = [...history].reverse().find((h) => h.kind === "audit");
  if (!prev) return null;
  try {
    const { audit, dir } = loadSealedAudit(p, prev.id);
    const text = readSealedFile(p, dir, "report.json") ?? readSealedFile(p, `${HISTORY_BRANCH}:audits/${prev.id}`, "report.json");
    if (!text || !audit.sealed || sha256(text) !== audit.sealed.reportJsonDigest) return null;
    return JSON.parse(text) as ReportJson;
  } catch {
    return null;
  }
}

export function seal(audit: Audit, local: LocalInfo, p: Paths, log: (s: string) => void): SealResult {
  if (audit.state !== "draft") fail(`Audit ${audit.id} is already sealed.`);
  if (!audit.profile) fail("Run `readiness scan` before sealing.");
  const rubric = loadRubric(audit.rubric);
  if (audit.skill.scriptsDigest !== skillDigest()) fail("The skill's scripts changed since this audit started. Start a new audit with `readiness init --force`.");
  revealMutants(audit, local.tree);
  audit.seed.value = realSeed(audit, local);
  const storedAt = join(p.history, "audits", audit.id).replace(p.repo + "/", "");
  const history = trustedHistory(p, readHistory(p), log);
  const { report, roadmap, line } = buildSealedReport(audit, rubric, history, readRoadmap(p), p.repo, storedAt, previousSealedReport(p, history));
  const errors = [
    ...consistencyErrors(audit, report, roadmap),
    ...danglingEvidence(report, audit).map((id) => `the report cites ${id}, which isn't in the audit`),
    ...validatePart1(report, rubric, audit.narration ? allowedNumbers(report) : null),
    ...validateAgainst("report", report).map((e) => `report.json ${e}`),
    ...validateAgainst("roadmap", roadmap).map((e) => `roadmap.json ${e}`),
  ];
  if (errors.length) fail(`Seal refused. Fix these and seal again:\n- ${errors.join("\n- ")}`);
  const md = renderMarkdown(report, rubric);
  const html = renderHtml(report);
  audit.state = "sealed";
  const key = sealKey();
  audit.sealed = { at: nowIso(), digest: "", reportJsonDigest: sha256(JSON.stringify(report, null, 2) + "\n"), reportMdDigest: sha256(md), reportHtmlDigest: sha256(html), roadmapItemsDigest: sha256(stableStringify(roadmap.items)), historyLineDigest: sha256(stableStringify(line)), keyed: Boolean(key) };
  audit.sealed.digest = auditDigest(audit, key);
  const auditErrors = validateAgainst("audit", audit);
  if (auditErrors.length) fail(`Internal error: the sealed audit doesn't match its schema:\n- ${auditErrors.join("\n- ")}`);
  const dir = storeAudit(p, audit, report, md, html);
  writeLatest(p, report, md, html);
  writeRoadmap(p, roadmap);
  appendHistory(p, line);
  clearCurrent(p);
  rmSync(join(p.work, audit.id), { recursive: true, force: true });
  rmSync(join(local.tree, ".."), { recursive: true, force: true });
  log(`Sealed ${audit.id}: ${report.executive.heading}.`);
  return { report, markdown: md, dir };
}

export interface VerifyResult {
  ok: boolean;
  production: boolean;
  lines: string[];
}

export function verifySeal(p: Paths, ref: string, opts: { releaseRepo?: string; releaseRef?: string; tierExternal: boolean; allowUnkeyed?: boolean }): VerifyResult {
  const { audit, dir } = loadSealedAudit(p, ref);
  const lines: string[] = [];
  let ok = true;
  if (audit.state !== "sealed" || !audit.sealed) return { ok: false, production: false, lines: [`${audit.id} isn't sealed`] };
  const key = sealKey();
  // The audit file never chooses how it is checked: with a key configured, only a keyed seal counts.
  if (key && !audit.sealed.keyed && !opts.allowUnkeyed) {
    ok = false;
    lines.push(`FAIL: SA_READINESS_SEAL_KEY is set, so ${audit.id}'s unkeyed seal isn't accepted. Seal audits where the key is set, such as CI, or pass --allow-unkeyed while audits are still sealed elsewhere.`);
  } else if (key && !audit.sealed.keyed) {
    if (auditDigest(audit, null) !== audit.sealed.digest) {
      ok = false;
      lines.push(`FAIL: ${audit.id} was edited after sealing (digest mismatch).`);
    } else lines.push(`OK: ${audit.id} digest matches; accepted unkeyed because of --allow-unkeyed.`);
  } else if (audit.sealed.keyed && !key) {
    ok = false;
    lines.push(`FAIL: ${audit.id} has a keyed seal; set SA_READINESS_SEAL_KEY to the key it was sealed with to verify it.`);
  } else if (auditDigest(audit, audit.sealed.keyed ? key : null) !== audit.sealed.digest) {
    ok = false;
    lines.push(`FAIL: ${audit.id} was edited after sealing (digest mismatch${audit.sealed.keyed ? ", or the wrong key" : ""}).`);
  } else lines.push(`OK: ${audit.id} ${audit.sealed.keyed ? "keyed seal" : "digest"} matches.`);
  if (!audit.sealed.keyed) lines.push("NOTE: the seal is an unkeyed digest: it catches edits, but anyone with the scripts could reseal an edited audit. Set SA_READINESS_SEAL_KEY from a CI secret to key seals.");
  const rjText = readSealedFile(p, dir, "report.json");
  const mdText = readSealedFile(p, dir, "report.md");
  if (rjText === null || mdText === null) {
    ok = false;
    lines.push(`FAIL: ${rjText === null ? "report.json" : "report.md"} is missing from the sealed audit.`);
  } else if (sha256(rjText) !== audit.sealed.reportJsonDigest || sha256(mdText) !== audit.sealed.reportMdDigest) {
    ok = false;
    lines.push("FAIL: report.json or report.md was edited after sealing.");
  } else if (audit.sealed.reportHtmlDigest && sha256(readSealedFile(p, dir, "report.html") ?? "") !== audit.sealed.reportHtmlDigest) {
    ok = false;
    lines.push("FAIL: report.html is missing from the sealed audit or was edited after sealing.");
  } else lines.push("OK: report files match the seal.");
  const history = readHistory(p);
  const ownLine = history.find((h) => h.id === audit.id);
  if (!ownLine) {
    ok = false;
    lines.push(`FAIL: history.jsonl has no line for ${audit.id}.`);
  } else if (audit.sealed.historyLineDigest && sha256(stableStringify(ownLine)) !== audit.sealed.historyLineDigest) {
    ok = false;
    lines.push(`FAIL: ${audit.id}'s line in history.jsonl was edited after sealing.`);
  }
  const latestLine = [...history].reverse().find((h) => h.kind === "audit");
  if (latestLine?.id === audit.id) {
    const lj = join(p.latest, "report.json");
    const lm = join(p.latest, "report.md");
    if (!exists(lj) || !exists(lm)) {
      ok = false;
      lines.push("FAIL: .agent-readiness/latest/ is missing report.json or report.md.");
    } else if (sha256(readText(lj)) !== audit.sealed.reportJsonDigest || sha256(readText(lm)) !== audit.sealed.reportMdDigest) {
      ok = false;
      lines.push("FAIL: .agent-readiness/latest/ was edited after sealing.");
    } else if (audit.sealed.reportHtmlDigest && (!exists(join(p.latest, "report.html")) || sha256(readText(join(p.latest, "report.html"))) !== audit.sealed.reportHtmlDigest)) {
      ok = false;
      lines.push("FAIL: .agent-readiness/latest/report.html is missing or was edited after sealing.");
    }
    if (audit.sealed.roadmapItemsDigest && !exists(p.roadmap)) {
      ok = false;
      lines.push("FAIL: .agent-readiness/roadmap.json is missing; the latest audit sealed one.");
    } else if (audit.sealed.roadmapItemsDigest) {
      const rm = JSON.parse(readText(p.roadmap)) as { items: unknown };
      if (sha256(stableStringify(rm.items)) !== audit.sealed.roadmapItemsDigest) {
        ok = false;
        lines.push("FAIL: the roadmap's items were edited after sealing. Only an audit changes them; `readiness roadmap owner` and `targets` are the supported edits.");
      }
    }
  }
  const local = skillDigest();
  lines.push(local === audit.skill.scriptsDigest ? "OK: the local skill scripts match the ones that ran the audit." : "WARN: the local skill scripts differ from the ones that ran the audit.");
  const m = releaseManifest();
  if (opts.releaseRepo && opts.tierExternal) {
    const refName = opts.releaseRef ?? m?.tag ?? "main";
    try {
      const remote = ghJson<{ content: string }>(["api", `repos/${opts.releaseRepo}/contents/software-factory/agent-readiness/skill/agent-readiness/RELEASE.json?ref=${refName}`]);
      const manifest = JSON.parse(Buffer.from(remote.content, "base64").toString("utf8")) as { scriptsDigest: string; tag: string };
      if (manifest.scriptsDigest === audit.skill.scriptsDigest) lines.push(`OK: scripts match the published release ${manifest.tag} in ${opts.releaseRepo}.`);
      else {
        ok = false;
        lines.push(`FAIL: scripts don't match the published release ${manifest.tag} in ${opts.releaseRepo}.`);
      }
    } catch (e) {
      ok = false;
      lines.push(`FAIL: couldn't read the release manifest from ${opts.releaseRepo}: ${(e as Error).message}`);
    }
  } else if (m) {
    if (m.scriptsDigest === audit.skill.scriptsDigest) lines.push(`OK: scripts match the bundled release manifest ${m.tag} (pass --release-repo in the external-systems tier to check the published one).`);
    else {
      ok = false;
      lines.push(`FAIL: the scripts that ran this audit don't match the release manifest ${m.tag}; they were edited.`);
    }
  }
  if (audit.seed.pinned) lines.push("NOTE: this audit pinned its planted-fault seed (eval run), so it isn't a production result.");
  // Anyone can write a PR file, so outcomes read from one never stand as a production level.
  if (audit.outcomes?.source === "file") lines.push("NOTE: this audit's outcomes came from a recorded PR file, not GitHub, so it isn't a production result.");
  const production = !audit.seed.pinned && audit.outcomes?.source !== "file";
  return { ok, production, lines };
}

export interface RecheckOptions {
  runtime: string;
  image?: string;
  log: (s: string) => void;
}

export async function recheck(p: Paths, opts: RecheckOptions): Promise<{ line: HistoryLine; record: unknown }> {
  const { audit } = loadSealedAudit(p, "latest");
  const rubric = loadRubric(audit.rubric);
  const history = readHistory(p);
  const commit = gitOrThrow(["rev-parse", "HEAD"], p.repo).trim();
  const root = mkdtempSync(join(tmpdir(), "readiness-recheck-"));
  const copy = join(root, "work");
  exportTree(p.repo, commit, copy);
  const work: Audit = JSON.parse(JSON.stringify(audit)) as Audit;
  const ex = makeExecutor(work, copy, opts.runtime, opts.log, opts.image ?? audit.environment.imageOverride);
  const comps = new Set(audit.profile!.components.filter((c) => c.assessed).map((c) => c.id));
  let results;
  try {
    results = await runContract(ex, audit.contract, { components: comps, budget: newBudget(rubric.budgets.componentMinutes, rubric.budgets.totalMinutes), registryValues: registryValuesOf(audit), onResult: (r) => opts.log(`  ${r.cmd.kind.padEnd(9)} ${r.cmd.component.padEnd(12)} ${r.blocked ? "blocked" : r.status}`) });
  } finally {
    ex.close();
    rmSync(root, { recursive: true, force: true });
  }
  // A limit of this machine is never a regression, and a rerun outside a clean container can't
  // carry the last audit's levels onto a new commit.
  // Only a command that ran and failed lowers a level; one cut off or skipped proves nothing. On the
  // host nothing is recorded as a level at all, whatever passed.
  const failed = results.filter((r) => r.status === "fail" && !r.blocked);
  const onHost = ex.where !== "container";
  const cutOff = results.find((r) => r.status === "not_run" && !r.blocked);
  const blockedBy = onHost ? "no container runtime on this machine" : (results.find((r) => r.blocked)?.blocked ?? (cutOff ? `${cutOff.cmd.command} ${cutOff.note || "didn't run"}` : undefined));
  const unproven = onHost || (failed.length === 0 && Boolean(blockedBy));
  const lastLine = [...history].reverse().find((h) => h.id === audit.id);
  const levels: HistoryLine["levels"] = {};
  const scenarioLevels: HistoryLine["scenarioLevels"] = {};
  const base = compute(audit, rubric, history.filter((h) => h.id !== audit.id));
  // A recheck can lower a level or restore it, never raise it past the last audit's.
  for (const comp of comps) {
    const kinds = new Set(failed.filter((r) => r.cmd.component === comp || r.cmd.component === "*").map((r) => r.cmd.kind as string));
    const s = recheckStates(statesOf(base.states.get(comp)!) as Partial<Record<CondId, CondState>>, kinds);
    const last = (lastLine?.levels[comp] ?? base.levels.get(comp)?.level ?? 0) as Level;
    levels[comp] = kinds.size ? capAt(componentLevel(rubric, s).level, last) : last;
    for (const sid of scenariosFor(rubric, audit.scenarios ?? [], comp)) {
      const lastScenario = (lastLine?.scenarioLevels?.[comp]?.[sid] ?? componentLevel(rubric, s, sid).level) as Level;
      (scenarioLevels[comp] ??= {})[sid] = capAt(componentLevel(rubric, s, sid).level, lastScenario);
    }
  }
  const active = new Set(lastLine?.active ?? [...comps]);
  const vals = [...active].map((id) => levels[id] ?? 0);
  const repoLevelNow = (vals.length ? Math.min(...vals) : 0) as Level;
  const id = `rck-${today()}-${audit.seed.pinned ? sha256(`${audit.id}:${nowIso()}`).slice(0, 4) : randomHex(2)}`;
  const firstFail = failed[0];
  const line: HistoryLine = {
    id,
    kind: "recheck",
    date: today(),
    commit,
    rubric: audit.rubric,
    scriptsDigest: skillDigest(),
    result: failed.length ? "failed" : unproven ? "blocked" : "passed",
    note: firstFail ? `${firstFail.cmd.command} ${firstFail.status === "not_run" ? "not run" : "failed"}${firstFail.diagnosis ? `: ${firstFail.diagnosis.detail}` : ""}` : unproven ? `no level: the last audit's levels couldn't be proved here (${blockedBy})` : undefined,
    levels,
    repoLevel: repoLevelNow,
    ...(unproven ? { noLevel: true } : {}),
    scenarioLevels,
    shares: lastLine?.shares ?? {},
    active: [...active],
    outcomes: null,
    seedPinned: audit.seed.pinned,
  };
  const record = { schema: "agent-readiness/recheck@1", id, from: audit.id, at: nowIso(), commit, environment: work.environment, results: results.map((r) => ({ id: r.cmd.id, kind: r.cmd.kind, component: r.cmd.component, status: r.status, exitCode: r.outcome?.exitCode ?? null, diagnosis: r.diagnosis, note: r.note })) };
  storeRecheck(p, id, record);
  appendHistory(p, line);
  return { line, record };
}
