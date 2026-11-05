import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { ContainerSession, buildImage, detectRuntime } from "./container.ts";
import { containerImage, toolSetup } from "./contract.ts";
import { diagnose, testCounts } from "./diagnose.ts";
import { addEvidence } from "./evidence.ts";
import { applySite, chooseSites } from "./mutate.ts";
import { redact, tail } from "./redact.ts";
import type { Rubric } from "./rubric.ts";
import { SUDO_SHIM_MARK, runCommand, scrubbedEnv } from "./run.ts";
import type { RunOutcome } from "./run.ts";
import type { Audit, CommandKind, CondId, ContractCommand, Diagnosis, Evidence, Mutant, Profile, Strength, Where } from "./types.ts";
import { containedPath, exists, fail, listFiles, randomHex, readJson, readText, sha256, writeJson } from "./util.ts";
import { commandsFor } from "./score.ts";
import { BUDGET_OUT, CUT_OFF } from "./scope.ts";
import { SUPPORTED_DOC, notSupportedReason } from "./support.ts";
import { realSeed, refreshTree } from "./workspace.ts";

export interface Executor {
  where: Where;
  strength: Strength;
  image: string | null;
  // Who picked the image: a tool missing from one the repo declared is the repo's to add.
  imageSource: "audit" | "override" | "repo" | null;
  root: string;
  // imageUser: the repo's declared setup, run as its image's own user rather than an ordinary one.
  exec(command: string, cwd: string, timeoutSec: number, opts?: { imageUser?: boolean }): Promise<RunOutcome>;
  offline(): boolean;
  // Whether the last offline() call cut the network; null before it runs and on the host.
  networkOff: boolean | null;
  close(): void;
}

