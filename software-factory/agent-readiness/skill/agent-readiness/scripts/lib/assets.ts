import { join } from "node:path";
import { ghJson } from "./gh.ts";
import { ELEVATED } from "./static.ts";
import type { Asset, InstructionItem, ScanBound } from "./types.ts";
import { addDays, git, inTreePath, listFiles, readText, today } from "./util.ts";

const KINDS: { re: RegExp; kind: Asset["kind"] }[] = [
  { re: /(^|\/)(AGENTS|CLAUDE)\.md$/, kind: "agents_md" },
  { re: /^\.(cursor|claude|agents)\/skills\/[^/]+\/SKILL\.md$/, kind: "skill" },
  { re: /^\.cursor\/rules\/.+\.(mdc|md)$/, kind: "rules" },
  { re: /^\.cursorrules$/, kind: "rules" },
  { re: /^\.cursor\/hooks\.json$|^\.claude\/settings\.json$/, kind: "hooks" },
  { re: /^\.cursor\/environment\.json$|^\.devcontainer\/devcontainer\.json$|^\.cursor\/Dockerfile$/, kind: "environment" },
  { re: /^\.cursor\/mcp\.json$/, kind: "mcp" },
  { re: /^\.github\/copilot-instructions\.md$|^\.github\/instructions\/.+\.instructions\.md$/, kind: "instructions" },
];

export function frontmatterOk(text: string): boolean {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return false;
  return /^name:\s*\S/m.test(m[1]) && /^description:\s*\S/m.test(m[1]);
}

function authors(repo: string, path: string, timeoutMs?: number): { name: string; commits: number }[] | null {
  const r = git(["log", "--format=%an", "--follow", "--", path], repo, timeoutMs);
  if (!r.ok) return timeoutMs ? null : [];
  const counts = new Map<string, number>();
  for (const name of r.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, commits]) => ({ name, commits }));
}

export function statusFor(asset: Pick<Asset, "kind" | "path" | "frontmatterOk" | "elevated">, items: InstructionItem[]): { status: string; ok: boolean } {
  const mine = items.filter((i) => i.source === asset.path);
  const failed = mine.filter((i) => i.result === "fail").length;
  const notRun = mine.filter((i) => i.result === "not_run" && i.category === "replay").length;
  if (failed > 0) return { status: `${failed} stale ${failed === 1 ? "item" : "items"}`, ok: false };
  if (notRun > 0) return { status: `${notRun} ${notRun === 1 ? "command" : "commands"} not checked`, ok: false };
  if (asset.kind === "skill" && asset.frontmatterOk === false) return { status: "Frontmatter is missing a name or description", ok: false };
  if (asset.elevated) return { status: `Present; flagged for review: ${asset.elevated}`, ok: true };
  const replayed = mine.filter((i) => i.result === "pass" && i.category === "replay").length;
  const unchecked = mine.filter((i) => i.result === "not_run").length;
  if (replayed === 0 && unchecked > 0) return { status: `Present; ${unchecked} ${unchecked === 1 ? "command needs" : "commands need"} access the replay doesn't give, so ${unchecked === 1 ? "it wasn't" : "they weren't"} run`, ok: true };
  return { status: replayed > 0 ? "Replays" : "Present", ok: true };
}

// The sudo command is flagged, not the whole setup: a declared image can grant passwordless sudo.
function elevatedSetup(path: string): string | undefined {
  let env: { install?: unknown; start?: unknown; build?: { dockerfile?: unknown } };
  try {
    env = JSON.parse(readText(path));
  } catch {
    return undefined;
  }
  const image = typeof env.build?.dockerfile === "string" ? `inside its declared image (.cursor/${env.build.dockerfile})` : "on a machine that grants it";
  for (const field of ["install", "start"] as const) {
    if (typeof env[field] === "string" && ELEVATED.test(env[field] as string)) return `its ${field} command uses sudo, so it works only ${image}`;
  }
  return undefined;
}

export function refreshAssetStatus(assets: Asset[], items: InstructionItem[]): void {
  for (const a of assets) Object.assign(a, statusFor(a, items));
}

