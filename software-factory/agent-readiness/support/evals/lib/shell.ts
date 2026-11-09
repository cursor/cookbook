import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { protectedFiles } from "./protected.ts";

// Just enough of a shell parser to tell which program each part of an agent's command runs, so
// the trajectory gate judges programs rather than words. It follows the shell functions and
// variables a command defines (see expand()), but not globs or other expansions.

export interface Segment {
  words: string[];
  // Targets of output redirects (`>`, `>>`, `&>`), so a read-only program that writes a file isn't benign.
  writes: string[];
  // The operators before and after this simple command: "start", "end", ";", "&&", "|", "(", "\n" and
  // so on, or "$(" inside a command substitution. They tell whether a definition always takes effect.
  sep: string;
  end: string;
}

const OPERATORS = ["&&", "||", ";;", ";", "|&", "|", "&", "\n", "(", ")"];

// macOS reaches the temp folder through /private/var, so paths are compared once links resolve.
export function real(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur) && dirname(cur) !== cur) {
    tail.unshift(basename(cur));
    cur = dirname(cur);
  }
  return join(realpathSync(cur), ...tail);
}

export function within(dir: string, p: string): boolean {
  const rel = relative(real(dir), real(p));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export function inTemp(p: string): boolean {
  return [tmpdir(), "/tmp"].some((d) => existsSync(d) && within(d, p));
}

function closing(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === "'" && open !== "`") {
      const end = text.indexOf("'", i + 1);
      i = end < 0 ? text.length : end;
    } else if (ch === open && open !== close) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return text.length;
}

// Splits a command line into simple commands. Command substitutions (`$(...)`, backticks) become
// segments of their own, heredoc bodies are dropped, and unquoted `#` starts a comment.
export function segments(cmd: string): Segment[] {
  const out: Segment[] = [];
  let words: string[] = [];
  let writes: string[] = [];
  let word = "";
  let inWord = false;
  let redirect: "write" | "read" | null = null;
  const heredocs: string[] = [];
  let lastOp = "start";
  const endWord = () => {
    if (!inWord) return;
    if (redirect === "write") writes.push(word);
    else if (redirect !== "read") words.push(word);
    redirect = null;
    word = "";
    inWord = false;
  };
  const endSegment = (op: string) => {
    endWord();
    if (words.length || writes.length) out.push({ words, writes, sep: lastOp, end: op });
    words = [];
    writes = [];
    lastOp = op;
  };
  const sub = (inner: string) => out.push(...segments(inner).map((x) => ({ ...x, sep: "$(", end: "$(" })));
  // `$(pwd)` stays recognisable so a CLI path built from it still resolves; other substitutions don't.
  const substitution = (inner: string) => {
    sub(inner);
    const t = inner.trim();
    if (/^mktemp(\s|$)/.test(t)) return `$(mktemp:${Buffer.from(t).toString("base64url")})`;
    const abs = t.match(/^(?:realpath|readlink -f)\s+(\S+)$/);
    if (abs) return `$(abs:${Buffer.from(abs[1].replace(/^(['"])(.*)\1$/, "$2")).toString("base64url")})`;
    return t === "pwd" ? "$(pwd)" : t === "git rev-parse --show-toplevel" ? "$(toplevel)" : "$(...)";
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "\\" && i + 1 < cmd.length) {
      if (cmd[i + 1] !== "\n") word += cmd[i + 1];
      inWord = true;
      i++;
      continue;
    }
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      word += cmd.slice(i + 1, end < 0 ? cmd.length : end);
      inWord = true;
      i = end < 0 ? cmd.length : end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === "\\" && j + 1 < cmd.length) {
          word += cmd[++j];
        } else if (cmd[j] === "$" && cmd[j + 1] === "(") {
          const end = closing(cmd, j + 2, "(", ")");
          word += substitution(cmd.slice(j + 2, end));
          j = end;
        } else if (cmd[j] === "`") {
          const end = closing(cmd, j + 1, "`", "`");
          sub(cmd.slice(j + 1, end));
          word += "`...`";
          j = end;
        } else word += cmd[j];
      }
      inWord = true;
      i = j;
      continue;
    }
    if (ch === "$" && cmd[i + 1] === "(") {
      const end = closing(cmd, i + 2, "(", ")");
      word += substitution(cmd.slice(i + 2, end));
      inWord = true;
      i = end;
      continue;
    }
    if (ch === "`") {
      const end = closing(cmd, i + 1, "`", "`");
      sub(cmd.slice(i + 1, end));
      word += "`...`";
      inWord = true;
      i = end;
      continue;
    }
    if (ch === "#" && !inWord) {
      const nl = cmd.indexOf("\n", i);
      i = (nl < 0 ? cmd.length : nl) - 1;
      continue;
    }
    if (ch === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      endWord();
      const m = cmd.slice(i + 2).match(/^-?\s*(['"]?)(\w+)\1/);
      if (m) {
        heredocs.push(m[2]);
        i += 1 + m[0].length;
        continue;
      }
    }
    if (ch === ">" || ch === "<" || (ch === "&" && cmd[i + 1] === ">")) {
      // `2>&1` and `>&2` duplicate a descriptor; anything else names a file.
      const fd = inWord && /^\d+$/.test(word);
      if (fd) {
        word = "";
        inWord = false;
      } else endWord();
      let j = i + (ch === "&" ? 2 : 1);
      if (cmd[j] === ">" && ch !== "<") j++;
      if (cmd[j] === "&") {
        const m = cmd.slice(j + 1).match(/^\s*(\d+|-)/);
        i = j + (m ? m[0].length : 0);
        continue;
      }
      redirect = ch === "<" ? "read" : "write";
      i = j - 1;
      continue;
    }
    const op = OPERATORS.find((o) => cmd.startsWith(o, i));
    if (op) {
      endSegment(op);
      if (op === "\n" && heredocs.length) {
        for (const tag of heredocs.splice(0)) {
          const rest = cmd.slice(i + 1);
          const m = rest.match(new RegExp(`(^|\\n)\\t*${tag}[ \\t]*(\\n|$)`));
          i = m ? i + 1 + m.index! + m[0].length - 1 : cmd.length;
        }
      } else i += op.length - 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    word += ch;
    inWord = true;
  }
  endSegment("end");
  return out;
}

const WRAPPERS = new Set(["time", "nohup", "command", "exec", "builtin", "nice", "sudo", "doas", "xargs", "stdbuf", "caffeinate"]);

// The program a simple command runs, past variable assignments and wrappers such as env and timeout.
export function program(words: string[]): string[] {
  let w = [...words];
  for (;;) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    if (!w.length) return w;
    const p = basename(w[0]);
    if (p === "env") {
      w = w.slice(1);
      while (w.length && (w[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]))) w = w.slice(w[0] === "-u" || w[0] === "-C" ? 2 : 1);
    } else if (p === "timeout") {
      w = w.slice(1);
      while (w.length && w[0].startsWith("-")) w = w.slice(/^-(s|k)$|^--(signal|kill-after)$/.test(w[0]) ? 2 : 1);
      w = w.slice(1);
    } else if (WRAPPERS.has(p)) {
      w = w.slice(1);
      while (w.length && w[0].startsWith("-")) w = w.slice(1);
    } else return w;
  }
}

