import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A repo-controlled path, refused when it or a symlink along it leaves the tree. The repo's own
// files decide these paths, and tar and git keep symlinks, so the check follows links.
export function containedPath(root: string, parts: string[], what: string): string {
  const base = existsSync(root) ? realpathSync(root) : resolve(root);
  const lexical = resolve(base, ...parts);
  const real = existsSync(lexical) ? realpathSync(lexical) : lexical;
  const out = (p: string) => {
    const rel = relative(base, p);
    return rel.startsWith("..") || isAbsolute(rel);
  };
  if (parts.some((x) => isAbsolute(x)) || out(lexical) || out(real)) fail(`${what} points outside the repository (${join(...parts)}), which the audit refuses.`);
  return real;
}

// Emoji, flags and the variation selector that turns a symbol into one. Reports, narration and
// CLI output show status in words or SVG shapes instead.
export const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{20E3}]/u;

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function writeText(path: string, text: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, text);
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function exists(path: string): boolean {
  return existsSync(path);
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function nowIso(): string {
  const fixed = process.env.SA_READINESS_NOW;
  if (fixed) return new Date(fixed).toISOString();
  return new Date().toISOString();
}

export function today(): string {
  return nowIso().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate.length === 10 ? isoDate + "T00:00:00Z" : isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}

export function fmtShortDate(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 100);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function git(args: string[], cwd: string, timeoutMs?: number): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...(timeoutMs ? { timeout: Math.max(1, timeoutMs) } : {}) });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function gitOrThrow(args: string[], cwd: string): string {
  const r = git(args, cwd);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

const SKIP_DIRS = new Set([".git", "node_modules", ".agent-readiness", ".venv", "venv", "__pycache__", "dist", "build", "coverage"]);

export const MAX_FILES = 50000;

export function listFiles(root: string, opts: { includeHidden?: boolean; maxFiles?: number } = {}): string[] {
  const out: string[] = [];
  const max = opts.maxFiles ?? MAX_FILES;
  const walk = (dir: string) => {
    if (out.length >= max) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(relative(root, full));
      if (out.length >= max) return;
    }
  };
  walk(root);
  return out;
}

// A repo-wide step names "the repo" in prose, and its commands take no --component.
export function fill(template: string, vars: Record<string, string | number>): string {
  const out = template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
  return vars.component === "the repo" ? out.replace(/ --component the repo\b/g, "") : out;
}

export function fail(message: string, code = 1): never {
  const err = new Error(message) as Error & { exitCode: number };
  err.exitCode = code;
  throw err;
}

export function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// The file's path with every symlink resolved, relative to the tree, or null when it leaves the tree.
export function inTreePath(tree: string, file: string): string | null {
  try {
    const rel = relative(realpathSync(tree), realpathSync(join(tree, file)));
    return rel.startsWith("..") || isAbsolute(rel) ? null : rel.split(sep).join("/");
  } catch {
    return null;
  }
}
