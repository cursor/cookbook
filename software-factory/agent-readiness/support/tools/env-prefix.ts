import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Project rule: an environment variable the accelerator defines itself starts with SA_. Names other
// systems define (the OS, CI, Cursor, package managers, the user's registry tokens) are external.
const EXTERNAL = new Set([
  "PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "PWD", "USER", "SHELL", "LANG", "TZ", "TERM", "CI", "NODE_ENV", "NODE_OPTIONS",
  "CURSOR_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_STEP_SUMMARY",
  "NPM_TOKEN", "PIP_INDEX_URL", "DEBIAN_FRONTEND", "DOCKER_HOST",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
]);
const EXTERNAL_PREFIX = /^(GIT_|GITHUB_|RUNNER_|CURSOR_|COREPACK_|NPM_CONFIG_|npm_config_|UV_|PIP_|PYTHON|XDG_|LC_|DOCKER_)/;
const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

// Folders that hold other repos' content as test data, not the accelerator's own variables.
const SKIP_DIR = new Set(["node_modules", ".git", "repo", "goldens-cache"]);
const SCANNED = /\.(ts|mjs|js|ya?ml|md|sh)$/;

export interface EnvFinding {
  file: string;
  line: number;
  name: string;
  how: string;
}

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIR.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else if (SCANNED.test(e)) out.push(p);
  }
  return out;
}

// Code inside a string literal is content the accelerator writes into a test repo.
function inString(line: string, at: number): boolean {
  const before = line.slice(0, at).replace(/\\./g, "");
  return ["\"", "'", "`"].some((q) => (before.split(q).length - 1) % 2 === 1);
}

const PATTERNS: { kinds: RegExp; re: RegExp; how: string; code?: boolean }[] = [
  { kinds: /\.(ts|mjs|js)$/, re: /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[["']([A-Za-z_][A-Za-z0-9_]*)["']\])/g, how: "read in code", code: true },
  { kinds: /\.(ts|mjs|js)$/, re: /\benv(?:\.([A-Z][A-Z0-9_]*)|\[["']([A-Z][A-Z0-9_]*)["']\])\s*=(?!=)/g, how: "set on an env object", code: true },
  { kinds: /\.(ts|mjs|js)$/, re: /(?<!\b(?:const|let|var|case)\s+)(?<!\?\s*)\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*:\s*(?=["'`\w(])/g, how: "an env object key", code: true },
  { kinds: /\.ya?ml$/, re: /^\s+([A-Z][A-Z0-9_]*)\s*:/g, how: "a workflow env key" },
  { kinds: /\.(ya?ml|sh|md)$/, re: /\$\{?([A-Z][A-Z0-9_]*)/g, how: "a shell reference" },
  { kinds: /\.(ya?ml|sh|md)$/, re: /\benv\.([A-Z][A-Z0-9_]*)/g, how: "a workflow reference" },
  { kinds: /\.(ya?ml|sh|md)$/, re: /(?:^|[\s;&|(])(?:export\s+)?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)=/g, how: "a shell assignment" },
];

export function unprefixedEnvVars(root: string): EnvFinding[] {
  const found: EnvFinding[] = [];
  for (const file of files(root)) {
    const rel = relative(root, file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const p of PATTERNS.filter((x) => x.kinds.test(file))) {
        for (const m of line.matchAll(p.re)) {
          const name = m[1] ?? m[2];
          if (!name || !ENV_NAME.test(name) || name.startsWith("SA_") || EXTERNAL.has(name) || EXTERNAL_PREFIX.test(name)) continue;
          if (p.code && inString(line, m.index ?? 0)) continue;
          found.push({ file: rel, line: i + 1, name, how: p.how });
        }
      }
    });
  }
  return found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}
