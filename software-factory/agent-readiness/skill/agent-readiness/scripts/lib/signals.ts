import { join } from "node:path";
import { readPackageJson } from "./profile.ts";
import type { ContractCommand, Profile, Signal } from "./types.ts";
import { listFiles, readText, wordCount } from "./util.ts";

// Static signals for part 4. They inform; none sets a level or adds a roadmap item.

const SKIP = /(^|\/)(node_modules|dist|build|vendor|fixtures?|testdata|bin|obj|target|\.git)\//;
const SOURCE = /\.(m?[jt]sx?|cjs|py|cs|go|rb)$/;
const ENV_READS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[["']([A-Z][A-Z0-9_]+)["']\]/g,
  /os\.environ(?:\.get)?\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /os\.environ\[["']([A-Z][A-Z0-9_]+)["']\]/g,
  /os\.getenv\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /os\.Getenv\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /Environment\.GetEnvironmentVariable\(\s*"([A-Z][A-Z0-9_]+)"/g,
];
// Set by every shell or test runner, so reading them says nothing about the repo's own config.
const AMBIENT = new Set(["NODE_ENV", "CI", "HOME", "PATH", "PWD", "USER", "SHELL", "LANG", "TZ", "TMPDIR", "TERM", "DEBUG"]);
const ENV_SAMPLE = /(^|\/)(\.env\.(example|sample|template|dist|defaults)|\.env-example|example\.env|env\.example|sample\.env)$/;
// Test runners that take a file or a name pattern, so an agent can run only the tests it touched.
const TARGETED: { re: RegExp; how: string }[] = [
  { re: /\bnode\b[^&|;]*--test\b/, how: "node --test takes file paths" },
  { re: /\bvitest\b/, how: "vitest takes a file or a name filter" },
  { re: /\bjest\b/, how: "jest takes a file pattern" },
  { re: /\bmocha\b/, how: "mocha takes file paths" },
  { re: /\bpytest\b/, how: "pytest takes a file or -k" },
  { re: /\bunittest\b/, how: "unittest takes a module" },
  { re: /\b(ava|tap|uvu)\b/, how: "the runner takes file paths" },
];
const FIXED_PORT = /(?:--port[= ]|\s-p\s+|\bPORT=|localhost:|127\.0\.0\.1:|0\.0\.0\.0:)(\d{2,5})\b/;
const COMPOSE_PORT = /^\s*-\s*["']?(?:[\d.]+:)?(\d{2,5}):\d{2,5}/m;
const ABSOLUTE_PATH = /(\/Users\/[\w.-]+\/|\/home\/[\w.-]+\/|[A-Z]:\\{1,2}Users\\{1,2})/;
const LONG_AGENTS_MD = 900;

function envSignal(tree: string, files: string[]): Signal {
  const reads = new Set<string>();
  for (const f of files.filter((x) => SOURCE.test(x) && !SKIP.test(x) && !/(\.test\.|\.spec\.|(^|\/)tests?\/)/.test(x))) {
    const text = readText(join(tree, f));
    for (const re of ENV_READS) for (const m of text.matchAll(re)) if (!AMBIENT.has(m[1])) reads.add(m[1]);
  }
  const samples = files.filter((f) => ENV_SAMPLE.test(f) && !SKIP.test(f));
  const names = [...reads].sort();
  const shown = `${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""}`;
  if (names.length === 0) return { id: "env_sample", label: "Sample env file", found: samples.length ? true : null, detail: samples.length ? `${samples.join(", ")}; the code reads no environment variables of its own` : "the code reads no environment variables of its own" };
  const vars = (n: number) => `${n} environment ${n === 1 ? "variable" : "variables"}`;
  if (samples.length === 0) return { id: "env_sample", label: "Sample env file", found: false, detail: `none, though the code reads ${vars(names.length)} (${shown})` };
  const defined = new Set(samples.flatMap((f) => [...readText(join(tree, f)).matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1])));
  const missing = names.filter((n) => !defined.has(n));
  const missingShown = `${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}`;
  return {
    id: "env_sample",
    label: "Sample env file",
    found: missing.length === 0,
    detail: missing.length === 0 ? `${samples.join(", ")} names all ${vars(names.length)} the code reads (${shown})` : `${samples.join(", ")} leaves out ${missing.length} of the ${vars(names.length)} the code reads (${missingShown})`,
  };
}

function isolationSignal(tree: string, files: string[], profile: Profile): Signal {
  const hits: string[] = [];
  const check = (where: string, text: string) => {
    const port = text.match(FIXED_PORT);
    if (port) hits.push(`${where} uses fixed port ${port[1]}`);
    const abs = text.match(ABSOLUTE_PATH);
    if (abs) hits.push(`${where} uses the absolute path ${abs[1]}`);
  };
  for (const m of profile.manifests.filter((x) => x.endsWith("package.json"))) {
    const pkg = readPackageJson(join(tree, m.replace(/\/?package\.json$/, "") || "."));
    for (const [name, cmd] of Object.entries(pkg?.scripts ?? {})) check(`${m} scripts.${name}`, cmd);
  }
  const env = profile.environmentJson;
  if (env?.install) check(`${env.path} install`, env.install);
  if (env?.start) check(`${env.path} start`, env.start);
  for (const f of files.filter((x) => /(^|\/)Makefile$/.test(x) || /^(scripts|\.cursor)\/[^/]+\.sh$/.test(x))) check(f, readText(join(tree, f)));
  for (const f of files.filter((x) => /(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(x) && !SKIP.test(x))) {
    const port = readText(join(tree, f)).match(COMPOSE_PORT);
    if (port) hits.push(`${f} publishes fixed host port ${port[1]}`);
  }
  const unique = [...new Set(hits)];
  return {
    id: "isolation",
    label: "Worktree and port isolation",
    found: unique.length === 0,
    detail: unique.length ? `${unique.slice(0, 5).join("; ")}${unique.length > 5 ? `; and ${unique.length - 5} more` : ""}. Two agents in separate worktrees would collide` : "no fixed ports or machine-specific absolute paths in the setup and scripts",
  };
}

function targetedSignal(profile: Profile, contract: ContractCommand[]): Signal {
  const comps = profile.components.filter((c) => c.assessed);
  if (comps.length === 0) return { id: "targeted_tests", label: "A way to run one test file", found: null, detail: "no component was assessed" };
  const parts = comps.map((c) => {
    const test = contract.find((k) => k.component === c.id && k.kind === "test") ?? contract.find((k) => k.component === "*" && k.kind === "test");
    const script = c.scripts.test ?? test?.command ?? "";
    const hit = TARGETED.find((t) => t.re.test(script) || t.re.test(test?.command ?? ""));
    return { id: c.id, ok: Boolean(test && hit), text: !test ? `${c.id}: no test command` : hit ? `${c.id}: ${hit.how}` : `${c.id}: its test command shows no way to run one file` };
  });
  return { id: "targeted_tests", label: "A way to run one test file", found: parts.every((p) => p.ok), detail: parts.map((p) => p.text).join("; ") };
}

export function staticSignals(tree: string, profile: Profile, contract: ContractCommand[]): Signal[] {
  // The installed copy of this skill reads its own SA_READINESS_* settings; that is not the repo's code.
  const files = listFiles(tree, { includeHidden: true }).filter((f) => !f.startsWith(".cursor/skills/agent-readiness/"));
  const ci: Signal = profile.ciFiles.length
    ? { id: "ci", label: "CI config", found: true, detail: `${profile.ciFiles.slice(0, 3).join(", ")}${profile.ciFiles.length > 3 ? ` and ${profile.ciFiles.length - 3} more` : ""}${profile.ciFiles.some((f) => /\b(test|pytest)\b/.test(readText(join(tree, f)))) ? ", and it runs tests" : ", though none of it mentions tests"}` }
    : { id: "ci", label: "CI config", found: false, detail: "no GitHub Actions, GitLab CI, CircleCI or Buildkite config" };
  const agentsMd = files.find((f) => f === "AGENTS.md");
  const words = agentsMd ? wordCount(readText(join(tree, agentsMd))) : 0;
  const length: Signal = agentsMd
    ? { id: "agents_md_length", label: "AGENTS.md length", found: words <= LONG_AGENTS_MD, detail: `${words} words${words > LONG_AGENTS_MD ? `, over ${LONG_AGENTS_MD}; agents load all of it on every task` : ""}` }
    : { id: "agents_md_length", label: "AGENTS.md length", found: null, detail: "no AGENTS.md at the root" };
  return [ci, targetedSignal(profile, contract), envSignal(tree, files), isolationSignal(tree, files, profile), length];
}
