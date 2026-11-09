import { componentLevel } from "./levels.ts";
import { describeRate, rate, windowLabel } from "./outcomes.ts";
import type { Rubric, RubricTemplate } from "./rubric.ts";
import type { CompStates } from "./score.ts";
import { commandsFor } from "./score.ts";
import type { Audit, CondId, CondState, Component, Effort, Fix, Level, OutcomeStats, OutcomesSnapshot, Roadmap, RoadmapItem, Watch } from "./types.ts";
import { fill, nowIso } from "./util.ts";
import { serviceLabel } from "./diagnose.ts";

type StateMap = Partial<Record<CondId, CondState>>;

export interface RoadmapContext {
  audit: Audit;
  rubric: Rubric;
  components: Component[];
  states: Map<string, CompStates>;
  active: Set<string>;
  outcomes: OutcomesSnapshot | null;
  // With no real results, fixes can't be planned; the decisions still stand.
  decisionsOnly?: boolean;
}

interface Candidate {
  id: string;
  template: string;
  kind: RoadmapItem["kind"];
  component: string;
  fixes: Fix[];
  vars: Record<string, string | number>;
  evidence: string[];
  title?: string;
}

const EFFORT_ORDER: Record<Effort, number> = { small: 0, medium: 1, large: 2 };
const LOCK_FOR: Record<string, string> = { npm: "package-lock.json", yarn: "yarn.lock", pnpm: "pnpm-lock.yaml" };

function stateMaps(ctx: RoadmapContext): Map<string, StateMap> {
  const out = new Map<string, StateMap>();
  for (const [id, detail] of ctx.states) {
    const m: StateMap = {};
    for (const [k, v] of Object.entries(detail)) m[k as CondId] = v.state;
    out.set(id, m);
  }
  return out;
}

function standardLevels(rubric: Rubric, maps: Map<string, StateMap>): Map<string, Level> {
  const out = new Map<string, Level>();
  for (const [id, m] of maps) out.set(id, componentLevel(rubric, m).level);
  return out;
}

function neededConds(rubric: Rubric, level: Level): CondId[] {
  if (level === 0) return rubric.level1;
  if (level === 1) return rubric.level2;
  return [];
}

function latestEvidence(audit: Audit, pred: (e: Audit["evidence"][number]) => boolean) {
  const hits = audit.evidence.filter(pred);
  return hits[hits.length - 1];
}