export const SUDO = /(^|[\s;&|(`]|\$\()sudo(\s|$)/;
export const SUDO_REFUSED = "not run on the host: it uses sudo, which the audit only runs inside a container";
export const NETWORK_ON = "the network couldn't be switched off for the test phase, so this pass doesn't prove a clean checkout";

const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

// Values to redact from command output: the registry variables, and with --inherit-env every
// inherited variable whose name looks like a secret.
export function registryValuesOf(audit: Audit): string[] {
  const names = new Set(audit.environment.registryEnv);
  if (audit.environment.inheritEnv) for (const k of Object.keys(process.env)) if (SECRET_NAME.test(k)) names.add(k);
  return [...names].map((k) => process.env[k] ?? "").filter(Boolean);
}

// A path from .cursor/environment.json, refused when it leaves the audited tree.
export function insideTree(root: string, ...parts: string[]): string {
  return containedPath(root, parts, ".cursor/environment.json");
}

// The host fallback runs bash, joins PATH with ":" and writes bash shims, none of which native
// Windows has.
export function assertHostFallbackSupported(platform: string = process.platform): void {
  if (platform === "win32") fail(`This machine has no Docker or Podman, and the audit can't run repo commands on Windows without one: ${notSupportedReason("windows")}. See ${SUPPORTED_DOC} in the skill.`);
}

export function hostExecutor(root: string, registryEnv: string[], inheritEnv: boolean, where: Where = "fresh_copy"): Executor {
  assertHostFallbackSupported();
  const env = scrubbedEnv({ registryEnv, inheritEnv });
  return {
    where,
    strength: "executed",
    image: null,
    imageSource: null,
    root,
    exec: (command, cwd, timeoutSec) => (SUDO.test(command) ? Promise.resolve({ exitCode: null, timedOut: false, durationMs: 0, output: `readiness: ${SUDO_REFUSED}` }) : runCommand(command, join(root, cwd), env, timeoutSec)),
    offline: () => false,
    networkOff: null,
    close: () => {},
  };
}

export function containerExecutor(session: ContainerSession, root: string, imageSource: Executor["imageSource"] = "audit"): Executor {
  const ex: Executor = {
    where: "container",
    strength: "clean_replay",
    image: session.image,
    imageSource,
    root,
    exec: (command, cwd, timeoutSec, opts) => session.exec(command, cwd, timeoutSec, opts),
    offline: () => (ex.networkOff = session.disconnectNetwork()),
    networkOff: null,
    close: () => session.stop(),
  };
  return ex;
}

const KIND_CHECK: Record<CommandKind, { check: string; condition?: CondId }> = {
  doctor: { check: "bootstrap.cold_replay" },
  install: { check: "bootstrap.cold_replay", condition: "clean.install" },
  build: { check: "bootstrap.cold_replay", condition: "clean.build" },
  start: { check: "bootstrap.cold_replay" },
  lint: { check: "verify.canonical_interface", condition: "commands" },
  typecheck: { check: "verify.canonical_interface", condition: "commands" },
  test: { check: "bootstrap.cold_replay", condition: "clean.test" },
};

export interface PhaseResult {
  cmd: ContractCommand;
  status: "pass" | "fail" | "not_run";
  outcome: RunOutcome | null;
  diagnosis: Diagnosis | null;
  note: string;
  blocked?: string;
}

export const INSTALL_BLOCKED = "not run because the install was blocked on this machine";

export interface WorkspacePackage {
  name: string;
  path: string;
}

// Every workspace package's name and folder, assessed or not, so a missing sibling is recognised.
export function workspacePackages(root: string, profile: Profile): WorkspacePackage[] {
  const dirs = [...profile.components.map((c) => c.path), ...profile.satellites.filter((s) => s.toolchain === "Node").map((s) => s.path)];
  return [...new Set(dirs)].flatMap((path) => {
    const f = join(root, path, "package.json");
    if (!exists(f)) return [];
    try {
      const name = readJson<{ name?: string }>(f).name;
      return name ? [{ name, path }] : [];
    } catch {
      return [];
    }
  });
}

const ONLINE_KINDS = new Set<CommandKind>(["doctor", "install", "build", "start"]);

// Support entries the replay reports as blocked, rather than the scan as not assessed.
export const REPLAY_STACKS = ["task-graph"];

// A failure that comes from the audit's own environment, not the repo: a tool missing from an image
// the audit picked, a network, TLS or proxy error while the network is on, or a sibling workspace
// package the audit didn't build first. Returns the blocked reason, or undefined for a repo failure.
export function environmentLimit(ex: Pick<Executor, "where" | "image" | "imageSource">, cmd: ContractCommand, d: Diagnosis | null, packages: WorkspacePackage[]): string | undefined {
  if (!d) return undefined;
  if (d.cause === "missing_tool") {
    if (ex.where !== "container") return `${d.detail} on this machine`;
    if (ex.imageSource !== "repo") return `${d.detail} in the audit's image (${ex.image})`;
  }
  if (d.cause === "network" && ONLINE_KINDS.has(cmd.kind)) return `the ${cmd.kind} hit ${d.detail}`;
  // The audit picks the user commands run as and the home they share, so this is never the repo's.
  if (d.cause === "permission") return `${d.detail} on this machine`;
  // A large repo's install can outlast the audit's limit on a slow machine or disk driver.
  if (d.cause === "timeout" && cmd.kind === "install") return `the install ran past the audit's ${Math.max(1, Math.round(cmd.timeoutSec / 60))}-minute limit on this machine`;
  if (d.cause === "missing_module") {
    const mod = d.detail.replace(/^module /, "").replace(/ is missing$/, "");
    const sibling = packages.find((p) => p.path !== cmd.cwd && p.path !== "." && (mod === p.name || mod.startsWith(`${p.name}/`) || mod.includes(`/node_modules/${p.name}/`) || mod.includes(`/${p.path}/`)));
    if (sibling) return `${sibling.name} is a sibling package the audit didn't build first, which isn't supported yet`;
  }
  return undefined;
}

export interface Budget {
  componentMs: number;
  totalMs: number;
  startedAt: number;
  used: Map<string, number>;
}

export function newBudget(componentMinutes: number, totalMinutes: number): Budget {
  return { componentMs: componentMinutes * 60000, totalMs: totalMinutes * 60000, startedAt: Date.now(), used: new Map() };
}

function overBudget(b: Budget, component: string): boolean {
  if (Date.now() - b.startedAt > b.totalMs) return true;
  return component !== "*" && (b.used.get(component) ?? 0) > b.componentMs;
}

// Seconds of budget left for a component, the whole audit's for "*". A command gets no longer than
// this, so a large repo's install or test run stops at the budget instead of running past it.
export function budgetLeftSec(b: Budget, component: string): number {
  const total = b.totalMs - (Date.now() - b.startedAt);
  const mine = component === "*" ? total : Math.min(total, b.componentMs - (b.used.get(component) ?? 0));
  return Math.max(0, Math.floor(mine / 1000));
}

// The timeout to run with, and whether the budget, not the command's own limit, set it.
function capped(b: Budget, component: string, timeoutSec: number): { sec: number; byBudget: boolean } {
  const left = budgetLeftSec(b, component);
  return left < timeoutSec ? { sec: Math.max(1, left), byBudget: true } : { sec: timeoutSec, byBudget: false };
}

function charge(b: Budget, component: string, ms: number): void {
  b.used.set(component, (b.used.get(component) ?? 0) + ms);
}

// Digests of the files a check could rewrite: what the audited commit has under its folder.
function snapshot(root: string, listFrom: string, cwd: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const f of listFiles(join(listFrom, cwd), { includeHidden: true })) {
    const rel = join(cwd, f);
    const full = join(root, rel);
    if (exists(full)) digests.set(rel, sha256(readFileSync(full)));
  }
  return digests;
}

function rewritten(root: string, before: Map<string, string>): string[] {
  return [...before].filter(([rel, digest]) => !exists(join(root, rel)) || sha256(readFileSync(join(root, rel))) !== digest).map(([rel]) => rel);
}

export const REWROTE = "so it rewrites code instead of checking it";

export async function runContract(
  ex: Executor,
  contract: ContractCommand[],
  // tree: the audited commit, to list the files a check must leave alone and put them back from.
  opts: { components: Set<string>; budget: Budget; registryValues: string[]; tree?: string; onResult?: (r: PhaseResult) => void; workspacePackages?: WorkspacePackage[] },
): Promise<PhaseResult[]> {
  const results: PhaseResult[] = [];
  const push = (r: PhaseResult) => {
    results.push(r);
    opts.onResult?.(r);
  };
  const wanted = (c: ContractCommand) => c.component === "*" || opts.components.has(c.component);
  // Lint runs before the build, so it never reads the build's output.
  const order: CommandKind[] = ["doctor", "install", "lint", "build", "start"];
  const online = contract.filter((c) => order.includes(c.kind) && wanted(c)).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const offlineCmds = contract.filter((c) => !order.includes(c.kind) && wanted(c));
  const failedInstalls = new Set<string>();
  const blockedInstalls = new Set<string>();
  const blockedIds = new Set<string>();
  // Components whose own frozen install passed after the shared install was blocked.
  const rescued = new Set<string>();
  const gated = (cmd: ContractCommand) => {
    if (cmd.kind === "doctor" || cmd.fallbackFor) return false;
    if (failedInstalls.has(cmd.component) && !rescued.has(cmd.component)) return true;
    return failedInstalls.has("*") && !rescued.has(cmd.component) && !rescued.has("*");
  };
  const attempt = async (cmd: ContractCommand): Promise<PhaseResult | null> => {
    if (cmd.fallbackFor && !blockedIds.has(cmd.fallbackFor)) return null;
    const cutOff = (): PhaseResult => {
      if (cmd.kind === "install") {
        failedInstalls.add(cmd.component);
        blockedInstalls.add(cmd.component);
        blockedIds.add(cmd.id);
      }
      return { cmd, status: "not_run", outcome: null, diagnosis: null, note: "cut off by the time budget", blocked: BUDGET_OUT };
    };
    if (overBudget(opts.budget, cmd.component)) return cutOff();
    if (gated(cmd)) {
      const blocked = blockedInstalls.has(cmd.component) || (blockedInstalls.has("*") && !failedInstalls.has(cmd.component));
      return { cmd, status: "not_run", outcome: null, diagnosis: null, note: blocked ? INSTALL_BLOCKED : "not run because the install failed", blocked: blocked ? "the install was blocked on this machine" : undefined };
    }
    if (ex.where !== "container" && SUDO.test(cmd.command)) {
      if (cmd.kind === "install") {
        failedInstalls.add(cmd.component);
        blockedInstalls.add(cmd.component);
        blockedIds.add(cmd.id);
      }
      return { cmd, status: "not_run", outcome: null, diagnosis: null, note: SUDO_REFUSED, blocked: `the ${cmd.kind} command uses sudo, which the audit never runs on the host` };
    }
    const watched = cmd.kind === "lint" || cmd.kind === "typecheck" ? snapshot(ex.root, opts.tree ?? ex.root, cmd.cwd) : null;
    const limit = capped(opts.budget, cmd.component, cmd.timeoutSec);
    const out = await ex.exec(cmd.command, cmd.cwd, limit.sec, { imageUser: cmd.source.startsWith(".cursor/environment.json") });
    charge(opts.budget, cmd.component, out.durationMs);
    if (out.timedOut && limit.byBudget) return cutOff();
    // A check that changes the code it checks has to fail, and the code goes back for the steps after it.
    const changed = watched ? rewritten(ex.root, watched) : [];
    if (changed.length && opts.tree) for (const rel of changed) if (exists(join(opts.tree, rel))) cpSync(join(opts.tree, rel), join(ex.root, rel));
    // A runner that prints failures and still exits 0 hasn't passed.
    const reportedFailures = cmd.kind === "test" && out.exitCode === 0 ? (testCounts(out.output)?.failed ?? 0) : 0;
    const ok = out.exitCode === 0 && !out.timedOut && reportedFailures === 0 && changed.length === 0;
    const rewroteDetail = `it changed ${changed.length} ${changed.length === 1 ? "file" : "files"} (${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", …" : ""}), ${REWROTE}`;
    const diagnosis = ok ? null : changed.length ? { cause: "unknown" as const, detail: rewroteDetail } : reportedFailures > 0 ? { cause: "unknown" as const, detail: `the runner reported ${reportedFailures} failing tests but exited 0` } : diagnose(out.output, out.timedOut, cmd.kind);
    const sudoRefused = !ok && ex.where !== "container" && out.output.includes(SUDO_SHIM_MARK);
    const blocked = sudoRefused ? `the ${cmd.kind} command uses sudo, which the audit never runs on the host` : ok ? undefined : environmentLimit(ex, cmd, diagnosis, opts.workspacePackages ?? []);
    if (!ok && cmd.kind === "install") {
      failedInstalls.add(cmd.component);
      if (blocked) {
        blockedInstalls.add(cmd.component);
        blockedIds.add(cmd.id);
      }
    }
    if (ok && cmd.kind === "install" && cmd.fallbackFor) rescued.add(cmd.component);
    return { cmd, status: ok ? "pass" : "fail", outcome: out, diagnosis, note: cmd.fallbackFor && ok ? "ran on its own because the shared install was blocked on this machine" : "", blocked };
  };
  const run = async (cmd: ContractCommand) => {
    const r = await attempt(cmd);
    if (r) push(r);
  };
  // A lint that fails before the build may need what the build makes, such as a workspace
  // package's types, so it gets one more run after a build that passed.
  const builtFor = (comp: string) => online.some((c) => c.kind === "build" && (c.component === comp || c.component === "*" || comp === "*"));
  const beforeBuild = new Map<string, PhaseResult>();
  for (const cmd of online) {
    const r = await attempt(cmd);
    if (!r) continue;
    if (cmd.kind === "lint" && r.status === "fail" && !r.blocked && !r.diagnosis?.detail.endsWith(REWROTE) && builtFor(cmd.component)) beforeBuild.set(cmd.id, r);
    else push(r);
  }
  const firstOffline = results.length;
  const wentOffline = ex.offline();
  for (const first of beforeBuild.values()) {
    const built = results.filter((r) => r.cmd.kind === "build" && (r.cmd.component === first.cmd.component || r.cmd.component === "*" || first.cmd.component === "*"));
    const again = built.length && built.every((r) => r.status === "pass") ? await attempt(first.cmd) : null;
    if (again?.status === "pass") push({ ...again, note: "failed before the build and passed after it" });
    else push({ ...first, note: again ? "failed before the build and again after it" : first.note });
  }
  for (const cmd of offlineCmds) await run(cmd);
  if (ex.where === "container" && !wentOffline) {
    for (const r of results.slice(firstOffline)) {
      if (r.status === "pass") r.blocked = NETWORK_ON;
      else if (!r.note) r.note = NETWORK_ON;
    }
  }
  return results;
}

export function evidenceFromPhase(audit: Audit, ex: Executor, r: PhaseResult, registryValues: string[]): Evidence {
  const map = KIND_CHECK[r.cmd.kind];
  const redacted = r.outcome ? redact(r.outcome.output, registryValues) : "";
  let summary: string;
  const counts = r.cmd.kind === "test" && r.outcome ? testCounts(r.outcome.output) : null;
  if (r.status === "pass") summary = `${r.cmd.kind} passed${counts ? ` (${counts.passed} of ${counts.total} tests)` : ""}`;
  else if (r.status === "not_run") summary = r.note.startsWith("not run") ? `${r.cmd.kind} ${r.note}` : `${r.cmd.kind} not run: ${r.note}`;
  else summary = `${r.cmd.kind} failed: ${r.diagnosis?.detail ?? "non-zero exit"}${counts && counts.failed ? ` (${counts.failed} of ${counts.total} tests failed)` : ""}`;
  if (r.status === "fail" && r.diagnosis?.cause === "registry" && audit.environment.registryEnv.length === 0) summary = `${r.cmd.kind} failed: registry credentials not provided (pass them with --registry-env)`;
  if (r.cmd.declared && r.status !== "not_run") summary += `; ran check-only, without the write flags in \`${r.cmd.declared}\``;
  return addEvidence(audit, {
    checkId: map.check,
    condition: map.condition,
    component: r.cmd.component,
    kind: r.cmd.kind,
    contractId: r.cmd.id,
    strength: ex.strength,
    where: ex.where,
    result: r.status,
    command: r.cmd.command,
    cwd: r.cmd.cwd,
    image: ex.image ?? undefined,
    exitCode: r.outcome?.exitCode ?? null,
    timedOut: r.outcome?.timedOut ?? false,
    durationMs: r.outcome?.durationMs,
    outputTail: r.outcome ? tail(redacted) : undefined,
    outputDigest: r.outcome ? sha256(redacted) : undefined,
    summary,
    diagnosis: r.diagnosis ?? undefined,
    blocked: r.blocked,
  });
}

// When the repo's declared image installs the tool this machine lacks, say so: it is the clearest
// sign that the failure is the machine's, not the repo's.
function declaredImageInstalls(copyDir: string, profile: Profile, tool: string): string | null {
  const dockerfile = profile.environmentJson?.build?.dockerfile;
  if (!dockerfile || !/^[\w.+-]+$/.test(tool)) return null;
  const path = insideTree(copyDir, ".cursor", dockerfile);
  return exists(path) && new RegExp(`(^|[^\\w.-])${tool.replace(/[.+]/g, "\\$&")}([^\\w.-]|$)`, "m").test(readText(path)) ? `.cursor/${dockerfile}` : null;
}

export interface ReplayOptions {
  component?: string;
  mutants: boolean;
  instructions: boolean;
  runtime: string;
  image?: string;
  budgetComponentMinutes: number;
  budgetTotalMinutes: number;
  log: (line: string) => void;
}

const FROZEN = /(\bci\b|--frozen|--immutable|--frozen-lockfile|\bpoetry (sync\b|install\b.*--sync))/;

function lockfileEvidence(audit: Audit, ex: Executor, profile: Profile, copyDir: string, before: Map<string, string>, installCmds: ContractCommand[]): void {
  const pm = profile.packageManager;
  let result: "pass" | "fail" = "pass";
  let summary = "frozen install reproduced the lockfile";
  if (pm === "pip") {
    const req = join(copyDir, "requirements.txt");
    const lines = exists(req) ? readText(req).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("-")) : [];
    const loose = lines.filter((l) => !l.includes("=="));
    if (lines.length === 0 && !exists(join(copyDir, "pyproject.toml"))) {
      result = "fail";
      summary = "no requirements file or lockfile";
    } else if (loose.length > 0) {
      result = "fail";
      summary = `requirements.txt doesn't pin exact versions for ${loose.length} of ${lines.length} packages`;
    }
  } else if (profile.lockfiles.length === 0) {
    result = "fail";
    summary = "no lockfile is committed";
  } else if (installCmds.some((c) => c.source === "readiness" && !FROZEN.test(c.command))) {
    result = "fail";
    summary = "the install isn't frozen";
  } else {
    for (const [f, digest] of before) {
      const now = exists(join(copyDir, f)) ? sha256(readText(join(copyDir, f))) : "";
      if (now !== digest) {
        result = "fail";
        summary = `the install changed ${f}`;
      }
    }
  }
  addEvidence(audit, { checkId: "bootstrap.cold_replay", condition: "lockfile", component: "*", strength: ex.strength, where: ex.where, result, summary, image: ex.image ?? undefined });
}

