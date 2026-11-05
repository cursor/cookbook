import type { Diagnosis } from "./types.ts";

const PORTS: Record<string, string> = {
  "5432": "Postgres",
  "3306": "MySQL",
  "6379": "Redis",
  "27017": "MongoDB",
  "9200": "Elasticsearch",
  "5672": "RabbitMQ",
  "9092": "Kafka",
  "11211": "Memcached",
};

// The words that show the output itself named the service on a port, not just the port.
const NAMED: Record<string, RegExp> = {
  "5432": /postgres/i,
  "3306": /mysql|mariadb/i,
  "6379": /redis/i,
  "27017": /mongo/i,
  "9200": /elasticsearch/i,
  "5672": /rabbitmq|amqp/i,
  "9092": /kafka/i,
  "11211": /memcache/i,
};

// How report text names the service a refused connection points at: by name only when the output
// named it, otherwise by its port.
export function serviceLabel(d: Diagnosis, unnamed: (port: string) => string): string {
  const port = d.detail.match(/port (\d+)/)?.[1];
  if (!port) return d.service ?? "a service";
  return d.serviceNamed && d.service ? `${d.service} on port ${port}` : unnamed(port);
}

const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/;

// The test totals a runner prints, so the report can say "82 of 82 tests" instead of "passed".
// Covers node --test (tap and spec), bun test, vitest, jest, mocha, pytest and unittest; null when none match.
export function testCounts(output: string): { passed: number; failed: number; total: number } | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const num = (re: RegExp) => {
    const all = [...text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))];
    return all.length ? Number(all[all.length - 1][1]) : null;
  };
  const nodePass = num(/^\s*[#\u2139] pass (\d+)\s*$/m);
  if (nodePass !== null) {
    const failed = num(/^\s*[#\u2139] fail (\d+)\s*$/m) ?? 0;
    return { passed: nodePass, failed, total: num(/^\s*[#\u2139] tests (\d+)\s*$/m) ?? nodePass + failed };
  }
  const bunRan = num(/^Ran (\d+) tests? across \d+ files?\./m);
  if (bunRan !== null) {
    const failed = num(/^\s*(\d+) fail\s*$/m) ?? 0;
    return { passed: num(/^\s*(\d+) pass\s*$/m) ?? bunRan - failed, failed, total: bunRan };
  }
  const vitest = [...text.matchAll(/Tests\s+(?:(\d+) failed \|\s*)?(\d+) passed[^(\n]*\((\d+)\)/g)].pop();
  if (vitest) return { passed: Number(vitest[2]), failed: Number(vitest[1] ?? 0), total: Number(vitest[3]) };
  const jest = [...text.matchAll(/Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:\d+ todo, )?(\d+) passed, (\d+) total/g)].pop();
  if (jest) return { passed: Number(jest[2]), failed: Number(jest[1] ?? 0), total: Number(jest[3]) };
  const mochaPass = num(/^\s*(\d+) passing\b/m);
  if (mochaPass !== null) {
    const failed = num(/^\s*(\d+) failing\b/m) ?? 0;
    return { passed: mochaPass, failed, total: mochaPass + failed };
  }
  const pytest = [...text.matchAll(/(?:(\d+) failed, )?(\d+) passed(?:, \d+ \w+)* in [\d.]+s/g)].pop();
  if (pytest) return { passed: Number(pytest[2]), failed: Number(pytest[1] ?? 0), total: Number(pytest[2]) + Number(pytest[1] ?? 0) };
  const ran = num(/^Ran (\d+) tests? in /m);
  if (ran !== null) {
    const failed = (num(/FAILED \((?:failures=(\d+))/m) ?? 0) + (num(/FAILED \([^)]*errors=(\d+)/m) ?? 0);
    return { passed: ran - failed, failed, total: ran };
  }
  return null;
}

// TLS interception, proxies and resets show up as these, not only as DNS failures. Returns what
// failed in plain words, or null.
const NETWORK: { re: RegExp; detail: string }[] = [
  { re: /ProxyError|407 Proxy Authentication|tunneling socket could not be established|proxy[^\n]{0,40}(refused|error|failed)/i, detail: "a proxy error on the network" },
  { re: /CERT_|certificate verify failed|unable to (get|verify) (the )?(local issuer|first) certificate|self[- ]signed certificate|SSLError|SSL: [A-Z_]+|ERR_SSL|SSL routines|tlsv1 alert|TLS handshake|Client network socket disconnected before secure TLS/i, detail: "a TLS or certificate error on the network" },
  { re: /ENOTFOUND|EAI_AGAIN|getaddrinfo|Temporary failure in name resolution|Could not resolve host/, detail: "it tried to reach the network" },
  { re: /ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|Network is unreachable|socket hang up|\bfetch failed\b|Connection reset by peer|Failed to connect to|Max retries exceeded with url|NewConnectionError|ReadTimeoutError|request to https?:\/\/\S+ failed|ECONNREFUSED (?!127\.0\.0\.1|::1|localhost)[\d.]+:\d+|All attempts to connect to [\w.-]+ failed/, detail: "a network connection failed" },
];

// A home or cache directory the audit's user can't write, such as one a setup step run as root
// left behind. Poetry reports it as "All attempts to connect to pypi.org failed" with the
// PermissionError only in its verbose output; npm says its cache holds root-owned files.
const PERMISSION = /\bEACCES\b|\bEPERM\b|PermissionError|Permission denied/;
const HOME_OR_CACHE = /(\/tmp\/home\b|\/root\b|\/home\/[^/\s'"]+\/\.|\.cache\/|\/\.npm\b|\/\.bun\/|\/\.yarn\/berry|pypoetry|corepack|ms-playwright|\/\.local\/)/;

export function permissionLimit(output: string): string | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  if (/cache folder contains root-owned files/.test(text)) return "the npm cache in the home directory belongs to another user";
  if (/Connection broken: PermissionError\(13/.test(text)) return "a permission error on a cache or home directory, which the tool reported as a failed connection";
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!PERMISSION.test(lines[i])) continue;
    const near = lines.slice(Math.max(0, i - 2), i + 5).join("\n");
    const path = near.match(new RegExp(String.raw`(?:^|[\s'"=(])(\/[^\s'",)]*${HOME_OR_CACHE.source}[^\s'",)]*)`, "m"))?.[1];
    if (path) return `the audit's user can't write ${path.replace(/[:.]+$/, "")}, a home or cache directory`;
  }
  return null;
}

// The Python the image has doesn't satisfy the project's requires-python, as pip, uv and Poetry say it.
export function pythonMismatch(output: string): string | null {
  const m =
    output.match(/requires a different Python: [\d.]+ not in '([^']+)'/) ??
    output.match(/No interpreter found for Python ([^\s]+)/) ??
    output.match(/current Python version \([\d.]+\) does not satisfy Python([^\s,]+)/) ??
    output.match(/Python version [\d.]+ is not supported by the project \(([^)]+)\)/) ??
    output.match(/Current Python version \([\d.]+\) is not allowed by the project \(([^)]+)\)/);
  return m ? `Python ${m[1].replace(/^\s*/, "")} is not installed` : null;
}

// Playwright's browsers are a separate download (`playwright install`) that the image doesn't have.
const PLAYWRIGHT = /Executable doesn't exist at [^\n]*ms-playwright|Looks like Playwright (?:Test or Playwright )?was just installed or updated|Please run the following command to download new browsers/;

export function networkFailure(output: string): string | null {
  return NETWORK.find((n) => n.re.test(output))?.detail ?? mirrorRefused(output);
}

// A package mirror or registry answering an HTTP error, such as apt's "403  Forbidden" from
// deb.debian.org behind a firewall, or a 5xx or rate limit from npm or PyPI. 401 is missing registry
// credentials and 404 can be a typo in the repo's own dependencies, so neither is here.
const STATUS = String.raw`(?<status>403|407|429|5\d\d)`;
const URL_ = String.raw`(?<url>https?:\/\/[^\s"'\\]+)`;
const REASON = String.raw`(?:Forbidden|Proxy Authentication Required|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|Client Error|Server Error)`;
const MIRROR: RegExp[] = [
  // apt: "E: Failed to fetch <url>  403  Forbidden [IP: ...]"; yarn: "<url>: Request failed \"403 Forbidden\""
  new RegExp(String.raw`${URL_}[^\n]*?[\s"]${STATUS}\s+${REASON}`),
  // apt update: "Err:1 <url> bookworm InRelease" with "  403  Forbidden" on the next line
  new RegExp(String.raw`Err:\d+\s+${URL_}[^\n]*\n\s+${STATUS}\s+${REASON}`),
  // npm: "403 Forbidden - GET <url>"; requests: "403 Client Error: Forbidden for url: <url>"
  new RegExp(String.raw`\b${STATUS}\b[^\n]{0,40}?${REASON}[^\n]*?${URL_}`),
  // pip: "HTTP error 403 while getting <url>"; pnpm: "ERR_PNPM_FETCH_403  GET <url>"
  new RegExp(String.raw`(?:HTTP error ${STATUS} while getting|ERR_PNPM_FETCH_${STATUS.replace("status", "pnpm")}\s+GET)\s+${URL_}`),
];

export function mirrorRefused(output: string): string | null {
  for (const re of MIRROR) {
    const m = re.exec(output);
    if (!m?.groups) continue;
    let host = "the mirror";
    try {
      host = new URL(m.groups.url.replace(/[:.,;)]+$/, "")).hostname;
    } catch {
      // keep the generic name
    }
    return `a package mirror refusing the download (HTTP ${m.groups.status ?? m.groups.pnpm} from ${host})`;
  }
  return null;
}

// Node, TypeScript and Python name a missing module one way; bundlers and Vite another. The first
// group that matched is the module.
const MISSING_MODULE = [
  /Cannot find (?:module|package) '([^'\n]+)'/,
  /ModuleNotFoundError: No module named '([^'\n]+)'/,
  /ERR_MODULE_NOT_FOUND[^\n']*'([^'\n]+)'/,
  /Could not resolve ["']([^"'\n]+)["']/,
  /[Ff]ailed to resolve (?:entry for package|import) ["']([^"'\n]+)["']/,
  /Module not found: Error: Can't resolve '([^'\n]+)'/,
  /["']([^"'\n]+)["'] is imported by [^\n]+, but could not be resolved/,
];

export function diagnose(rawOutput: string, timedOut: boolean, phase: string): Diagnosis {
  const output = rawOutput.replace(/\x1b\[[0-9;]*m/g, "");
  if (timedOut) return { cause: "timeout", detail: `the ${phase} step ran out of time` };
  const permission = permissionLimit(output);
  if (permission) return { cause: "permission", detail: permission };
  const python = pythonMismatch(output);
  if (python) return { cause: "missing_tool", detail: python };
  if (PLAYWRIGHT.test(output)) return { cause: "missing_tool", detail: "Playwright's browsers are not installed" };
  const refused = output.match(/ECONNREFUSED (?:127\.0\.0\.1|::1|localhost|\[::1\]):(\d+)|connect(?:ion)? refused[^\n]*?:(\d{2,5})/i);
  if (refused) {
    const port = refused[1] ?? refused[2];
    const service = PORTS[port] ?? `a service on port ${port}`;
    if (PORTS[port] && NAMED[port]?.test(output)) return { cause: "service", detail: `connection refused on port ${port}; the output names ${service}`, service, serviceNamed: true };
    return { cause: "service", detail: `connection refused on port ${port}`, service };
  }
  const cred = output.match(/\bMissing (?:required )?(?:env(?:ironment)? (?:var(?:iable)?)?\s*)?([A-Z][A-Z0-9_]{2,})\b|\b([A-Z][A-Z0-9_]{2,}) (?:is )?(?:not set|required|missing)\b/);
  if (cred) {
    const name = cred[1] ?? cred[2];
    if (SECRET_NAME.test(name)) return { cause: "credential", detail: `needs ${name}` };
  }
  if ((phase === "install" || phase === "doctor") && (/\b(E?401|Unauthorized|authentication required|no auth token)\b/i.test(output) || /Failed to replace env in config: \$\{[A-Z_]+\}/.test(output))) {
    return { cause: "registry", detail: "registry credentials not provided" };
  }
  // A refused package download explains whatever is missing after it.
  const mirror = mirrorRefused(output);
  if (mirror) return { cause: "network", detail: mirror };
  if (/ensurepip is not available|No module named venv\b/.test(output)) return { cause: "missing_tool", detail: "python3-venv is not installed" };
  const tool = output.match(/(?:^|\n)(?:[^\n:]*: line \d+: |[^\n:]*: \d+: |(?:ba)?sh: )?([\w.+-]+): (?:command )?not found/);
  if (tool) return { cause: "missing_tool", detail: `${tool[1]} is not installed` };
  const mod = MISSING_MODULE.map((re) => output.match(re)).filter((m): m is RegExpMatchArray => m !== null).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0];
  if (mod) return { cause: "missing_module", detail: `module ${mod[1]} is missing` };
  const network = networkFailure(output);
  if (network) return { cause: "network", detail: network };
  if (/SyntaxError|error TS\d{4}|IndentationError/.test(output)) return { cause: "compile", detail: "the code doesn't compile" };
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  // node --test's TAP block lists code, failureType and the like after the error itself.
  const noise = /^(npm (error|ERR!|warn)|ELIFECYCLE|error Command failed|>\s|\$ |command failed|at |# |(code|failureType|type|location|duration_ms|stack): )/i;
  const meaningful = lines.filter((l) => !noise.test(l));
  const errLine = [...meaningful].reverse().find((l) => /error|fail|assert|exception|remove|missing|expected/i.test(l)) ?? meaningful[meaningful.length - 1] ?? lines[lines.length - 1] ?? "no output";
  return { cause: "unknown", detail: errLine.replace(/^error: '(.*)'$/, "$1").slice(0, 160) };
}