export function candidates(ctx: RoadmapContext): Candidate[] {
  const { audit, rubric } = ctx;
  const out: Candidate[] = [];
  const assessed = ctx.components.filter((c) => c.assessed);
  const goalNeedsFaults = rubric.level2.includes("faults");
  const anyRepo = assessed[0] ? ctx.states.get(assessed[0].id) : undefined;
  const credentialComps: string[] = [];
  if (assessed.some((c) => ctx.states.get(c.id)?.["clean.install"].state === "not_met")) {
    const ev = latestEvidence(audit, (e) => e.kind === "install" && e.result === "fail") ?? latestEvidence(audit, (e) => e.kind === "install");
    out.push({ id: "clean.install:repo", template: "clean.install", kind: "fix", component: "*", fixes: assessed.map((c) => ({ condition: "clean.install" as CondId, component: c.id })), vars: { component: "the repo", diagnosis: ev?.diagnosis?.detail ?? ev?.summary ?? "the install failed" }, evidence: ev ? [ev.id] : [] });
  }
  // A component's commands include the repo-wide ones, and a replay result outranks a host run.
  const replayed = (e: { where: string }) => e.where === "container" || e.where === "fresh_copy";
  const resultOf = (contractId: string) => latestEvidence(audit, (e) => e.contractId === contractId && replayed(e)) ?? latestEvidence(audit, (e) => e.contractId === contractId);
  // A failing repo-wide lint, type-check or build is one fix for the repo, not one per component,
  // for the components it stands in for: those with no command of that kind of their own.
  const repoWide = audit.contract.filter((k) => k.component === "*" && ["build", "lint", "typecheck"].includes(k.kind) && resultOf(k.id)?.result === "fail");
  const heldByRepoWide = assessed.filter((c) => ctx.states.get(c.id)?.commands.state === "not_met" && repoWide.some((k) => commandsFor(audit.contract, c.id, k.kind).includes(k)));
  if (repoWide.length && heldByRepoWide.length) {
    const ev = resultOf(repoWide[0].id);
    out.push({ id: "commands:repo", template: "commands", kind: "fix", component: "*", fixes: heldByRepoWide.map((c) => ({ condition: "commands" as CondId, component: c.id })), vars: { component: "the repo", kinds: [...new Set(repoWide.map((k) => k.kind))].join(" and "), diagnosis: ev?.diagnosis?.detail ?? "the command fails" }, evidence: ev ? [ev.id] : [] });
  }
  for (const c of assessed) {
    const s = ctx.states.get(c.id)!;
    const mine = (component: string | undefined) => component === c.id || component === "*";
    if (s["clean.build"].state === "not_met" && s["clean.install"].state !== "not_met") {
      const ev = latestEvidence(audit, (e) => e.kind === "build" && mine(e.component) && e.result === "fail") ?? latestEvidence(audit, (e) => e.kind === "build" && mine(e.component));
      out.push({ id: `clean.build:${c.id}`, template: "clean.build", kind: "fix", component: c.id, fixes: [{ condition: "clean.build", component: c.id }], vars: { component: c.id, diagnosis: ev?.diagnosis?.detail ?? "the build failed" }, evidence: ev ? [ev.id] : [] });
    }
    const failedKinds = ["build", "lint", "typecheck", "test"]
      .flatMap((kind) => commandsFor(audit.contract, c.id, kind))
      .filter((k) => resultOf(k.id)?.result === "fail")
      .map((k) => k.kind);
    if (s["clean.test"].state === "not_met" && s["clean.install"].state !== "not_met") {
      const ev = latestEvidence(audit, (e) => e.kind === "test" && mine(e.component) && e.result === "fail" && replayed(e));
      const d = ev?.diagnosis;
      const missing = commandsFor(audit.contract, c.id, "test").length === 0;
      const template = missing ? "clean.test:missing" : d?.cause === "service" ? "clean.test:service" : d?.cause === "credential" ? "clean.test:credential" : "clean.test";
      const fixes: Fix[] = [{ condition: "clean.test", component: c.id }];
      if (failedKinds.filter((k) => k !== "test").length === 0) fixes.push({ condition: "commands", component: c.id });
      if (template === "clean.test:credential") credentialComps.push(c.id);
      const port = d?.cause === "service" ? d.detail.match(/port (\d+)/)?.[1] : undefined;
      const service = d?.cause === "service" ? serviceLabel(d, (p) => `the service the tests expect on port ${p}`) : (d?.service ?? "");
      const diagnosis = port ? "the connection was refused" : (d?.detail ?? s["clean.test"].reason);
      out.push({ id: `clean.test:${c.id}`, template, kind: "fix", component: c.id, fixes, vars: { component: c.id, service, diagnosis }, evidence: ev ? [ev.id] : s["clean.test"].evidence });
    }
    // Repo-wide lint, type-check and build failures are the commands:repo item above.
    const ownFailed = ["build", "lint", "typecheck", "test"].flatMap((kind) => commandsFor(audit.contract, c.id, kind)).filter((k) => (k.component === c.id || k.kind === "test") && resultOf(k.id)?.result === "fail").map((k) => k.kind);
    const otherKinds = ownFailed.filter((k) => k !== "test" || s["clean.test"].state !== "not_met");
    if (s.commands.state === "not_met" && otherKinds.length > 0) {
      const ev = latestEvidence(audit, (e) => mine(e.component) && e.result === "fail" && e.contractId !== undefined && e.kind !== undefined && otherKinds.includes(e.kind));
      out.push({ id: `commands:${c.id}`, template: "commands", kind: "fix", component: c.id, fixes: [{ condition: "commands", component: c.id }], vars: { component: c.id, kinds: otherKinds.join(" and "), diagnosis: ev?.diagnosis?.detail ?? s.commands.reason }, evidence: ev ? [ev.id] : [] });
    }
    if (goalNeedsFaults && s.faults.state === "not_met") {
      const mine = audit.mutants.filter((m) => m.component === c.id && (m.result === "caught" || m.result === "survived"));
      const files = [...new Set(audit.mutants.filter((m) => m.component === c.id && m.result === "survived").map((m) => m.file))];
      out.push({ id: `faults:${c.id}`, template: "faults", kind: "fix", component: c.id, fixes: [{ condition: "faults", component: c.id }], vars: { component: c.id, planted: mine.length, caught: mine.filter((m) => m.result === "caught").length, files: files.join(", ") || c.path }, evidence: s.faults.evidence });
    }
    if (goalNeedsFaults && s.faults.state === "unknown" && s["clean.test"].state === "not_met") {
      out.push({ id: `faults:${c.id}`, template: "faults", kind: "fix", component: c.id, fixes: [{ condition: "faults", component: c.id }], vars: { component: c.id, planted: 0, caught: 0, files: c.path }, evidence: [], title: `Check ${c.id}'s tests with planted faults` });
    }
  }
  if (anyRepo?.instructions.state === "not_met") {
    const failed = audit.instructions.filter((i) => i.result === "fail");
    const files = [...new Set(failed.map((i) => i.source))];
    const itemList = failed.map((i) => `\`${i.source}:${i.line}\` \`${i.text}\`: ${i.reason ?? i.staticReason ?? "fails"}`).join("; ");
    const diag = failed.slice(0, 2).map((i) => `${i.text} (${i.reason ?? i.staticReason})`).join(", ");
    out.push({ id: "instructions:repo", template: "instructions", kind: "fix", component: "*", fixes: [{ condition: "instructions", component: "*" }], vars: { failedCount: failed.length, fileCount: files.length, diagnosis: diag, itemList }, evidence: failed.map((i) => i.evidenceId).filter((x): x is string => Boolean(x)) });
  }
  if (anyRepo?.safety.state === "not_met") {
    const blocking = audit.safety.filter((s) => s.blocking);
    const secrets = blocking.filter((s) => s.kind === "secret");
    if (secrets.length) out.push({ id: "safety:secret", template: "safety:secret", kind: "fix", component: "*", fixes: [{ condition: "safety", component: "*" }], vars: { count: secrets.length, fileCount: new Set(secrets.map((s) => s.file)).size, types: [...new Set(secrets.map((s) => s.detail))].join(", ") }, evidence: [] });
    const hooks = blocking.filter((s) => s.kind === "network_piped");
    if (hooks.length) out.push({ id: "safety:hook", template: "safety:hook", kind: "fix", component: "*", fixes: [{ condition: "safety", component: "*" }], vars: { detail: hooks.map((h) => `${h.file} ${h.detail}`).join("; ") }, evidence: [] });
    const creds = blocking.filter((s) => s.kind === "credential_needed");
    if (creds.length) {
      const withTestItem = out.filter((x) => x.template === "clean.test:credential");
      if (withTestItem.length) for (const x of withTestItem) x.fixes.push({ condition: "safety", component: "*" });
      else out.push({ id: "safety:credential", template: "safety:credential", kind: "fix", component: "*", fixes: [{ condition: "safety", component: "*" }], vars: { detail: creds.map((c) => c.detail).join("; ") }, evidence: [] });
    }
  }
  if (anyRepo?.toolchain.state === "not_met" && audit.profile) {
    const missing = audit.profile.toolchain.missing;
    const advice = missing.map((m) => (m.includes("Node") ? "add `.nvmrc` with the Node major version" : m.includes("Python") ? "add `.python-version`" : `add \`packageManager\` to package.json for ${m}`)).join("; ");
    out.push({ id: "toolchain:repo", template: "toolchain", kind: "fix", component: "*", fixes: [{ condition: "toolchain", component: "*" }], vars: { missing: missing.join(" and "), advice }, evidence: [] });
  }
  if (anyRepo?.lockfile.state === "not_met" && audit.profile) {
    const pm = audit.profile.packageManager;
    const advice = pm === "pip" ? "pin exact versions in `requirements.txt`, or move to `uv` with a committed `uv.lock`" : `commit the ${pm ?? "package manager"} lockfile and install with a frozen install`;
    out.push({ id: "lockfile:repo", template: "lockfile", kind: "fix", component: "*", fixes: [{ condition: "lockfile", component: "*" }], vars: { diagnosis: anyRepo.lockfile.reason, advice }, evidence: anyRepo.lockfile.evidence });
  }
  return out;
}