export const NO_MUTANTS = "planted faults skipped by --no-mutants";

async function plantFaults(audit: Audit, repo: string, tree: string, ex: Executor, rubric: Rubric, testCmd: ContractCommand, budget: Budget, log: (s: string) => void): Promise<void> {
  const comp = audit.profile!.components.find((c) => c.id === testCmd.component)!;
  const sites = chooseSites(repo, tree, comp, realSeed(audit, { tree, createdAt: audit.createdAt }), rubric.mutation.perComponent);
  if (sites.length === 0) {
    addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp.id, strength: ex.strength, where: ex.where, result: "not_run", summary: "no places to plant a fault were found in files the tests import" });
    return;
  }
  const mutants: Mutant[] = [];
  let n = audit.mutants.filter((m) => m.component === comp.id).length + 1;
  let cut = 0;
  for (const site of sites) {
    const id = `mut-${comp.id}-${n++}`;
    if (overBudget(budget, comp.id) || budgetLeftSec(budget, comp.id) < 1) {
      cut++;
      mutants.push({ id, component: comp.id, file: site.file, line: site.line, operator: site.operator, before: redact(site.before), after: redact(site.after), result: "not_run", exitCodes: [] });
      continue;
    }
    const filePath = join(ex.root, site.file);
    const original = readText(filePath);
    writeFileSync(filePath, applySite(original, site));
    const codes: number[] = [];
    let result: Mutant["result"] = "survived";
    try {
      for (let run = 0; run < rubric.mutation.flakeRuns; run++) {
        const limit = capped(budget, comp.id, rubric.mutation.runTimeoutSec);
        const out = await ex.exec(testCmd.command, testCmd.cwd, limit.sec);
        charge(budget, comp.id, out.durationMs);
        codes.push(out.exitCode ?? -1);
        if (out.timedOut) {
          if (limit.byBudget) cut++;
          result = "not_run";
          break;
        }
        if (out.exitCode === 0 && !((testCounts(out.output)?.failed ?? 0) > 0)) {
          result = run === 0 ? "survived" : "discarded";
          break;
        }
        if (diagnose(out.output, false, "test").cause === "compile") {
          result = "discarded";
          break;
        }
        result = "caught";
      }
    } finally {
      writeFileSync(filePath, original);
    }
    mutants.push({ id, component: comp.id, file: site.file, line: site.line, operator: site.operator, before: redact(site.before), after: redact(site.after), result, exitCodes: codes });
  }
  saveMutantDetails(tree, mutants);
  audit.mutants.push(...mutants.map((m) => ({ id: m.id, component: m.component, result: m.result, exitCodes: m.exitCodes })));
  const counted = mutants.filter((m) => m.result === "caught" || m.result === "survived");
  const caught = counted.filter((m) => m.result === "caught").length;
  const operators = [...new Set(mutants.map((m) => m.operator))].join(", ");
  const missed = mutants.filter((m) => m.result === "survived").map((m) => m.id);
  let result: "pass" | "fail" | "not_run";
  let summary: string;
  const cutNote = cut ? `; the time budget cut off ${cut} of ${sites.length}` : "";
  if (counted.length < rubric.mutation.minForPass) {
    result = "not_run";
    summary = `only ${counted.length} planted faults gave a clear result; at least ${rubric.mutation.minForPass} are needed${cutNote}`;
  } else if (caught === counted.length) {
    result = "pass";
    summary = `caught ${caught} of ${counted.length} planted faults (tried: ${operators})${cutNote}`;
  } else {
    result = "fail";
    summary = `caught ${caught} of ${counted.length} planted faults${cutNote}; missed ${missed.length}${MISSED_AFTER_SEAL}`;
  }
  log(`  faults in ${comp.id}: ${summary}`);
  // Too few results because the budget ran out is the audit's limit, not weak tests.
  const blocked = cut && result === "not_run" ? { blocked: BUDGET_OUT } : {};
  addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp.id, strength: ex.strength, where: ex.where, result, summary, image: ex.image ?? undefined, ...(missed.length ? { missedFaults: missed } : {}), ...blocked });
}