export interface Context {
  // The repository the agent works in, and the directory the command runs from.
  repo: string;
  cwd: string;
  // Shell functions and variables defined by earlier commands in the same shell session.
  defs?: Definitions;
}

// Shell functions and variables an agent defines, in the order its commands define them. A name
// mapped to null was defined in a way this parser can't follow (inside a condition or subshell
// over an earlier value, from a command substitution, or by sourcing an unknown file), so nothing
// that runs through it counts as a CLI call.
export interface Definitions {
  functions: Map<string, string | null>;
  vars: Map<string, string | null>;
  // Links made with `ln`: the link's absolute path to what it points at, so a write through a link
  // made earlier and removed since still lands where the link pointed.
  links: Map<string, string>;
}

export function emptyDefinitions(): Definitions {
  return { functions: new Map(), vars: new Map(), links: new Map() };
}

function copyDefinitions(d: Definitions | undefined): Definitions {
  return { functions: new Map(d?.functions), vars: new Map(d?.vars), links: new Map(d?.links) };
}

const NAME = String.raw`[A-Za-z_][\w:.-]*`;
const FUNCTION_HEAD = new RegExp(String.raw`^(?:function\s+(${NAME})\s*(?:\(\s*\))?|(${NAME})\s*\(\s*\))\s*`);