function statsFor(o: OutcomesSnapshot | null, scope: string): OutcomeStats | null {
  if (!o) return null;
  return scope === "repo" ? o.agent : o.byComponent[scope] ?? null;
}

export function watchFor(metric: string, scope: string, o: OutcomesSnapshot | null, rubric: Rubric, pattern?: string): Watch {
  const s = statsFor(o, scope);
  if (!o || !s) return { metric, scope, baseline: "not measured (outcomes need the external-systems tier)", n: null, window: null };
  const w = windowLabel(o);
  let r;
  if (metric === "first_time_ci_pass") r = rate(s.firstTimeCiPass, s.firstTimeCiKnown, rubric, w);
  else if (metric === "changes_requested") r = rate(s.changesRequested, s.opened, rubric, w);
  else if (metric === "prs_adding_path") r = rate(s.addingPaths[pattern ?? ""] ?? 0, s.opened, rubric, w);
  else r = rate(s.merged, s.opened, rubric, w);
  return { metric: pattern ? `${metric}:${pattern}` : metric, scope, baseline: describeRate(r), n: r.n, window: w };
}

function expectedFor(c: Candidate, ctx: RoadmapContext): RoadmapItem["expected"] {
  const { rubric, outcomes, audit } = ctx;
  const scope = c.component === "*" ? "repo" : c.component;
  if (c.template.startsWith("clean.") || c.template === "commands") {
    return { outcome: `Agents can run ${scope === "repo" ? "the repo" : scope}'s checks before they push, so fewer agent PRs fail CI the first time.`, watch: watchFor("first_time_ci_pass", scope, outcomes, rubric) };
  }
  if (c.template === "faults") return { outcome: `Changes in ${scope} get a real pass-or-fail signal, so reviewers catch less by hand.`, watch: watchFor("changes_requested", scope, outcomes, rubric) };
  if (c.template === "instructions") {
    const wrongPm = audit.instructions.find((i) => i.result === "fail" && /^uses (npm|pnpm|yarn),/.test(i.reason ?? ""));
    const pm = wrongPm?.reason?.match(/^uses (\w+)/)?.[1];
    if (pm && LOCK_FOR[pm]) return { outcome: `Agents stop following stale steps, such as running ${pm} in a repo that doesn't use it.`, watch: watchFor("prs_adding_path", "repo", outcomes, rubric, LOCK_FOR[pm]) };
    return { outcome: "Agents stop following stale steps.", watch: watchFor("changes_requested", "repo", outcomes, rubric) };
  }
  if (c.template.startsWith("safety")) return { outcome: "Agents can do normal work without production access.", watch: watchFor("first_time_ci_pass", "repo", outcomes, rubric) };
  if (c.template === "toolchain" || c.template === "lockfile") return { outcome: "Agents, CI and laptops build with the same versions.", watch: watchFor("first_time_ci_pass", "repo", outcomes, rubric) };
  if (c.template === "delegate") return { outcome: `The next report has real agent PR numbers for ${scope}, which Level 3 is measured on.`, watch: watchFor("merged", scope, outcomes, rubric) };
  if (c.template === "targets") return { outcome: "Each report shows how far agent PRs are from Level 3.", watch: watchFor("merged", "repo", outcomes, rubric) };
  return { outcome: "Approvals and targets have a named owner.", watch: watchFor("merged", "repo", outcomes, rubric) };
}

