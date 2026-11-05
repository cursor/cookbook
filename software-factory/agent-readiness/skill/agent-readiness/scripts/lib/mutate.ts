import { statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { Component, Language } from "./types.ts";
import { exists, git, listFiles, readText, sha256 } from "./util.ts";

export interface Site {
  file: string;
  line: number;
  operator: string;
  before: string;
  after: string;
}

const TEST_FILE = /(\.test\.|\.spec\.|(^|\/)tests?\/|(^|\/)__tests__\/|(^|\/)tests?\.(m?[jt]sx?|cjs|py)$|(^|\/)test_[^/]*\.py$|_test\.py$)/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

function insideString(line: string, index: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < index; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
  }
  return quote !== null;
}

function isCommentOrImport(trimmed: string, lang: Language): boolean {
  if (lang === "py") return trimmed.startsWith("#") || /^(import |from \S+ import )/.test(trimmed) || trimmed.startsWith('"""');
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || /^(import |export \* from|export \{[^}]*\} from)/.test(trimmed) || /require\(/.test(trimmed);
}

function firstMatch(line: string, re: RegExp): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(line))) {
    if (!insideString(line, m.index)) return m;
  }
  return null;
}

const BOUNDARY: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">" };

// Styling values no reasonable test checks, such as `margin: 0` in an inline style or a JSX
// `strokeWidth={2}`. A changed constant there is noise, not a gap in the tests.
const CSS_KEY = /\b(margin\w*|padding\w*|width|height|min(Width|Height)|max(Width|Height)|top|left|right|bottom|inset|gap|rowGap|columnGap|font(Size|Weight)|lineHeight|letterSpacing|opacity|zIndex|flex(Grow|Shrink|Basis)?|order|border\w*|outline\w*|grid(Column|Row)\w*|elevation|transition\w*|animation\w*)\s*:\s*['"]?-?\d/;
const JSX_PRESENTATION = /\b(style|sx|className|width|height|size|strokeWidth|spacing|elevation|tabIndex|rows|cols)=\{\s*\{?[^}]*\d/;

export function cosmetic(line: string): boolean {
  return CSS_KEY.test(line) || JSX_PRESENTATION.test(line) || /\bstyle=\{\{/.test(line);
}

export function sitesForLine(line: string, lang: Language): Omit<Site, "file" | "line">[] {
  const trimmed = line.trim();
  if (!trimmed || isCommentOrImport(trimmed, lang)) return [];
  const out: Omit<Site, "file" | "line">[] = [];
  const b = firstMatch(line, / (<=|>=|<|>) /);
  if (b) out.push({ operator: "boundary_flip", before: line, after: line.slice(0, b.index) + ` ${BOUNDARY[b[1]]} ` + line.slice(b.index + b[0].length) });
  if (lang === "py") {
    const m = line.match(/^(\s*)(if|elif|while) (.+):\s*$/);
    if (m) out.push({ operator: "negate_condition", before: line, after: `${m[1]}${m[2]} not (${m[3]}):` });
  } else {
    const m = firstMatch(line, /\b(if|while) \(/);
    if (m) {
      const start = m.index + m[0].length;
      let depth = 1;
      let i = start;
      for (; i < line.length && depth > 0; i++) {
        if (line[i] === "(") depth++;
        else if (line[i] === ")") depth--;
      }
      if (depth === 0) {
        const cond = line.slice(start, i - 1);
        out.push({ operator: "negate_condition", before: line, after: line.slice(0, start) + `!(${cond})` + line.slice(i - 1) });
      }
    }
  }
  const s = firstMatch(line, / ([+-]) 1(?![\d.])/);
  if (s) out.push({ operator: "shift_by_one", before: line, after: line.slice(0, s.index) + ` ${s[1] === "+" ? "-" : "+"} 1` + line.slice(s.index + s[0].length) });
  const r = lang === "py" ? firstMatch(line, /\breturn (True|False)\b/) : firstMatch(line, /\breturn (true|false)\b/);
  if (r) {
    const swapped = { true: "false", false: "true", True: "False", False: "True" }[r[1]] as string;
    out.push({ operator: "swap_return", before: line, after: line.slice(0, r.index) + `return ${swapped}` + line.slice(r.index + r[0].length) });
  }
  const indent = line.match(/^\s*/)?.[0] ?? "";
  if (lang === "py") {
    if (/^raise\b/.test(trimmed)) out.push({ operator: "drop_throw_or_return", before: line, after: `${indent}pass` });
  } else if (/^throw\b.*;\s*$/.test(trimmed) || /^return;\s*$/.test(trimmed)) {
    out.push({ operator: "drop_throw_or_return", before: line, after: `${indent}void 0;` });
  }
  const c = firstMatch(line, /(?<![\w.$])(\d+)(?![\w.])/);
  if (c && !/^\s*(case |default)/.test(line) && !cosmetic(line)) {
    const n = Number(c[1]);
    if (Number.isSafeInteger(n)) out.push({ operator: "change_constant", before: line, after: line.slice(0, c.index) + String(n + 1) + line.slice(c.index + c[0].length) });
  }
  return out;
}

const JS_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// `import "../store"` can name a folder, which resolves to its index file.
export function resolveJs(tree: string, fromFile: string, spec: string): string | null {
  const base = normalize(join(dirname(fromFile), spec)).replace(/\/$/, "");
  const candidates = [base, ...JS_EXT.map((e) => base + e), base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), ...JS_EXT.map((e) => `${base}/index${e}`)];
  for (const c of candidates) if (isFile(join(tree, c))) return c;
  return null;
}

function resolvePy(tree: string, comp: Component, fromFile: string, mod: string): string | null {
  const rel = mod.startsWith(".") ? normalize(join(dirname(fromFile), mod.replace(/^\.+/, "").replace(/\./g, "/"))) : mod.replace(/\./g, "/");
  const roots = mod.startsWith(".") ? [""] : [comp.path === "." ? "" : comp.path, join(comp.path === "." ? "" : comp.path, "src")];
  for (const root of roots) {
    for (const cand of [join(root, rel + ".py"), join(root, rel, "__init__.py")]) if (isFile(join(tree, cand))) return cand;
  }
  return null;
}

export function targetFiles(tree: string, comp: Component): string[] {
  const all = listFiles(tree).filter((f) => comp.path === "." || f.startsWith(comp.path + "/"));
  const lang = comp.language;
  const tests = all.filter((f) => isTestFile(f) && (lang === "py" ? f.endsWith(".py") : /\.(ts|tsx|js|mjs|cjs|mts|cts)$/.test(f)));
  const targets = new Set<string>();
  for (const t of tests) {
    const text = readText(join(tree, t));
    if (lang === "py") {
      for (const m of text.matchAll(/^\s*(?:from\s+(\S+)\s+import|import\s+([\w.]+))/gm)) {
        const f = resolvePy(tree, comp, t, m[1] ?? m[2]);
        if (f && !isTestFile(f)) targets.add(f);
      }
    } else {
      for (const m of text.matchAll(/(?:from\s*|import\s*\(\s*|require\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const f = resolveJs(tree, t, m[1]);
        if (f && !isTestFile(f) && !f.includes("node_modules")) targets.add(f);
      }
    }
  }
  return [...targets].sort();
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededRandom(seed: string, salt: string): () => number {
  return mulberry32(parseInt(sha256(seed + ":" + salt).slice(0, 8), 16));
}

export function allSites(tree: string, files: string[], lang: Language): Site[] {
  const sites: Site[] = [];
  for (const file of files) {
    const lines = readText(join(tree, file)).split("\n");
    lines.forEach((line, i) => {
      for (const s of sitesForLine(line, lang)) sites.push({ file, line: i + 1, ...s });
    });
  }
  return sites;
}

export function chooseSites(repo: string, tree: string, comp: Component, seed: string, count: number): Site[] {
  const files = targetFiles(tree, comp);
  const sites = allSites(tree, files, comp.language);
  if (sites.length === 0) return [];
  const recency = new Map<string, string>();
  for (const f of files) recency.set(f, git(["log", "-1", "--format=%cI", "--", f], repo).stdout.trim());
  const sortedFiles = [...files].sort((a, b) => (recency.get(b) ?? "").localeCompare(recency.get(a) ?? "") || a.localeCompare(b));
  const recentTier = new Set(sortedFiles.slice(0, Math.max(1, Math.ceil(sortedFiles.length / 2))));
  const rand = seededRandom(seed, comp.id);
  const shuffled = sites.map((s) => ({ s, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.s);
  const tiered = [...shuffled.filter((s) => recentTier.has(s.file)), ...shuffled.filter((s) => !recentTier.has(s.file))];
  const picked: Site[] = [];
  const usedLines = new Set<string>();
  for (const s of tiered) {
    if (picked.length >= count) break;
    const key = `${s.file}:${s.line}`;
    if (usedLines.has(key)) continue;
    usedLines.add(key);
    picked.push(s);
  }
  for (const s of tiered) {
    if (picked.length >= count) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked;
}

export function applySite(text: string, site: Site): string {
  const lines = text.split("\n");
  if (lines[site.line - 1] !== site.before) throw new Error(`Line ${site.line} of ${site.file} changed since the site was chosen`);
  lines[site.line - 1] = site.after;
  return lines.join("\n");
}