// Each asset's authors and last change come from git history, which `--follow` makes slow on a
// large repo. Past the scan's time bound an asset is still listed and checked, without its history.
export function inventory(repo: string, tree: string, items: InstructionItem[], bound?: ScanBound): Asset[] {
  const files = listFiles(tree, { includeHidden: true }).filter((f) => !f.startsWith(".cursor/skills/agent-readiness/"));
  const assets: Asset[] = [];
  const listed = new Set(files);
  for (const file of files) {
    const hit = KINDS.find((k) => k.re.test(file));
    if (!hit) continue;
    // A skill folder symlinked to another, such as .claude/skills -> .agents/skills, is one asset,
    // listed at the path git tracks.
    const real = inTreePath(tree, file);
    if (real !== file && real !== null && listed.has(real) && KINDS.some((k) => k.re.test(real))) continue;
    const fm = hit.kind === "skill" ? frontmatterOk(readText(join(tree, file))) : undefined;
    const elevated = hit.kind === "environment" ? elevatedSetup(join(tree, file)) : undefined;
    const { status, ok } = statusFor({ kind: hit.kind, path: file, frontmatterOk: fm, elevated }, items);
    const left = bound ? bound.until - Date.now() : undefined;
    const who = left === undefined || left > 0 ? authors(repo, file, left) : null;
    const last = who ? git(["log", "-1", "--format=%cI", "--", file], repo, bound ? Math.max(1000, bound.until - Date.now()) : undefined).stdout.trim() : "";
    if (bound) {
      bound.scope.assetHistory.total++;
      if (who) bound.scope.assetHistory.read++;
    }
    assets.push({ kind: hit.kind, path: file, authors: who ?? [], lastChanged: last ? last.slice(0, 10) : null, status, ok, frontmatterOk: fm, ...(elevated ? { elevated } : {}) });
  }
  return assets;
}

export function missingAssets(assets: Asset[]): string[] {
  const missing: string[] = [];
  if (!assets.some((a) => a.kind === "agents_md")) missing.push("an AGENTS.md");
  if (!assets.some((a) => a.kind === "environment")) missing.push("an environment setup");
  if (!assets.some((a) => a.kind === "skill")) missing.push("skills");
  if (!assets.some((a) => a.kind === "hooks")) missing.push("hooks");
  return missing;
}

export interface OrgBuilder {
  name: string;
  skillsWritten: number;
  recentCommits: number;
  repos: string[];
}

export interface OrgReport {
  owner: string;
  label: string;
  reposScanned: number;
  skillFiles: number;
  capped: boolean;
  builders: OrgBuilder[];
}

interface SearchItem {
  path: string;
  repository: { full_name: string };
}

interface CommitItem {
  commit: { author: { name: string; date: string } };
  author: { login: string } | null;
}

export function orgSkillBuilders(owner: string, maxRepos = 200): OrgReport {
  const files: SearchItem[] = [];
  for (const query of [`org:${owner} filename:SKILL.md`, `org:${owner} path:.cursor/rules`]) {
    for (let page = 1; page <= 10; page++) {
      const res = ghJson<{ items: SearchItem[] }>(["api", "-X", "GET", "search/code", "-f", `q=${query}`, "-f", "per_page=100", "-f", `page=${page}`]);
      files.push(...res.items);
      if (res.items.length < 100) break;
    }
  }
  const repos = [...new Set(files.map((f) => f.repository.full_name))];
  const capped = repos.length > maxRepos;
  const allowed = new Set(repos.slice(0, maxRepos));
  const since = addDays(today(), -90);
  const builders = new Map<string, OrgBuilder>();
  const skillFiles = files.filter((f) => allowed.has(f.repository.full_name) && f.path.endsWith("SKILL.md"));
  for (const f of skillFiles) {
    const commits = ghJson<CommitItem[]>(["api", "-X", "GET", `repos/${f.repository.full_name}/commits`, "-f", `path=${f.path}`, "-f", "per_page=100"]);
    if (commits.length === 0) continue;
    const first = commits[commits.length - 1];
    const creator = first.author?.login ?? first.commit.author.name;
    for (const c of commits) {
      const who = c.author?.login ?? c.commit.author.name;
      const b = builders.get(who) ?? { name: who, skillsWritten: 0, recentCommits: 0, repos: [] };
      if (c.commit.author.date.slice(0, 10) >= since) b.recentCommits++;
      if (!b.repos.includes(f.repository.full_name)) b.repos.push(f.repository.full_name);
      builders.set(who, b);
    }
    const cb = builders.get(creator);
    if (cb) cb.skillsWritten++;
  }
  const top = [...builders.values()].sort((a, b) => b.skillsWritten - a.skillsWritten || b.recentCommits - a.recentCommits || a.name.localeCompare(b.name)).slice(0, 10);
  return { owner, label: "GitHub-visible repos only", reposScanned: allowed.size, skillFiles: skillFiles.length, capped, builders: top };
}