function flipFor(item: RoadmapItem, open: RoadmapItem[], maps: Map<string, StateMap>): Map<string, StateMap> {
  const out = new Map<string, StateMap>();
  for (const [id, m] of maps) out.set(id, { ...m });
  for (const f of item.fixes) {
    const others = open.filter((o) => o.id !== item.id && o.fixes.some((x) => x.condition === f.condition && (x.component === f.component || x.component === "*" || f.component === "*")));
    if (others.length > 0) continue;
    for (const [id, m] of out) if (f.component === "*" || f.component === id) m[f.condition] = "met";
  }
  return out;
}

function sharesOf(ctx: RoadmapContext): Map<string, number> {
  return new Map(ctx.components.map((c) => [c.id, c.changeShare]));
}

function unlocksText(before: Map<string, Level>, after: Map<string, Level>, unproven: Set<string> = new Set()): string {
  const rose = [...after.entries()].filter(([id, l]) => l > (before.get(id) ?? 0));
  return rose.map(([id, l]) => `${id} to Level ${l}${unproven.has(id) ? " once Level 1 is proven in a clean container" : ""}`).join(", ");
}

// A component held at Level 0 only by limits of this machine is planned as if Level 1 held, so
// work that doesn't depend on the machine, such as a test gap, can start now.
function planningMaps(rubric: Rubric, maps: Map<string, StateMap>): { maps: Map<string, StateMap>; unproven: Set<string> } {
  const out = new Map<string, StateMap>();
  const unproven = new Set<string>();
  for (const [id, m] of maps) {
    const unmet = rubric.level1.filter((c) => m[c] !== "met");
    if (unmet.length > 0 && unmet.every((c) => m[c] === "blocked")) {
      unproven.add(id);
      out.set(id, { ...m, ...Object.fromEntries(unmet.map((c) => [c, "met"])) });
    } else out.set(id, m);
  }
  return { maps: out, unproven };
}