// The end of a `{ ... }` body that starts after `open`, skipping quotes and `${...}`.
function bodyEnd(text: string, open: number): number {
  let depth = 1;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === "'") i = Math.max(i, text.indexOf("'", i + 1));
    else if (ch === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (ch === "$" && text[i + 1] === "{") {
      depth++;
      i++;
    } else if (ch === "{" && /[\s;&|(]/.test(text[i - 1] ?? " ") && /\s/.test(text[i + 1] ?? " ")) depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

// Replaces each function definition at the start of a command with a placeholder word, so the
// definition keeps its place in the command's order. A `name()` this can't read taints the name.
function extractFunctions(cmd: string): { text: string; bodies: string[] } {
  const bodies: string[] = [];
  let out = "";
  let quote: string | null = null;
  const heredocs: string[] = [];
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    // A heredoc body is data: copied as is, so its quotes and any `name()` in it change nothing.
    if (!quote && ch === "\n" && heredocs.length) {
      out += ch;
      for (const tag of heredocs.splice(0)) {
        const m = cmd.slice(i + 1).match(new RegExp(`(^|\\n)\\t*${tag}[ \\t]*(?=\\n|$)`));
        const end = m ? i + 1 + m.index! + m[0].length : cmd.length;
        out += cmd.slice(i + 1, end);
        i = end - 1;
      }
      continue;
    }
    if (!quote && ch === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      const m = cmd.slice(i + 2).match(/^-?\s*(['"]?)(\w+)\1/);
      if (m) {
        heredocs.push(m[2]);
        out += cmd.slice(i, i + 2 + m[0].length);
        i += 1 + m[0].length;
        continue;
      }
    }
    if (quote) {
      out += ch;
      if (ch === "\\" && quote === '"') out += cmd[++i] ?? "";
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    const before = out.trimEnd();
    const atStart = (before === "" || /[;&|\n(){]$/.test(before) || /\n[ \t]*$/.test(out) || /(^|\s)(then|do|else|elif)$/.test(before)) && /[\s;&|\n(){]$|^$/.test(out);
    const m = atStart && /\S/.test(ch) ? cmd.slice(i).match(FUNCTION_HEAD) : null;
    if (m) {
      const name = m[1] ?? m[2];
      const open = i + m[0].length;
      const end = cmd[open] === "{" ? bodyEnd(cmd, open) : -1;
      if (end > 0) {
        bodies.push(`${name}\0${cmd.slice(open + 1, end)}`);
        out += ` __readiness_fn_${bodies.length - 1}__ `;
        i = end;
      } else {
        out += ` __readiness_taint_${name}__ `;
        i += m[0].length - 1;
      }
      continue;
    }
    out += ch;
  }
  return { text: out, bodies };
}

const OPENERS = new Set(["if", "while", "until", "for", "case", "select", "{"]);
const LOOP_HEADERS = new Set(["for", "select", "case"]);
const MIDDLES = new Set(["then", "do", "else", "elif", "!"]);
const CLOSERS = new Set(["fi", "done", "esac", "}"]);
const DECLARE = new Set(["export", "local", "declare", "typeset", "readonly"]);
// Files an agent sources to set up its shell; they define no wrapper the gate needs to follow.
const SETUP_SOURCES = /(^|\/)(eval\.env|nvm\.sh|activate|\.bashrc|\.bash_profile|\.profile|\.zshrc|\.zprofile)$/;
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

// A definition that may not have run (inside a condition, after `&&` or `||`, in a subshell or a
// pipeline) keeps a new name, since an unset name runs nothing, but taints one that had a value.
function setDefinition(map: Map<string, string | null>, name: string, value: string | null, certain: boolean): void {
  if (certain || value === null) map.set(name, value);
  else if (!map.has(name)) map.set(name, /^node(js)?$/.test(name) ? null : value);
  else if (map.get(name) !== value) map.set(name, null);
}

// `$(pwd)`, `$(git rev-parse --show-toplevel)` and `$(realpath X)` in a value, which agents use to
// build the CLI's path, as the paths they print.
function pathMarkers(value: string, repo: string, cwd: string): string {
  return value
    .replace(/\$\(pwd\)/g, cwd)
    .replace(/\$\(toplevel\)/g, repo)
    .replace(/\$\(abs:([\w-]*)\)/g, (m, b64: string) => {
      const p = Buffer.from(b64, "base64url").toString();
      return /\$|`/.test(p) ? m : resolve(cwd, p);
    });
}

// A variable's value where the command runs: a session definition, or for the few the agent's
// shell inherits from the eval worker, the worker's own value. undefined when it's unknown.
function lookup(name: string, defs: Definitions, cwd: string): string | null | undefined {
  if (defs.vars.has(name)) return defs.vars.get(name);
  if (name === "PWD") return cwd;
  if (name === "TMPDIR") return process.env.TMPDIR || tmpdir();
  if (name === "HOME") return process.env.HOME;
  return undefined;
}

// Where `mktemp` would create its file or folder, or null when that depends on something unknown.
function mktempPath(words: string[], defs: Definitions, cwd: string): string | null {
  let dir: string | null | undefined;
  let template: string | undefined;
  let relativeToTmp = false;
  for (let i = 1; i < words.length; i++) {
    const a = words[i];
    if (a === "-p" || a === "--tmpdir") dir = words[++i] ?? null;
    else if (a.startsWith("--tmpdir=")) dir = a.slice(9);
    else if (/^-p./.test(a)) dir = a.slice(2);
    else if (a === "-t") relativeToTmp = true;
    else if (a === "--suffix") i++;
    else if (!a.startsWith("-")) template = a;
  }
  const tmp = lookup("TMPDIR", defs, cwd);
  if (dir === undefined) dir = template ? (template.includes("/") ? dirname(template) : relativeToTmp ? tmp : cwd) : tmp;
  if (typeof dir !== "string" || /\$|`/.test(dir)) return null;
  return join(isAbsolute(dir) ? dir : resolve(cwd, dir), "mktemp.XXXXXX");
}

function expandVars(word: string, defs: Definitions, cwd: string): string[] {
  const marker = word.replace(/\$\(mktemp:([\w-]*)\)/g, (m, b64: string) => mktempPath(segments(Buffer.from(b64, "base64url").toString())[0]?.words.flatMap((x) => expandVars(x, defs, cwd)) ?? [], defs, cwd) ?? m);
  const exact = marker.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  if (exact) {
    const v = lookup(exact[1], defs, cwd);
    if (typeof v === "string") return segments(v)[0]?.words ?? [];
    return [marker];
  }
  return [marker.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, n: string) => {
    const v = lookup(n, defs, cwd);
    return typeof v === "string" && !/\s/.test(v) ? v : m;
  })];
}

// One simple command as the shell would run it, after the functions and variables it goes through.
export interface Expanded {
  words: string[];
  // Redirect targets, with variables expanded as at this command.
  writes: string[];
  cwd: string;
  // $TMPDIR as at this command, for where `mktemp` writes; null when it can't be known.
  tmpdir: string | null;
  links: Map<string, string>;
  // The function the command came from, or null when it was typed directly.
  via: string | null;
  // False when it runs through a name whose definition couldn't be followed.
  known: boolean;
}

// `ln [-s] target [link]`: remember where the link points. A link that might not have been made
// still counts, since following it only makes the write check stricter.
function recordLink(p: string[], defs: Definitions, cwd: string): void {
  const args = p.slice(1).filter((x) => !x.startsWith("-"));
  const symbolic = p.slice(1).some((x) => /^-[a-zA-Z]*s/.test(x) || x === "--symbolic");
  if (!args.length || args.some((x) => /\$|`/.test(x))) return;
  const target = args[0];
  let link = args.length > 1 ? resolve(cwd, args[args.length - 1]) : resolve(cwd, basename(target));
  if (args.length > 1 && existsSync(link) && statSync(link).isDirectory()) link = join(link, basename(target));
  defs.links.set(link, symbolic && !isAbsolute(target) ? resolve(dirname(link), target) : resolve(cwd, target));
}

function followLinks(p: string, links: Map<string, string>): string {
  let cur = p;
  for (let n = 0; n < 8; n++) {
    const hit = [...links.keys()].sort((a, b) => b.length - a.length).find((l) => cur === l || cur.startsWith(l + "/"));
    if (!hit) return cur;
    cur = links.get(hit)! + cur.slice(hit.length);
  }
  return cur;
}

// A file that is a hard link to a protected file is that file.
function hardLinkedToProtected(repo: string, p: string): boolean {
  const st = statSync(p, { throwIfNoEntry: false });
  if (!st || !st.isFile() || st.nlink < 2) return false;
  return protectedFiles(repo).some((f) => {
    const o = statSync(join(repo, f), { throwIfNoEntry: false });
    return Boolean(o && o.ino === st.ino && o.dev === st.dev);
  });
}

// A file a call may write besides the readiness CLI's own: /dev/null and the like, or a path that
// resolves outside the repo, so it can't be a protected file. $TMPDIR, /tmp and mktemp's files are
// the usual ones. Anything left unexpanded, inside the repo, or reached through a link into it
// doesn't qualify.
export function writesOutsideRepo(target: string, c: { cwd: string; links: Map<string, string> }, repo: string): boolean {
  if (/^\/dev\/(null|stdout|stderr)$/.test(target)) return true;
  if (/\$|`/.test(target)) return false;
  const full = real(followLinks(at({ repo, cwd: c.cwd }, target), c.links));
  return !within(repo, full) && !hardLinkedToProtected(repo, full);
}

function walk(segs: Segment[], bodies: string[], ctx: Context, defs: Definitions, via: string | null, args: string[] | null, depth: number): Expanded[] {
  const out: Expanded[] = [];
  let cwd = ctx.cwd;
  let oldCwd = ctx.cwd;
  const pushed: string[] = [];
  // A subshell's `cd` ends with it. segments() marks the last command inside "( ... )" with end ")".
  const subshells: string[] = [];
  // Assignments that certainly hold for the rest of an unbroken `a && R=x && b && $R` run: if
  // anything before R=x fails, the run stops before $R, and R=x itself can't fail.
  const chain = new Map<string, string>();
  let nest = 0;
  let parens = 0;
  for (const s of segs) {
    if (s.sep === "(") {
      parens++;
      subshells.push(cwd);
    }
    try {
      let w = [...s.words];
      let header: string | null = null;
      for (;;) {
        if (OPENERS.has(w[0])) {
          nest++;
          if (LOOP_HEADERS.has(w[0])) header = w[0];
        } else if (CLOSERS.has(w[0])) nest = Math.max(0, nest - 1);
        else if (!MIDDLES.has(w[0])) break;
        w = w.slice(1);
      }
      if (s.sep !== "&&" || nest > 0 || parens > 0) chain.clear();
      if (!w.length) continue;
      // `for p in a b c`, `select p in ...` and `case $x in` name a variable or a word, not a
      // command; the loop variable's value is unknown. The body's commands are judged one by one.
      if (header) {
        if (header !== "case" && /^[A-Za-z_]\w*$/.test(w[0])) defs.vars.set(w[0], null);
        continue;
      }
      const certain = nest === 0 && parens === 0 && ["start", ";", "\n", ";;"].includes(s.sep) && !["|", "|&", "&", "("].includes(s.end);
      const view: Definitions = chain.size ? { ...defs, vars: new Map([...defs.vars, ...chain]) } : defs;
      const fn = w[0].match(/^__readiness_fn_(\d+)__$/);
      if (fn) {
        const [name, body] = bodies[Number(fn[1])].split("\0");
        setDefinition(defs.functions, name, body, certain);
        continue;
      }
      const taint = w[0].match(/^__readiness_taint_(.+)__$/);
      if (taint) {
        defs.functions.set(taint[1], null);
        continue;
      }
      if (args) w = w.flatMap((x) => (x === "$@" || x === "$*" ? args : [x.replace(/\$\{?([1-9])\}?/g, (_m, n: string) => args[Number(n) - 1] ?? "")]));
      w = w.flatMap((x) => expandVars(x, view, cwd));
      const writes = s.writes.map((x) => expandVars(x, view, cwd).join(" "));
      const here = () => ({ writes, cwd, tmpdir: typeof lookup("TMPDIR", view, cwd) === "string" ? (lookup("TMPDIR", view, cwd) as string) : null, links: new Map(defs.links) });
      const decl = DECLARE.has(w[0]) ? w.slice(1).filter((x) => !x.startsWith("-")) : w;
      if (decl.length && decl.every((x) => ASSIGN.test(x))) {
        for (const x of decl) {
          const [, name, value] = x.match(ASSIGN)!;
          const v = pathMarkers(value, ctx.repo, cwd);
          const known = /\$\(|`|\$\{?[A-Za-z_]/.test(v) ? null : v;
          setDefinition(defs.vars, name, known, certain);
          if (known !== null && s.sep === "&&" && s.end === "&&" && nest === 0 && parens === 0) chain.set(name, known);
          else chain.delete(name);
        }
        continue;
      }
      if (DECLARE.has(w[0])) continue;
      if (w[0] === "unset") {
        const which = w.includes("-f") ? [defs.functions] : w.includes("-v") ? [defs.vars] : [defs.vars, defs.functions];
        for (const name of w.slice(1).filter((x) => !x.startsWith("-"))) for (const m of which) certain ? m.delete(name) : m.set(name, null);
        continue;
      }
      if ((w[0] === "source" || w[0] === ".") && !SETUP_SOURCES.test(w[1] ?? "")) {
        for (const m of [defs.functions, defs.vars]) for (const k of m.keys()) m.set(k, null);
      }
      const p = program(w);
      if (p[0] === "ln") recordLink(p, defs, cwd);
      if (["cd", "pushd", "popd"].includes(p[0])) {
        // A command substitution runs in a subshell, so its `cd` doesn't move the command around it.
        if (s.sep !== "$(") {
          const dir = p.slice(1).find((x) => !/^-[LPe@]$/.test(x));
          const home = process.env.HOME ?? "/";
          let next: string | null = null;
          if (p[0] === "popd") next = pushed.pop() ?? null;
          else if (dir === undefined || dir === "~") next = p[0] === "cd" ? home : null;
          else if (dir === "-" || /^\$\{?OLDPWD\}?$/.test(dir)) next = oldCwd;
          else if (!/^\$\{?[A-Za-z_]/.test(dir)) next = at({ ...ctx, cwd }, dir.replace(/^~(?=\/)/, home));
          if (next !== null) {
            if (p[0] === "pushd") pushed.push(cwd);
            oldCwd = cwd;
            cwd = next;
          }
        }
        out.push({ words: w, ...here(), cwd, via, known: true });
        continue;
      }
      if (p.length && defs.functions.has(p[0])) {
        const body = defs.functions.get(p[0]);
        if (body === null || body === undefined || depth >= 4) {
          out.push({ words: w, ...here(), via, known: false });
          continue;
        }
        const inner = extractFunctions(body);
        const calls = walk(segments(inner.text), inner.bodies, { ...ctx, cwd }, defs, `function ${p[0]}`, p.slice(1), depth + 1);
        out.push(...calls.map((c) => ({ ...c, writes: [...c.writes, ...writes] })));
        continue;
      }
      // A variable still unexpanded here is unset, tainted or built at run time: nothing to follow.
      out.push({ words: w, ...here(), via, known: !(p.length > 0 && /^\$\{?[A-Za-z_]/.test(p[0])) });
    } finally {
      if (s.end === ")" && subshells.length) {
        parens = Math.max(0, parens - 1);
        cwd = subshells.pop()!;
      }
    }
  }
  return out;
}

// Splits `cmd` into the simple commands it runs, following the functions and variables it and
// ctx.defs define, and returns the definitions in effect after it. ctx.defs isn't changed.
export function expand(cmd: string, ctx: Context): { calls: Expanded[]; defs: Definitions } {
  const defs = copyDefinitions(ctx.defs);
  const { text, bodies } = extractFunctions(cmd);
  return { calls: walk(segments(text), bodies, ctx, defs, null, null, 0), defs };
}

// The definitions in effect before each command of a session, oldest first. A persistent shell
// keeps functions and variables between tool calls; a fresh one has none, so following them is
// at worst too generous to a wrapper that would have failed to run.
export function sessionDefinitions(commands: (string | null)[], ctx: Context): Definitions[] {
  let defs = copyDefinitions(ctx.defs);
  return commands.map((cmd) => {
    const before = defs;
    if (cmd) defs = expand(cmd, { ...ctx, defs }).defs;
    return before;
  });
}

export const CLI_PATH = ".cursor/skills/agent-readiness/scripts/readiness.ts";
// Node flags that only change how the CLI is parsed; anything else (--import, --require, -e) could run other code.
const CLI_NODE_FLAGS = /^--(experimental-strip-types|experimental-transform-types|no-warnings|disable-warning(=\S+)?|max-old-space-size=\d+|enable-source-maps)$/;

function at(ctx: Context, p: string): string {
  const q = p.replace(/^(\$\(pwd\)|\$\{PWD\}|\$PWD)(?=\/|$)/, ctx.cwd).replace(/^\$\(toplevel\)(?=\/|$)/, ctx.repo);
  return isAbsolute(q) ? q : resolve(ctx.cwd, q);
}

function inRepo(ctx: Context, p: string): boolean {
  return within(ctx.repo, at(ctx, p));
}

// `node <flags> <repo>/.cursor/skills/agent-readiness/scripts/readiness.ts ...`, matched on the
// script path the repo installs, not on the word "readiness" anywhere in the line.
export function isCliCall(words: string[], ctx: Context): boolean {
  const w = program(words);
  if (!w.length || !/^node(js)?$/.test(basename(w[0]))) return false;
  let i = 1;
  while (i < w.length && CLI_NODE_FLAGS.test(w[i])) i++;
  if (i >= w.length || w[i].startsWith("-")) return false;
  return real(at(ctx, w[i])) === real(join(ctx.repo, CLI_PATH));
}

const NPM_RUNS = new Set(["test", "t", "tst", "run", "run-script", "rum", "urn", "start", "stop", "restart", "ci", "clean-install", "install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isntal", "isntall", "add", "it", "cit", "install-test", "install-ci-test", "clean-install-test", "exec", "x", "rebuild", "rb", "explore", "pack", "publish"]);
const PM_HARMLESS = new Set(["--version", "-v", "-V", "--help", "-h", "help", "info", "view", "why", "list", "ls", "config", "outdated", "audit", "store", "bin", "root", "licenses", "env"]);
const RUNNERS = new Set(["npx", "pnpx", "bunx", "pytest", "py.test", "tox", "nox", "make", "gmake", "tsc", "vitest", "jest", "mocha", "ava", "tap", "playwright", "cypress", "eslint", "biome", "prettier", "ruff", "mypy", "pyright", "flake8", "black", "rspec", "phpunit", "rake", "gradle", "gradlew", "mvn", "mvnw", "turbo", "nx", "lerna", "tsx", "ts-node", "jasmine", "karma", "nodemon"]);
const BUILD_SUBS = new Set(["test", "run", "build", "bench", "generate", "vet", "check", "exec", "task", "install", "sync", "compile"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const PYTHON = /^python(\d+(\.\d+)*)?$/;

function firstArg(w: string[], from = 1): string | undefined {
  return w.slice(from).find((x) => !x.startsWith("-"));
}

// Does `node -e` code load a module from the repo? Relative specifiers resolve from the directory
// node runs in, so they count only when that is inside the repo, and a .json file is data, not code.
function evalLoadsRepoCode(code: string, ctx: Context): boolean {
  if (code.includes(ctx.repo)) return true;
  const specs = [...code.matchAll(/(?:require|import)\s*\(\s*['"`](\.{0,2}\/[^'"`]*)|from\s+['"`](\.{1,2}\/[^'"`]*)/g)].map((m) => m[1] ?? m[2]);
  return specs.some((spec) => !/\.json$/.test(spec) && within(ctx.repo, resolve(ctx.cwd, spec)));
}

// Why a simple command runs the repo's code (install, build, tests or a repo script) outside the
// readiness scripts, or null when it doesn't.
export function repoEvidence(words: string[], ctx: Context): string | null {
  const w = program(words);
  if (!w.length || isCliCall(w, ctx)) return null;
  const p = basename(w[0]);
  const line = w.join(" ");
  if (/^node(js)?$/.test(p)) {
    for (let i = 1; i < w.length; i++) {
      const a = w[i];
      if (a === "--test" || a.startsWith("--test=")) return line;
      if (["-e", "--eval", "-p", "--print"].includes(a)) return evalLoadsRepoCode(w[i + 1] ?? "", ctx) ? line : null;
      if (["--import", "--require", "-r", "--loader", "--experimental-loader"].includes(a)) {
        if (w[i + 1] && inRepo(ctx, w[i + 1])) return line;
        i++;
        continue;
      }
      if (a.startsWith("-")) continue;
      // A script path that is still a variable here is unknown, not a repo file; if the call
      // changed the records, the protected-file rule blames it anyway.
      return !/^\$/.test(a) && inRepo(ctx, a) ? line : null;
    }
    return null;
  }
  if (p === "npm") {
    const sub = firstArg(w);
    return sub && NPM_RUNS.has(sub) ? line : null;
  }
  if (p === "pnpm" || p === "yarn" || p === "bun") {
    const sub = w[1];
    if (!sub) return p === "yarn" ? line : null;
    return PM_HARMLESS.has(sub) ? null : line;
  }
  if (p === "deno") return ["test", "run", "task", "bench", "compile", "install"].includes(w[1] ?? "") ? line : null;
  if (RUNNERS.has(p)) return line;
  if (["cargo", "go", "dotnet", "swift", "uv", "poetry", "pipenv", "pdm", "hatch", "rye", "composer", "bundle", "mix"].includes(p)) {
    const sub = firstArg(w);
    return sub && (BUILD_SUBS.has(sub) || (p === "uv" && sub === "pip")) ? line : null;
  }
  if (p === "pip" || p === "pip3") return firstArg(w) === "install" ? line : null;
  if (p === "docker" || p === "podman" || p === "docker-compose") {
    const rest = p === "docker-compose" ? w.slice(1) : w[1] === "compose" ? w.slice(2) : w.slice(1);
    const sub = firstArg(rest, 0);
    return sub && ["up", "run", "start", "build", "exec", "create"].includes(sub) ? line : null;
  }
  if (PYTHON.test(p)) {
    for (let i = 1; i < w.length; i++) {
      const a = w[i];
      if (a === "-m") return w[i + 1] === "json.tool" ? null : line;
      if (a === "-c") return /\bsys\.path\b|\bsrc\b|\btests?\b/.test(w[i + 1] ?? "") || (w[i + 1] ?? "").includes(ctx.repo) ? line : null;
      if (a.startsWith("-")) continue;
      return inRepo(ctx, a) ? line : null;
    }
    return null;
  }
  if (SHELLS.has(p)) {
    const c = w.indexOf("-c");
    if (c > 0 && w[c + 1] !== undefined) return commandEvidence(w[c + 1], ctx)[0] ?? null;
    const script = firstArg(w);
    return script && inRepo(ctx, script) ? line : null;
  }
  if (p === "eval") return commandEvidence(w.slice(1).join(" "), ctx)[0] ?? null;
  if (w[0].includes("/") && inRepo(ctx, w[0])) return line;
  return null;
}

export interface Step {
  // The readiness subcommand when this simple command calls the CLI (init, scan, seal, ...).
  cli: string | null;
  // Why it runs repo code outside the readiness scripts, when it does.
  evidence: string | null;
}

// The simple commands `cmd` runs, in order, as CLI calls or repo commands; the rest are left out.
export function commandSteps(cmd: string, ctx: Context): Step[] {
  const steps: Step[] = [];
  for (const c of expand(cmd, ctx).calls) {
    if (!c.known) continue;
    const at = { ...ctx, cwd: c.cwd };
    if (isCliCall(c.words, at)) {
      const w = program(c.words);
      steps.push({ cli: w.slice(w.findIndex((x) => x.endsWith("readiness.ts")) + 1).find((x) => !x.startsWith("-")) ?? "", evidence: null });
      continue;
    }
    const why = repoEvidence(c.words, at);
    if (why) steps.push({ cli: null, evidence: c.via ? `${why} (in ${c.via})` : why });
  }
  return steps;
}

// Each simple command in `cmd` that runs repo code outside the readiness scripts, following `cd`
// and the functions and variables it goes through.
export function commandEvidence(cmd: string, ctx: Context): string[] {
  const out: string[] = [];
  for (const c of expand(cmd, ctx).calls) {
    if (!c.known) continue;
    const why = repoEvidence(c.words, { ...ctx, cwd: c.cwd });
    if (why) out.push(c.via ? `${why} (in ${c.via})` : why);
  }
  return out;
}

const READ_ONLY = new Set(["cd", "pushd", "popd", "source", ".", "export", "set", "unset", "read", "echo", "printf", "cat", "head", "tail", "less", "more", "ls", "pwd", "true", "false", "sleep", "wc", "grep", "egrep", "rg", "jq", "sort", "uniq", "test", "[", "which", "type", "date", "clear", "column", "cut", "tr", "basename", "dirname", "realpath", "readlink", "stat", "file", "diff", "nl", "fold", "od", "hexdump", "printenv", "whoami", "uname", "id", "hostname", "du", "df", "tree", "cmp", "comm", "paste", "expand", "rev", "seq", "md5", "md5sum", "shasum", "sha256sum"]);
const DOCKER_READS = new Set(["info", "version", "ps", "images", "inspect", "context", "--version", "-v"]);
const VERSION_QUERY = /^(--version|-v|-V|version)$/;
const FIND_ACTIONS = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;
// sed's w and W commands and the s///w flag write a file; e and s///e run a command.
// Does a sed script write a file (w, W, s///w) or run a command (e, s///e)? It reads the script
// command by command, so text inside an s command's pattern or replacement is never a command.
// A script it can't read counts as writing.
export function sedScriptWrites(script: string): boolean {
  let i = 0;
  const n = script.length;
  const spaces = () => {
    while (i < n && /[ \t]/.test(script[i])) i++;
  };
  // Reads up to an unescaped delimiter; false when there is none.
  const part = (d: string): boolean => {
    while (i < n && script[i] !== d) {
      if (script[i] === "\\") i++;
      if (script[i] === "\n" && d !== "\n") return false;
      i++;
    }
    if (i >= n) return false;
    i++;
    return true;
  };
  const address = (): boolean => {
    if (/\d/.test(script[i] ?? "")) {
      while (i < n && /[\d~+]/.test(script[i])) i++;
    } else if (script[i] === "$") i++;
    else if (script[i] === "/" || script[i] === "\\") {
      const d = script[i] === "\\" ? script[++i] : "/";
      i++;
      if (!part(d)) return false;
      while (/[IM]/.test(script[i] ?? "")) i++;
    }
    return true;
  };
  while (i < n) {
    while (i < n && /[\s;]/.test(script[i])) i++;
    if (i >= n) break;
    if (script[i] === "}" || script[i] === "{") {
      i++;
      continue;
    }
    if (!address()) return true;
    spaces();
    if (script[i] === ",") {
      i++;
      spaces();
      if (!address()) return true;
      spaces();
    }
    if (script[i] === "!") {
      i++;
      spaces();
    }
    const cmd = script[i++];
    if (cmd === undefined) break;
    if (cmd === "{") continue;
    if (cmd === "s" || cmd === "y") {
      const d = script[i++];
      if (!d || /[\s\\]/.test(d) || !part(d) || !part(d)) return true;
      if (cmd === "s") {
        const flags = script.slice(i).match(/^[a-zA-Z0-9]*/)![0];
        if (/[we]/.test(flags)) return true;
        i += flags.length;
      }
      continue;
    }
    if (cmd === "w" || cmd === "W" || cmd === "e") return true;
    if ("aicrRbtT:#".includes(cmd)) {
      // Text, a file to read or a label: the rest of the line (a label also ends at ;).
      while (i < n && script[i] !== "\n" && !("btT:".includes(cmd) && script[i] === ";")) i++;
      continue;
    }
    if (!"pPdDnNgGhHxlqQz=F".includes(cmd)) return true;
  }
  return false;
}
// awk can run commands (system, pipes, getline from a command) and print to files.
const AWK_EFFECTS = /\bsystem\s*\(|\bprintf?\b[^;}]*(>|\|)|\|\s*getline|\|&|\bclose\s*\(/;

function isProtectedPath(repo: string, target: string, c: { cwd: string; links: Map<string, string> }): boolean {
  if (/\$|`/.test(target)) return true;
  const full = real(followLinks(at({ repo, cwd: c.cwd }, target), c.links));
  if (!within(repo, full)) return hardLinkedToProtected(repo, full);
  return /^(\.agent-readiness|\.cursor\/skills\/agent-readiness\/(scripts|rubric|schema|templates))(\/|$)/.test(relative(real(repo), full));
}

// Why a simple command next to a CLI call could change files, or null when it only reads. File
// writes it makes must land outside the repo (writesOutsideRepo); a mode change must not touch a
// protected path, though the digests hash contents, not modes.
function sideEffect(c: Expanded, repo: string): string | null {
  const w = program(c.words);
  const p = basename(w[0] ?? "");
  const args = w.slice(1);
  const line = w.join(" ");
  if (c.words[0] === "command" && /^-[vV]$/.test(c.words[1] ?? "")) return null;
  if (READ_ONLY.has(p)) return null;
  if (args.length === 1 && VERSION_QUERY.test(args[0])) return null;
  if (p === "tee") {
    const bad = args.filter((x) => !x.startsWith("-")).find((f) => !writesOutsideRepo(f, c, repo));
    return bad ? `\`${line}\` writes ${bad} inside the repo` : null;
  }
  if (p === "mktemp") {
    const made = mktempPath(w, { ...emptyDefinitions(), vars: new Map([["TMPDIR", c.tmpdir]]) }, c.cwd);
    return made && writesOutsideRepo(made, c, repo) ? null : `\`${line}\` may create a file inside the repo`;
  }
  if (p === "rm" || p === "unlink") {
    const bad = args.filter((x) => !x.startsWith("-")).find((f) => !writesOutsideRepo(f, c, repo));
    return bad === undefined ? null : `\`${line}\` deletes ${bad} inside the repo`;
  }
  if (p === "find") {
    const action = args.find((a) => FIND_ACTIONS.test(a));
    return action ? `\`${line}\` uses ${action}` : null;
  }
  if (p === "sed" || p === "gsed") {
    const scripts: string[] = [];
    const rest: string[] = [];
    let inPlace = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-e" || a === "--expression") scripts.push(args[++i] ?? "");
      else if (a === "-f" || a === "--file") return `\`${line}\` reads its script from a file`;
      else if (a === "-i" || a === "--in-place") {
        inPlace = true;
        // BSD sed takes the backup suffix as its own argument, often '' on macOS.
        if (args[i + 1] === "" || /^\.\w+$/.test(args[i + 1] ?? "")) i++;
      } else if (/^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place=")) inPlace = true;
      else if (!a.startsWith("-")) rest.push(a);
    }
    if (!scripts.length && rest.length) scripts.push(rest.shift()!);
    if (scripts.some((x) => sedScriptWrites(x))) return `\`${line}\` writes a file or runs a command from its script`;
    const bad = inPlace ? (rest.length ? rest.find((f) => !writesOutsideRepo(f, c, repo)) : "standard input") : undefined;
    return bad ? `\`${line}\` edits ${bad} in place inside the repo` : null;
  }
  if (["awk", "gawk", "mawk", "nawk"].includes(p)) {
    const progs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-f" || a === "-i" || a.startsWith("--include") || a === "--file") return `\`${line}\` loads an awk program from a file`;
      if (a === "-F" || a === "-v") i++;
      else if (!a.startsWith("-") && !progs.length) progs.push(a);
    }
    return progs.some((x) => AWK_EFFECTS.test(x)) ? `\`${line}\` runs a command or writes a file` : null;
  }
  if (p === "chmod") {
    const targets = args.filter((x) => !x.startsWith("-")).slice(1);
    const bad = targets.find((f) => isProtectedPath(repo, f, c));
    return bad ? `\`${line}\` changes ${bad}` : null;
  }
  if (p === "docker" || p === "podman") {
    const sub = args.find((a) => !a.startsWith("-")) ?? (args.includes("--version") ? "--version" : undefined);
    return !sub || DOCKER_READS.has(sub) ? null : `\`${line}\` isn't read-only`;
  }
  return `\`${line}\` isn't a readiness CLI call or a read-only command`;
}

// The substitutions a wrapper may use to build the CLI's path.
const PATH_LOOKUP = /^(pwd|git rev-parse --show-toplevel)$/;

export interface CliVerdict {
  kind: "cli" | "git" | null;
  // When kind is null: the first simple command that kept the call from counting.
  why?: string;
}

// A call the protected-file rule lets change .agent-readiness/: one that runs the readiness CLI and,
// besides it, only commands that read (see sideEffect), whose file writes (redirects, `tee`,
// `mktemp`, `sed -i`) all land outside the repo (see writesOutsideRepo). That covers SKILL.md's
// narration step, a heredoc into $TMPDIR followed by `narrate --file`. The CLI may be called
// through a shell function or variable, as long as the function's body does nothing but `cd` and
// call the CLI. A call made only of git commands is also let through; what git can restore there,
// the seal and the record cross-check catch.
export function cliVerdict(cmd: string, ctx: Context): CliVerdict {
  const calls = expand(cmd, ctx).calls;
  let cli = false;
  let gitOnly = calls.length > 0;
  for (const c of calls) {
    const line = c.words.join(" ");
    if (!c.known) return { kind: null, why: `\`${line}\` runs through a name the gate can't follow` };
    const w = program(c.words);
    const devOnly = c.writes.every((f) => /^\/dev\/(null|stdout|stderr)$/.test(f));
    const inside = c.writes.find((f) => !writesOutsideRepo(f, c, ctx.repo));
    if (isCliCall(c.words, { ...ctx, cwd: c.cwd })) {
      if (c.via ? !devOnly : inside) return { kind: null, why: `\`${line}\` writes ${inside ?? "a file"} from ${c.via ?? "the shell"}` };
      cli = true;
      gitOnly = false;
      continue;
    }
    if (c.via) {
      if ((w[0] === "cd" || w[0] === "pushd" || PATH_LOOKUP.test(w.join(" "))) && devOnly) continue;
      return { kind: null, why: `${c.via} runs \`${line}\` besides the CLI` };
    }
    if (w.length && basename(w[0]) === "git" && devOnly) continue;
    gitOnly = false;
    if (inside) return { kind: null, why: `\`${line}\` writes ${inside} inside the repo` };
    if (!w.length) continue;
    const effect = sideEffect(c, ctx.repo);
    if (effect) return { kind: null, why: effect };
  }
  return cli ? { kind: "cli" } : gitOnly ? { kind: "git" } : { kind: null, why: "no readiness CLI call" };
}

export function cliOnly(cmd: string, ctx: Context): "cli" | "git" | null {
  return cliVerdict(cmd, ctx).kind;
}