const MISSED_AFTER_SEAL = " (the sealed report says where)";

// Next to the audit tree, outside the repository, and deleted with it once the seal copies it in.
export function mutantsFile(tree: string): string {
  return join(dirname(tree), "mutants.json");
}

function saveMutantDetails(tree: string, mutants: Mutant[]): void {
  const f = mutantsFile(tree);
  const prior = exists(f) ? readJson<Mutant[]>(f) : [];
  writeJson(f, [...prior, ...mutants]);
}

// At the seal, after every result is final: put each fault's site back and name the missed ones.
export function revealMutants(audit: Audit, tree: string): void {
  const f = mutantsFile(tree);
  if (!exists(f)) return;
  const details = new Map(readJson<Mutant[]>(f).map((m) => [m.id, m]));
  audit.mutants = audit.mutants.map((m) => ({ ...details.get(m.id), ...m }));
  for (const e of audit.evidence) {
    if (!e.missedFaults?.length || !e.summary.endsWith(MISSED_AFTER_SEAL)) continue;
    const where = e.missedFaults.map((id) => details.get(id)).filter((m): m is Mutant => Boolean(m)).map((m) => `${m.operator} at ${m.file}:${m.line}`);
    if (where.length) e.summary = e.summary.replace(/; missed \d+ \(the sealed report says where\)$/, `; missed: ${where.join(", ")}`);
  }
}