function fromTemplate(t: RubricTemplate, vars: Record<string, string | number>) {
  return {
    title: fill(t.title, vars),
    why: fill(t.why, vars),
    doneWhen: fill(t.doneWhen, vars),
    size: fill(t.size, vars),
    decision: t.decision ? fill(t.decision, vars) : null,
    steps: t.steps.map((s) => ({ title: fill(s.title, vars), detail: fill(s.detail, vars) })),
  };
}

export interface RoadmapResult {
  roadmap: Roadmap;
  top: RoadmapItem[];
  startNow: RoadmapItem | null;
  levels: Map<string, Level>;
}

export function updateRoadmap(prev: Roadmap | null, ctx: RoadmapContext): RoadmapResult {
  const { rubric, audit } = ctx;
  const date = audit.createdAt.slice(0, 10);
  const roadmap: Roadmap = prev
    ? { ...prev, items: prev.items.map((i) => ({ ...i })), updatedBy: audit.id, updatedAt: nowIso() }
    : { schema: "agent-readiness/roadmap@1", owner: null, targets: null, items: [], updatedBy: audit.id, updatedAt: nowIso() };
  const real = stateMaps(ctx);
  const provenLevels = standardLevels(rubric, real);
  const { maps, unproven } = planningMaps(rubric, real);
  const levels = standardLevels(rubric, maps);
  const cands = ctx.decisionsOnly ? [] : candidates(ctx);
  const decisions: Candidate[] = [];
  decisions.push({ id: "owner", template: "owner", kind: "decision", component: "*", fixes: [], vars: {}, evidence: [] });
  if (!ctx.decisionsOnly) {
    for (const c of ctx.components.filter((x) => ctx.active.has(x.id) && provenLevels.get(x.id) === 2)) {
      decisions.push({ id: `delegate:${c.id}`, template: "delegate", kind: "rollout", component: c.id, fixes: [], vars: { component: c.id }, evidence: [] });
    }
  }
  decisions.push({ id: "targets", template: "targets", kind: "decision", component: "*", fixes: [], vars: {}, evidence: [] });
  const byId = new Map(roadmap.items.map((i) => [i.id, i]));
  let order = roadmap.items.reduce((m, i) => Math.max(m, i.order), 0);
  const currentIds = new Set<string>();
  const newOnes: RoadmapItem[] = [];
  for (const c of [...cands, ...decisions]) {
    currentIds.add(c.id);
    const t = rubric.templates[c.template];
    const filled = fromTemplate(t, c.vars);
    const existing = byId.get(c.id);
    const base = {
      kind: c.kind,
      template: c.template,
      title: audit.narration?.titles?.[c.id] ?? c.title ?? filled.title,
      fixes: c.fixes,
      effort: t.effort,
      size: filled.size,
      ownerRole: t.ownerRole,
      decision: filled.decision,
      why: filled.why,
      doneWhen: filled.doneWhen,
      steps: filled.steps,
      evidence: c.evidence,
    };
    if (existing) {
      Object.assign(existing, base);
      if (existing.status === "done" && c.kind === "fix") {
        existing.status = "later";
        existing.closedAt = null;
        existing.closedBy = null;
        existing.observed = null;
      }
    } else {
      const item: RoadmapItem = { id: c.id, order: 0, status: "later", unlocks: "", impact: 0, dependsOn: [], expected: expectedFor(c, ctx), createdAt: date, createdBy: audit.id, closedAt: null, closedBy: null, observed: null, ...base };
      newOnes.push(item);
      roadmap.items.push(item);
      byId.set(item.id, item);
    }
  }
  for (const item of roadmap.items) {
    if (currentIds.has(item.id) || ctx.decisionsOnly) continue;
    if (item.kind === "fix" && item.status !== "done") {
      item.status = "done";
      item.closedAt = date;
      item.closedBy = audit.id;
    }
    if (item.template === "delegate" && item.status !== "done") item.status = "later";
  }
  const owner = byId.get("owner")!;
  const targets = byId.get("targets")!;
  if (roadmap.owner) owner.status = "done";
  if (roadmap.targets) targets.status = "done";
  if (roadmap.owner && !owner.closedAt) {
    owner.closedAt = date;
    owner.closedBy = audit.id;
  }
  if (roadmap.targets && !targets.closedAt) {
    targets.closedAt = date;
    targets.closedBy = audit.id;
  }
  const open = roadmap.items.filter((i) => i.kind === "fix" && i.status !== "done");
  const shares = sharesOf(ctx);
  for (const item of open) {
    const after = standardLevels(rubric, flipFor(item, open, maps));
    const rose = [...after.entries()].filter(([id, l]) => l > (levels.get(id) ?? 0) && ctx.active.has(id));
    item.impact = Math.min(1, Math.round(rose.reduce((s, [id]) => s + (shares.get(id) ?? 0), 0) * 1000) / 1000);
    const text = unlocksText(levels, after, unproven);
    const prerequisites = new Set<string>();
    const coRequired = new Set<string>();
    const goalConds = new Set<CondId>([...rubric.level1, ...rubric.level2]);
    const flippedAll = flipFor(item, open, maps);
    for (const f of item.fixes) {
      if (!goalConds.has(f.condition)) continue;
      const targetsComps = f.component === "*" ? [...maps.keys()] : [f.component];
      for (const compId of targetsComps) {
        const needed = neededConds(rubric, levels.get(compId) ?? 0);
        const bucket = needed.includes(f.condition) ? coRequired : prerequisites;
        const flipped = flippedAll.get(compId) ?? {};
        for (const cond of needed) {
          if (flipped[cond] === "met") continue;
          for (const other of open) {
            if (other.id !== item.id && other.fixes.some((x) => x.condition === cond && (x.component === compId || x.component === "*"))) bucket.add(other.id);
          }
        }
      }
    }
    item.dependsOn = item.impact > 0 ? [] : [...prerequisites];
    if (text) item.unlocks = text;
    else if (item.dependsOn.length) item.unlocks = `nothing on its own; first needs ${item.dependsOn.map((d) => byId.get(d)?.title ?? d).join(" and ")}`;
    else if (coRequired.size) {
      const together = [item, ...[...coRequired].map((d) => byId.get(d)!)];
      let joint = maps;
      for (const t of together) joint = flipFor(t, open.filter((o) => !together.includes(o) || o === t), joint);
      const jointText = unlocksText(levels, standardLevels(rubric, joint), unproven);
      item.unlocks = `${jointText || "the next level"} together with ${[...coRequired].map((d) => byId.get(d)?.title ?? d).join(" and ")}`;
    } else item.unlocks = "no level change yet";
  }
  for (const item of roadmap.items.filter((i) => i.kind !== "fix")) {
    if (item.template === "owner") item.unlocks = "a named owner for approvals, targets and the weekly recheck";
    else if (item.template === "targets") item.unlocks = "a definition of Level 3 for this repo";
    else if (item.template === "delegate") item.unlocks = `measured agent work in ${item.id.split(":").pop()}`;
  }
  for (const item of newOnes.sort((a, b) => {
    const la = a.kind === "fix" ? 0 : a.template === "owner" ? -1 : 1;
    const lb = b.kind === "fix" ? 0 : b.template === "owner" ? -1 : 1;
    return la - lb || b.impact - a.impact || EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort] || a.id.localeCompare(b.id);
  })) {
    item.order = ++order;
  }
  const isDone = (id: string) => byId.get(id)?.status === "done";
  for (const item of open) item.status = item.dependsOn.some((d) => !isDone(d)) ? "waiting" : "later";
  const neededFor = (compId: string) => neededConds(rubric, levels.get(compId) ?? 0);
  const blocking = open.filter((item) => item.status !== "waiting" && item.fixes.some((f) => (f.component === "*" ? [...ctx.active] : [f.component]).some((cid) => ctx.active.has(cid) && neededFor(cid).includes(f.condition))));
  blocking.sort((a, b) => b.impact - a.impact || EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort] || a.order - b.order);
  const top = blocking.slice(0, rubric.part1.maxGaps);
  for (const t of top) t.status = t.fixes.some((f) => unproven.has(f.component)) ? "start_now" : "next";
  const activeLevels = [...ctx.active].map((id) => provenLevels.get(id) ?? 0);
  const repoAt2 = activeLevels.length > 0 && Math.min(...activeLevels) === 2;
  if (top.length === 0 && repoAt2 && targets.status !== "done") {
    targets.status = "next";
    top.push(targets);
  } else if (targets.status !== "done") targets.status = "later";
  if (owner.status !== "done") owner.status = top.length > 0 ? "next" : "later";
  let startNow: RoadmapItem | null = null;
  const delegates = roadmap.items.filter((i) => i.template === "delegate" && currentIds.has(i.id));
  for (const d of delegates) {
    const comp = d.id.split(":").pop()!;
    const s = ctx.outcomes?.byComponent[comp];
    d.status = s && s.opened > 0 && d.createdAt <= (ctx.outcomes?.window.to ?? "") && d.createdBy !== audit.id ? "in_progress" : "start_now";
  }
  const sn = delegates.filter((d) => d.status === "start_now").sort((a, b) => (shares.get(b.id.split(":").pop()!) ?? 0) - (shares.get(a.id.split(":").pop()!) ?? 0));
  startNow = sn[0] ?? null;
  fillObserved(roadmap, ctx);
  roadmap.items.sort((a, b) => a.order - b.order);
  if (ctx.decisionsOnly) {
    for (const t of top) t.status = "later";
    return { roadmap, top: [], startNow: null, levels };
  }
  return { roadmap, top, startNow, levels };
}

function fillObserved(roadmap: Roadmap, ctx: RoadmapContext): void {
  const o = ctx.outcomes;
  if (!o) return;
  // The first window after a step closed is the one it's judged on; later windows don't replace it.
  for (const item of roadmap.items.filter((i) => i.status === "done" && i.closedAt && !i.observed)) {
    if (!(o.window.from >= (item.closedAt as string))) continue;
    const [metric, pattern] = item.expected.watch.metric.split(":");
    const now = watchFor(metric, item.expected.watch.scope, o, ctx.rubric, pattern);
    const shared = roadmap.items
      .filter((x) => x.id !== item.id && x.kind === "fix" && x.status === "done" && x.closedBy === item.closedBy && (x.expected.watch.scope === item.expected.watch.scope || x.expected.watch.scope === "repo" || item.expected.watch.scope === "repo"))
      .map((x) => x.id);
    item.observed = { value: `${item.expected.watch.baseline} to ${now.baseline}`, sharedWith: shared };
  }
}
