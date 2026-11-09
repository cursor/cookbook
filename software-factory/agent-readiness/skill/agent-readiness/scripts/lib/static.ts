import { realpathSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { checkOnly } from "./contract.ts";
import { readPackageJson } from "./profile.ts";
import { scanText } from "./redact.ts";
import type { InstructionItem, Profile, SafetyFinding, ScanBound } from "./types.ts";
import { MAX_FILES, exists, inTreePath, listFiles, readText, sha256 } from "./util.ts";

const COMMAND_START = /^(npm|pnpm|yarn|npx|corepack|make|python3?|pip3?|pytest|uv|poetry|node|bun|cargo|go|tsc|eslint|ruff|\.\/[\w./-]+)(\s|$)/;
const SHELL_LANGS = new Set(["", "sh", "bash", "shell", "console", "zsh", "terminal"]);
const PATH_LIKE = /^(?:\.{1,2}\/)[\w./-]+$|^[\w.-]+(?:\/[\w.-]+)*\/$|^(?:[\w.-]+\/)*[\w.-]+\.(md|mdc|ts|tsx|js|mjs|cjs|json|py|ya?ml|sh|toml|txt|sql)$/;

const INSTALL = /^(npm (ci|install|i)\b|pnpm (install|i)\b|yarn( install)?\s*$|yarn install\b|corepack \w+ install\b|bun (install|i)\b|pip3? install\b|python3? -m pip install\b|uv sync\b|poetry (install|sync)\b)/;
const LONG_RUNNING = /\b(run )?(dev|start|serve|watch)(\s|$)|--watch\b|compose up\b|docker run\b/;
const NETWORK_PIPED = /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z)?sh\b/;
const DESTRUCTIVE = /rm -rf\s+(\/|~|\*|\$HOME)|\bdrop (database|table)\b|db:(reset|drop)|migrate(:| )reset|\btruncate\b|prisma migrate reset/i;
const DEPLOY = /\b(npm|pnpm|yarn) publish\b|\bdeploy\b|vercel --prod|firebase deploy|terraform (apply|destroy)|kubectl (apply|delete)|helm (upgrade|install)|gh release create|fly deploy|seed-prod/i;
const ENV_READ = /(?:process\.env\.|process\.env\[['"]|os\.environ(?:\.get)?\(?\[?['"]|getenv\(['"]|ENV\.fetch\(['"]|ENV\[['"])([A-Z][A-Z0-9_]*)/g;

// A production credential: PROD, PRODUCTION or LIVE as a word of the name, next to a word that
// holds a secret or a connection string. PRODUCT_DATABASE_URL and MEDUSA_PRODUCTION_VERSION aren't.
export function prodCredential(name: string): boolean {
  const words = name.split("_");
  return words.some((w) => /^(PROD|PRODUCTION|LIVE)$/.test(w)) && words.some((w) => /^(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|AUTH|DSN|URL|URI|CONNECTION)$/.test(w));
}

export function isRisky(cmd: string): boolean {
  return NETWORK_PIPED.test(cmd) || DESTRUCTIVE.test(cmd) || DEPLOY.test(cmd);
}

interface Extracted {
  kind: "command" | "path";
  text: string;
  line: number;
  via: "fence" | "code" | "link";
}

export function extractFromMarkdown(text: string): Extracted[] {
  const out: Extracted[] = [];
  const lines = text.split("\n");
  let inFence = false;
  let fenceLang = "";
  let inFrontmatter = lines[0]?.trim() === "---";
  let pending: { text: string; line: number } | null = null;
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    if (inFrontmatter) {
      if (i > 0 && raw.trim() === "---") inFrontmatter = false;
      return;
    }
    const fence = raw.match(/^\s*```(\w*)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceLang = fence[1].toLowerCase();
      } else inFence = false;
      pending = null;
      return;
    }
    if (inFence) {
      if (!SHELL_LANGS.has(fenceLang)) return;
      const part = raw.trim().replace(/^\$\s+/, "");
      const joined: { text: string; line: number } = pending ? { text: `${pending.text} ${part}`, line: pending.line } : { text: part, line: lineNo };
      if (part.endsWith("\\")) {
        pending = { text: joined.text.slice(0, -1).trim(), line: joined.line };
        return;
      }
      pending = null;
      const cmd = joined.text;
      if (cmd && !cmd.startsWith("#") && COMMAND_START.test(cmd)) out.push({ kind: "command", text: cmd, line: joined.line, via: "fence" });
      return;
    }
    for (const m of raw.matchAll(/`([^`]+)`/g)) {
      const span = m[1].trim();
      if (COMMAND_START.test(span) && span.includes(" ")) out.push({ kind: "command", text: span, line: lineNo, via: "code" });
      else if (PATH_LIKE.test(span) && !span.startsWith("http") && !span.includes("<")) out.push({ kind: "path", text: span, line: lineNo, via: "code" });
    }
    for (const m of raw.matchAll(/\[[^\]]*\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      out.push({ kind: "path", text: target, line: lineNo, via: "link" });
    }
  });
  const seen = new Set<string>();
  return out.filter((e) => {
    const key = `${e.kind}:${e.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scriptsAt(tree: string, dir: string): { scripts: Record<string, string>; at: string } | null {
  let d = dir;
  while (true) {
    const pkg = readPackageJson(join(tree, d));
    if (pkg) return { scripts: pkg.scripts ?? {}, at: d };
    if (d === "." || d === "") return null;
    d = dirname(d);
  }
}

function makeTargets(tree: string, dir: string): string[] | null {
  for (const d of [dir, "."]) {
    const f = join(tree, d, "Makefile");
    if (exists(f)) return [...readText(f).matchAll(/^([A-Za-z0-9_.-]+)\s*:/gm)].map((m) => m[1]);
  }
  return null;
}

const BUILTIN_RUN = new Set(["test", "start", "stop", "restart"]);
const PM_COMMANDS = new Set(["install", "i", "ci", "add", "remove", "exec", "dlx", "x", "init", "create", "why", "list", "ls", "outdated", "update", "audit", "link", "pack", "publish", "version", "config", "help"]);

function staticCheckCommand(cmd: string, tree: string, profile: Profile, fileDir: string): { result: "pass" | "fail"; reason?: string } {
  const words = cmd.split(/\s+/);
  const tool = words[0];
  const isNodeRepo = profile.packageManager === "npm" || profile.packageManager === "pnpm" || profile.packageManager === "yarn";
  if ((tool === "npm" || tool === "pnpm" || tool === "yarn") && isNodeRepo && tool !== profile.packageManager) {
    return { result: "fail", reason: `uses ${tool}, but the repo uses ${profile.packageManager}` };
  }
  if (tool === "npm" || tool === "pnpm" || tool === "yarn") {
    if (words.some((w) => w.startsWith("--filter") || w === "-w" || w.startsWith("--workspace"))) return { result: "pass" };
    let script: string | null = null;
    if (words[1] === "run" || words[1] === "run-script") script = words[2] ?? null;
    else if (words[1] && BUILTIN_RUN.has(words[1])) script = words[1];
    else if (tool !== "npm" && words[1] && !PM_COMMANDS.has(words[1]) && !words[1].startsWith("-")) script = words[1];
    if (script) {
      const found = scriptsAt(tree, fileDir) ?? scriptsAt(tree, ".");
      if (!found || !(script in found.scripts)) return { result: "fail", reason: `no "${script}" script in ${found ? (found.at === "." ? "" : found.at + "/") + "package.json" : "package.json"}` };
    }
    return { result: "pass" };
  }
  if (tool === "make") {
    const targets = makeTargets(tree, fileDir);
    const target = words.slice(1).find((w) => !w.startsWith("-") && !w.includes("="));
    if (!targets) return { result: "fail", reason: "there is no Makefile" };
    if (target && !targets.includes(target)) return { result: "fail", reason: `the Makefile has no "${target}" target` };
    return { result: "pass" };
  }
  if (tool.startsWith("./")) {
    const p = normalize(join(fileDir, tool));
    if (!exists(join(tree, p)) && !exists(join(tree, tool))) return { result: "fail", reason: `${tool} doesn't exist` };
  }
  return { result: "pass" };
}

const MACHINE_PATH = /(^|\s|=)(~\/|\$HOME\b|\/Users\/|\/home\/[a-z])/;

export const ELEVATED = /(^|[\s;&|(`]|\$\()sudo(\s|$)/;

function categorize(cmd: string): InstructionItem["category"] {
  if (isRisky(cmd)) return "risky";
  if (ELEVATED.test(cmd)) return "needs_access";
  if (INSTALL.test(cmd)) return "install";
  if (LONG_RUNNING.test(cmd)) return "long_running";
  if (MACHINE_PATH.test(cmd)) return "needs_access";
  return "replay";
}

const FUTURE = /\b(will (be )?(add|creat|live|hold|contain)\w*|(to be|not yet) (added|created|written)|(added|created|written|coming) (later|as|when|once)|later on|planned|upcoming|in the future|doesn't exist yet|does not exist yet|TODO)\b/i;

// Commands an instruction shows as a template, asks questions, or changes the dependencies with.
// None of them can be replayed as written, so they are listed as skipped instead.
const PLACEHOLDER = /<[A-Za-z][\w.:/-]*>|\{\{[^}]+\}\}/;
const RUNNER = String.raw`(npx|bunx|pnpx|(corepack\s+)?(pnpm|yarn)\s+dlx)\s+(-\S+\s+)*`;
const INTERACTIVE = new RegExp(String.raw`^(corepack\s+)?(npm|pnpm|yarn|bun)\s+(init|create|login|adduser)\b|^${RUNNER}(create-[\w-]+|\S+\s+init)\b|(^|\s)(auth\s+)?login(\s|$)|\s(-i|--interactive)(\s|$)|^(node|python3?)\s*$`);
const ADDS_PACKAGES = new RegExp(String.raw`^(corepack\s+)?(pnpm|yarn|bun)\s+(add|remove|rm|uninstall)\b|^npm\s+(i|install|add|uninstall|rm|remove)\b(\s+-\S+)*\s+[^-\s]|^(python3?\s+-m\s+)?pip3?\s+install\s+(?!.*(\s|^)(-r|-e|--requirement|--editable|\.)(\s|$))|^(uv|poetry|pdm)\s+(add|remove)\b|^${RUNNER}\S+\s+add\b`);

function skippedReason(cmd: string): string | null {
  if (PLACEHOLDER.test(cmd)) return "not replayed: it has a placeholder to fill in";
  if (INTERACTIVE.test(cmd)) return "not replayed: it asks questions as it runs";
  if (ADDS_PACKAGES.test(cmd)) return "not replayed: it adds or removes packages";
  return null;
}

// A documented lint or format command that rewrites files, directly or through the script it calls.
// The commands check runs its check-only form; replaying it as written would rewrite the copy.
function writesFiles(cmd: string, tree: string, fileDir: string, profile: Profile): string | null {
  const scripts = (scriptsAt(tree, fileDir) ?? scriptsAt(tree, "."))?.scripts ?? {};
  const { changes } = checkOnly(cmd, scripts, profile.packageManager);
  return changes.length ? `not replayed: it rewrites files as written; the commands check runs it check-only (${changes.join(", ")})` : null;
}

const SKILL_FILE = /^\.(cursor|claude|agents)\/skills\/([^/]+)\/SKILL\.md$/;

// A third-party skill copied into the repo documents its own tool, not this repo, so its commands
// aren't replayed. It is vendored when skills-lock.json lists it, a license ships with it, or its
// frontmatter names where it came from.
export function vendoredSkills(tree: string, files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let lock: Record<string, { source?: string }> = {};
  try {
    lock = exists(join(tree, "skills-lock.json")) ? ((JSON.parse(readText(join(tree, "skills-lock.json"))) as { skills?: typeof lock }).skills ?? {}) : {};
  } catch {
    lock = {};
  }
  for (const file of files) {
    const m = file.match(SKILL_FILE);
    if (!m) continue;
    const name = m[2];
    const dir = join(tree, dirname(file));
    const front = readText(join(tree, file)).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const from = front.match(/^(source|repository|upstream):\s*(.+)$/m)?.[2]?.trim();
    if (name in lock) out.set(file, `${lock[name].source ? `${lock[name].source}, ` : ""}listed in skills-lock.json`);
    else if (from) out.set(file, `from ${from}`);
    else if (/^license:/m.test(front) || listFiles(dir).some((f) => /^LICEN[CS]E(\.\w+)?$/i.test(f))) out.set(file, "it ships its own license");
  }
  return out;
}

// The same instruction file reached twice, through a symlink or as an identical copy, is checked once.
function duplicateOf(tree: string, file: string, seen: Map<string, string>): string | null {
  let key: string;
  try {
    key = `${realpathSync(join(tree, file))}`;
  } catch {
    return null;
  }
  const digest = `sha:${sha256(readText(join(tree, file)))}`;
  const first = seen.get(key) ?? (SKILL_FILE.test(file) ? seen.get(digest) : undefined);
  if (first) return first;
  seen.set(key, file);
  if (SKILL_FILE.test(file)) seen.set(digest, file);
  return null;
}

export function instructionItems(tree: string, profile: Profile): InstructionItem[] {
  const items: InstructionItem[] = [];
  let n = 1;
  let basenames: Set<string> | null = null;
  const vendored = vendoredSkills(tree, profile.instructionFiles);
  const seen = new Map<string, string>();
  const files = new Set(profile.instructionFiles);
  for (const file of profile.instructionFiles) {
    // Reached through a symlink to a file the scan also lists: check it once, at its tracked path.
    const real = inTreePath(tree, file);
    if (real && real !== file && files.has(real)) continue;
    if (duplicateOf(tree, file, seen)) continue;
    const fileDir = dirname(file) === "" ? "." : dirname(file);
    const text = readText(join(tree, file));
    const lines = text.split("\n");
    const thirdParty = vendored.get(file);
    for (const e of extractFromMarkdown(text)) {
      // A vendored skill's paths belong to its own workflow, such as the plans it writes, not this repo.
      if (e.kind === "path" && thirdParty) continue;
      // A path the docs say comes later isn't drift: it can't mislead an agent into using it now.
      if (e.kind === "path" && FUTURE.test(lines[e.line - 1] ?? "")) {
        const rel = e.text.replace(/\/$/, "");
        if (!exists(join(tree, normalize(join(fileDir, rel)))) && !exists(join(tree, rel))) continue;
      }
      if (e.kind === "path") {
        const rel = e.text.replace(/\/$/, "");
        const fromFile = normalize(join(fileDir, rel));
        if (fromFile.startsWith("..") && normalize(rel).startsWith("..")) continue;
        if (e.via === "code" && !rel.includes("/")) {
          basenames ??= new Set(listFiles(tree, { includeHidden: true }).map((f) => f.split("/").pop()!));
          if (!basenames.has(rel) && !exists(join(tree, rel))) continue;
        }
      }
      const id = `ins-${String(n++).padStart(3, "0")}`;
      if (e.kind === "path") {
        const rel = e.text.replace(/\/$/, "");
        const ok = exists(join(tree, normalize(join(fileDir, rel)))) || exists(join(tree, rel)) || (e.via === "code" && !rel.includes("/"));
        items.push({ id, source: file, line: e.line, kind: "path", text: e.text, category: "path", staticResult: ok ? "pass" : "fail", staticReason: ok ? undefined : `${e.text} doesn't exist`, result: ok ? "pass" : "fail", reason: ok ? undefined : `${e.text} doesn't exist` });
        continue;
      }
      // A template or a third-party skill's command isn't checked against this repo at all; a real
      // command that asks questions or adds packages still is, statically, before it's skipped.
      const early = thirdParty ? `not replayed: it comes from a vendored skill (${thirdParty}), so it documents that tool, not this repo` : PLACEHOLDER.test(e.text) ? skippedReason(e.text) : null;
      if (early) {
        items.push({ id, source: file, line: e.line, kind: "command", text: e.text, category: "skipped", staticResult: "pass", result: "not_run", reason: early });
        continue;
      }
      const skip = isRisky(e.text) ? null : (skippedReason(e.text) ?? writesFiles(e.text, tree, fileDir, profile));
      const category = skip ? "skipped" : categorize(e.text);
      const s = staticCheckCommand(e.text, tree, profile, fileDir);
      let result: InstructionItem["result"];
      let reason: string | undefined;
      if (s.result === "fail") {
        result = "fail";
        reason = s.reason;
      } else if (skip) {
        result = "not_run";
        reason = skip;
      } else if (category === "install") {
        result = "pass";
        reason = "install commands are checked statically; the clean replay runs the frozen install";
      } else if (category === "risky" || category === "long_running" || category === "needs_access") {
        result = "not_run";
        reason = category === "risky" ? "not replayed: it deploys, publishes, deletes or pipes the network into a shell" : category === "long_running" ? "not replayed: it starts a long-running process" : ELEVATED.test(e.text) ? "not replayed: it uses sudo" : "not replayed: it refers to a path on the author's machine";
      } else {
        result = "not_run";
        reason = "waiting for replay";
      }
      items.push({ id, source: file, line: e.line, kind: "command", text: e.text, category, staticResult: s.result, staticReason: s.reason, result, reason });
    }
  }
  return items;
}

function isText(path: string): boolean {
  try {
    const st = statSync(path);
    if (st.size > 1024 * 1024) return false;
  } catch {
    return false;
  }
  return !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|mov|wasm|so|dylib|exe|jar)$/i.test(path);
}

// Tests, fixtures, docs, examples and generated code are full of dummy keys, so a hit there is
// listed for review instead of holding every component below Level 2.
const NOT_SHIPPED: { re: RegExp; where: string }[] = [
  { re: /(^|\/)(tests?|__tests__|specs?|e2e|fixtures?|__fixtures__|testdata|__mocks__|mocks?|(integration|unit|functional|acceptance|api|e2e)[-_]tests?|tests?[-_](utils?|helpers?|support|setup)|testing)\/|\.(test|spec)\.[\w]+$|_(test|spec)\.\w+$|(^|\/)test_[^/]+$|(^|\/)conftest\.py$/, where: "test" },
  { re: /(^|\/)(generated|__generated__|dist|build|coverage)\/|\.generated\.|\.min\.js$/, where: "generated" },
  { re: /(^|\/)(docs?|examples?|samples?)\/|\.(md|mdx|rst|adoc)$|(^|\/)\.env\.(example|sample|template)$|\.example$/, where: "docs or example" },
];

export function notShipped(file: string): string | null {
  return NOT_SHIPPED.find((n) => n.re.test(file))?.where ?? null;
}

// Past the scan's time bound, the secret scan stops and records how many files it read; the
// manifest and script checks after it are cheap and always run.
export function safetyScan(tree: string, profile: Profile, bound?: ScanBound): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  let n = 1;
  const add = (f: Omit<SafetyFinding, "id">) => findings.push({ id: `saf-${String(n++).padStart(3, "0")}`, ...f });
  const files = listFiles(tree, { includeHidden: true });
  if (bound) {
    bound.scope.files = files.length;
    bound.scope.fileCap = files.length >= MAX_FILES ? MAX_FILES : null;
    bound.scope.secrets = { scanned: 0, total: files.length };
  }
  for (const file of files) {
    if (bound && Date.now() > bound.until) break;
    if (bound) bound.scope.secrets.scanned++;
    if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|bun\.lock)$/.test(file)) continue;
    const full = join(tree, file);
    if (!isText(full)) continue;
    const text = readText(full);
    const where = notShipped(file);
    for (const hit of scanText(text)) add({ kind: "secret", file, line: hit.line, detail: where ? `${hit.type} in a ${where} file, listed for review` : hit.type, blocking: !where });
    if (where === "test") {
      const lines = text.split("\n");
      lines.forEach((l, i) => {
        const name = [...l.matchAll(ENV_READ)].map((m) => m[1]).find(prodCredential);
        if (name) add({ kind: "credential_needed", file, line: i + 1, detail: `tests read ${name}`, blocking: true });
      });
    }
  }
  const env = profile.environmentJson;
  for (const [field, cmd] of [["install", env?.install], ["start", env?.start]] as const) {
    if (cmd && ELEVATED.test(cmd)) add({ kind: "elevated", file: env!.path, detail: `${field} runs sudo (\`${cmd}\`); the audit runs it only inside a container, never on the host`, blocking: false });
  }
  for (const manifest of profile.manifests.filter((m) => m.endsWith("package.json"))) {
    const pkg = readPackageJson(join(tree, dirname(manifest)));
    for (const [name, cmd] of Object.entries(pkg?.scripts ?? {})) {
      const hook = /^(pre|post)?install$|^prepare$|^prepublish$/.test(name);
      if (ELEVATED.test(cmd)) add({ kind: "elevated", file: manifest, detail: `scripts.${name} runs sudo; the audit runs it only inside a container, never on the host`, blocking: false });
      if (NETWORK_PIPED.test(cmd)) add({ kind: "network_piped", file: manifest, detail: `scripts.${name} pipes a download into a shell`, blocking: hook });
      else if (hook) add({ kind: "lifecycle_hook", file: manifest, detail: `scripts.${name} runs on every install`, blocking: false });
      if (DESTRUCTIVE.test(cmd)) add({ kind: "destructive", file: manifest, detail: `scripts.${name} deletes data`, blocking: false });
      if (DEPLOY.test(cmd) || /^(deploy|publish|release)/.test(name)) add({ kind: "deploy_publish", file: manifest, detail: `scripts.${name} deploys or publishes`, blocking: false });
    }
  }
  for (const file of files.filter((f) => /(^|\/)Makefile$/.test(f) || /^(scripts|\.cursor)\/[^/]+\.sh$/.test(f))) {
    if (readText(join(tree, file)).split("\n").some((l) => !l.trim().startsWith("#") && ELEVATED.test(l))) add({ kind: "elevated", file, detail: "runs sudo; the audit runs it only inside a container, never on the host", blocking: false });
  }
  for (const file of files.filter((f) => /(^|\/)Makefile$/.test(f) || /^scripts\/.+\.sh$/.test(f))) {
    const text = readText(join(tree, file));
    if (DESTRUCTIVE.test(text)) add({ kind: "destructive", file, detail: "contains a command that deletes data", blocking: false });
    if (DEPLOY.test(text) || /deploy|prod/i.test(file)) add({ kind: "deploy_publish", file, detail: "deploys or reaches production", blocking: false });
  }
  return findings;
}