const TOOL_SETUP_MS = 10 * 60 * 1000;

export function makeExecutor(audit: Audit, copyDir: string, runtimePref: string, log: (s: string) => void, imageOverride?: string): Executor {
  const runtime = detectRuntime(runtimePref);
  let image = imageOverride ?? containerImage(audit.profile!, copyDir);
  let imageSource: Executor["imageSource"] = imageOverride ? "override" : "audit";
  const declared = audit.profile?.environmentJson?.build;
  if (runtime && declared && !imageOverride) {
    const dockerfile = insideTree(copyDir, ".cursor", declared.dockerfile);
    const context = insideTree(copyDir, ".cursor", declared.context ?? ".");
    const tag = `readiness-env-${sha256(readText(dockerfile)).slice(0, 12)}`;
    log(`Building the repo's declared environment image from .cursor/${declared.dockerfile}.`);
    const built = buildImage(runtime, context, dockerfile, tag);
    if (!built.ok) fail(`The declared environment image didn't build:\n${tail(built.output, 2000)}`);
    image = tag;
    imageSource = "repo";
  }
  if (runtime) {
    const session = new ContainerSession(runtime, `readiness-${audit.id}-${randomHex(3)}`, image, copyDir, audit.environment.registryEnv);
    const started = session.start();
    if (started.ok) {
      session.enableCorepack();
      audit.environment.containerRuntime = runtime.bin;
      audit.environment.image = image;
      log(`Replaying in a clean ${runtime.bin} container (${image}).`);
      // Python components next to Node ones run in the Node image, which has python3 but no venv.
      if (image.startsWith("node:") && audit.profile!.components.some((c) => c.assessed && c.language === "py")) {
        const added = session.asImageUser("python3 -m venv /tmp/venv-probe >/dev/null 2>&1 || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv >/dev/null)", 600000);
        log(added.ok ? "Added python3-venv to the Node image for the Python components." : `Couldn't add python3-venv for the Python components: ${tail(added.output, 300)}`);
      }
      // A tool missing from the repo's own image is the repo's to add, so only the audit's images get
      // one. Poetry needs the venv module above.
      if (imageSource !== "repo") {
        for (const t of toolSetup(audit.profile!, copyDir)) {
          if (session.asImageUser(`command -v ${t.tool}`, 30000).ok) continue;
          const added = session.asImageUser(t.install, TOOL_SETUP_MS);
          (audit.environment.tools ??= []).push({ spec: t.spec, added: added.ok });
          log(added.ok ? `Added ${t.spec} to the image for the frozen install.` : `Couldn't add ${t.spec} to the image, so its install will be blocked: ${tail(added.output, 300)}`);
        }
      }
      session.reclaimHome();
      return containerExecutor(session, copyDir, imageSource);
    }
    log(`Could not start a container: ${started.output.trim().split("\n").pop()}`);
  }
  audit.environment.containerRuntime = null;
  audit.environment.image = null;
  log("No container runtime: replaying in a fresh copy on the host. Level 1 can't be proved on this machine.");
  return hostExecutor(copyDir, audit.environment.registryEnv, audit.environment.inheritEnv);
}

export async function replay(audit: Audit, repo: string, tree: string, rubric: Rubric, opts: ReplayOptions): Promise<void> {
  if (audit.tier === "read-only") fail("The read-only tier doesn't run repo code. Re-init with --tier local-exec.");
  if (!audit.profile) fail("Run `readiness scan` before `readiness replay`.");
  if (!audit.profile.components.some((c) => c.assessed)) {
    opts.log("Nothing to replay: no component could be assessed. The report says why and gives no level.");
    return;
  }
  const profile = audit.profile;
  refreshTree(repo, audit.repo.commit, tree);
  const copyDir = join(mkdtempSync(join(tmpdir(), "readiness-replay-")), "work");
  cpSync(tree, copyDir, { recursive: true });
  const before = new Map<string, string>();
  for (const f of profile.lockfiles) before.set(f, sha256(readText(join(copyDir, f))));
  if (opts.image) audit.environment.imageOverride = opts.image;
  const ex = makeExecutor(audit, copyDir, opts.runtime, opts.log, opts.image ?? audit.environment.imageOverride);
  const registryValues = registryValuesOf(audit);
  const components = new Set(profile.components.filter((c) => c.assessed && (!opts.component || c.id === opts.component)).map((c) => c.id));
  if (opts.component && components.size === 0) fail(`No assessed component named ${opts.component}`);
  const budget = newBudget(opts.budgetComponentMinutes, opts.budgetTotalMinutes);
  try {
    const results = await runContract(ex, audit.contract, {
      components,
      budget,
      registryValues,
      tree,
      workspacePackages: workspacePackages(copyDir, profile),
      onResult: (r) => opts.log(`  ${r.cmd.kind.padEnd(9)} ${r.cmd.component.padEnd(12)} ${r.blocked ? "blocked" : r.status}${r.blocked ? ` (${r.blocked})` : r.diagnosis ? ` (${r.diagnosis.detail})` : r.note ? ` (${r.note})` : ""}`),
    });
    for (const r of results) {
      if (r.blocked && r.diagnosis?.cause === "missing_tool" && ex.where !== "container") {
        const tool = r.diagnosis.detail.replace(/ is not installed$/, "");
        const declared = declaredImageInstalls(copyDir, profile, tool);
        if (declared) r.blocked += `, though the repo's declared image (${declared}) installs it`;
      }
      if (r.blocked && r.diagnosis?.cause === "missing_tool" && ex.where === "container") {
        const tool = r.diagnosis.detail.replace(/ is not installed$/, "");
        const failed = audit.environment.tools?.find((t) => !t.added && t.spec.split(/[@=]/)[0] === tool);
        if (failed) r.blocked += `: the audit couldn't add ${failed.spec} to it on this machine`;
      }
      const ev = evidenceFromPhase(audit, ex, r, registryValues);
      if (r.diagnosis?.cause === "credential" && !audit.safety.some((s) => s.kind === "credential_needed" && s.detail.includes(r.diagnosis!.detail))) {
        audit.safety.push({ id: `saf-${String(audit.safety.length + 1).padStart(3, "0")}`, kind: "credential_needed", file: ev.id, detail: `tests ${r.diagnosis.detail}`, blocking: true });
      }
    }
    const allInstalls = results.filter((r) => r.cmd.kind === "install");
    // When this machine blocked the shared install, the components' own frozen installs stand in for it.
    const installs = allInstalls.some((r) => r.cmd.fallbackFor) ? allInstalls.filter((r) => r.cmd.fallbackFor || !r.blocked) : allInstalls;
    const installed = installs.length > 0 && installs.every((r) => r.status === "pass");
    if (installed) lockfileEvidence(audit, ex, profile, copyDir, before, installs.map((r) => r.cmd));
    else if (installs.some((r) => r.blocked) && installs.every((r) => r.status === "pass" || r.blocked)) {
      const blocked = installs.find((r) => r.blocked)!.blocked!;
      addEvidence(audit, { checkId: "bootstrap.cold_replay", condition: "lockfile", component: "*", strength: ex.strength, where: ex.where, result: "not_run", summary: "the frozen install couldn't run on this machine", blocked, image: ex.image ?? undefined });
    }
    if (opts.mutants) {
      for (const comp of components) {
        const mine = new Set(commandsFor(audit.contract, comp, "test").map((c) => c.id));
        const testRuns = results.filter((r) => mine.has(r.cmd.id));
        const testRes = testRuns.find((r) => r.cmd.component === comp) ?? testRuns[0];
        if (!testRes || testRuns.some((r) => r.status !== "pass")) {
          addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: testRes ? "tests must pass before faults can be planted" : "no test command found" });
          continue;
        }
        if (testRuns.some((r) => r.blocked)) {
          addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: "faults weren't planted: the network couldn't be switched off for the test phase", blocked: NETWORK_ON });
          continue;
        }
        const limit = capped(budget, comp, testRes.cmd.timeoutSec);
        const second = overBudget(budget, comp) || budgetLeftSec(budget, comp) < 1 ? null : await ex.exec(testRes.cmd.command, testRes.cmd.cwd, limit.sec);
        if (second) charge(budget, comp, second.durationMs);
        if (!second || (second.timedOut && limit.byBudget)) {
          addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: "faults weren't planted: the time budget ran out first", blocked: BUDGET_OUT });
          continue;
        }
        if (second.exitCode !== 0 || (testCounts(second.output)?.failed ?? 0) > 0) {
          addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: "tests passed once and failed on a second run, so faults weren't planted (possible flaky tests)" });
          continue;
        }
        const lang = profile.components.find((c) => c.id === comp)!.language;
        if (!rubric.mutation.languages.includes(lang)) {
          addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: `faults can't be planted in ${lang} yet` });
          continue;
        }
        try {
          await plantFaults(audit, repo, tree, ex, rubric, testRes.cmd, budget, opts.log);
        } catch (e) {
          const why = (e as Error).message.split("\n")[0].slice(0, 200);
          opts.log(`  faults in ${comp}: couldn't be planted (${why}); the other results are kept`);
          addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: `planting faults failed: ${why}` });
        }
      }
    } else {
      for (const comp of components) addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: NO_MUTANTS, skipped: "--no-mutants" });
    }
    if (opts.instructions) {
      const blocked = installs.find((r) => r.blocked)?.blocked;
      await replayInstructions(audit, ex, copyDir, budget, registryValues, installed ? null : { blocked });
    }
  } finally {
    ex.close();
    rmSync(dirname(copyDir), { recursive: true, force: true });
  }
}

export const INSTRUCTION_TIMEOUT_SEC = 300;
export { CUT_OFF };

// Documented commands run one by one in the replay copy, inside the audit's overall time budget:
// each gets what is left of it, and none starts once it is spent.
export async function replayInstructions(audit: Audit, ex: Executor, copyDir: string, budget: Budget, registryValues: string[], notInstalled: { blocked?: string } | null): Promise<void> {
  for (const item of audit.instructions.filter((i) => i.category === "replay" && i.staticResult === "pass")) {
    if (notInstalled) {
      item.result = "not_run";
      item.reason = notInstalled.blocked ? "not replayed because the install was blocked on this machine" : "not replayed because the install failed";
      item.blocked = notInstalled.blocked;
      continue;
    }
    const leftSec = Math.floor((budget.totalMs - (Date.now() - budget.startedAt)) / 1000);
    if (overBudget(budget, "*") || leftSec < 1) {
      item.result = "not_run";
      item.reason = CUT_OFF;
      continue;
    }
    const cwd = dirname(item.source) === "" ? "." : dirname(item.source);
    const out = await ex.exec(item.text, exists(join(copyDir, cwd)) ? cwd : ".", Math.min(INSTRUCTION_TIMEOUT_SEC, leftSec));
    charge(budget, "*", out.durationMs);
    const ok = out.exitCode === 0 && !out.timedOut;
    const redacted = redact(out.output, registryValues);
    const why = ok ? null : diagnose(out.output, out.timedOut, "instruction");
    if (!ok && ex.where !== "container" && out.output.includes(SUDO_SHIM_MARK)) {
      item.result = "not_run";
      item.reason = "not replayed: it uses sudo, which the audit never runs on the host";
      item.blocked = "it uses sudo, which the audit never runs on the host";
      continue;
    }
    if (why?.cause === "permission") {
      item.result = "not_run";
      item.reason = `not replayed: ${why.detail} on this machine, an environment limit rather than a repo defect`;
      item.blocked = `${why.detail} on this machine`;
      continue;
    }
    if (why?.cause === "missing_tool" && (ex.where !== "container" || ex.imageSource !== "repo")) {
      const where = ex.where === "container" ? `in the audit's image (${ex.image})` : "on this machine";
      item.result = "not_run";
      item.reason = `not replayed: ${why.detail} ${where}, an environment limit rather than a repo defect`;
      item.blocked = `${why.detail} ${where}`;
      continue;
    }
    if (why && (why.cause === "credential" || why.cause === "network" || why.cause === "service" || why.cause === "registry")) {
      item.category = "needs_access";
      item.result = "not_run";
      item.reason = `not replayed: it ${why.cause === "network" ? "needs the network" : why.detail}, which the replay doesn't provide`;
      continue;
    }
    // A timeout the budget forced is the audit's limit, not a slow instruction.
    if (out.timedOut && overBudget(budget, "*")) {
      item.result = "not_run";
      item.reason = CUT_OFF;
      continue;
    }
    const ev = addEvidence(audit, {
      checkId: "context.instructions_verified",
      condition: "instructions",
      strength: ex.strength,
      where: ex.where,
      result: ok ? "pass" : "fail",
      command: item.text,
      cwd,
      image: ex.image ?? undefined,
      exitCode: out.exitCode,
      timedOut: out.timedOut,
      durationMs: out.durationMs,
      outputTail: tail(redacted, 1500),
      outputDigest: sha256(redacted),
      summary: `${item.source}:${item.line} \`${item.text}\` ${ok ? "replays" : "fails: " + why!.detail}`,
    });
    item.result = ok ? "pass" : "fail";
    item.reason = ok ? undefined : why!.detail;
    item.evidenceId = ev.id;
  }
}
