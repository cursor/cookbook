import type { Audit, ReportJson } from "../../../skill/agent-readiness/scripts/lib/types.ts";

// The agent writes the headline, ask, gaps and titles; the scripts write everything else. A
// narrated cause the evidence never mentions ("its tests need Redis" when they need Postgres), a
// change share that isn't the component's, or a level that isn't the one the scripts computed
// reads as true to a judge that can't see the evidence. These checks need no model.

// A cause the narration can name, and what the audit's records must contain to back it.
interface Cause {
  id: string;
  said: RegExp;
  backed: RegExp;
}

const CAUSES: Cause[] = [
  { id: "Postgres", said: /\b(postgres(ql)?|pg)\b/i, backed: /postgres|\b5432\b/i },
  { id: "a database", said: /\b(databases?|db)\b/i, backed: /postgres|mysql|mariadb|mongo|sqlite|database|\b(5432|3306|27017)\b/i },
  { id: "Redis", said: /\bredis\b/i, backed: /redis|\b6379\b/i },
  { id: "MySQL", said: /\b(mysql|mariadb)\b/i, backed: /mysql|mariadb|\b3306\b/i },
  { id: "MongoDB", said: /\bmongo(db)?\b/i, backed: /mongo|\b27017\b/i },
  { id: "Kafka", said: /\bkafka\b/i, backed: /kafka|\b9092\b/i },
  { id: "RabbitMQ", said: /\b(rabbitmq|amqp)\b/i, backed: /rabbit|amqp|\b5672\b/i },
  { id: "Elasticsearch", said: /\b(elasticsearch|opensearch)\b/i, backed: /elastic|opensearch|\b9200\b/i },
  { id: "a cloud service", said: /\b(aws|s3|gcp|azure|cloud storage)\b/i, backed: /\b(aws|s3|gcp|azure)\b|amazonaws|googleapis/i },
  { id: "the network", said: /\b(network|internet|offline|dns|proxy|firewall)\b/i, backed: /network|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|getaddrinfo|fetch failed|proxy|dns|offline/i },
  { id: "TLS", said: /\b(tls|ssl|certificates?)\b/i, backed: /tls|ssl|certificate|CERT_/i },
  { id: "registry credentials", said: /\b(private registry|registry (tokens?|credentials?)|npm token)\b/i, backed: /registry/i },
  { id: "a secret", said: /\b(secrets?|credentials?|api keys?|live keys?|production (keys?|access|secrets?|credentials?)|tokens?)\b/i, backed: /secret|credential|token|key\b|_KEY|password|production/i },
  { id: "a timeout", said: /\b(tim(e|ed|es)[ -]?outs?|too slow|hangs?|hung)\b/i, backed: /timed? ?out|timeout/i },
  { id: "a compile error", said: /\b(compil\w*|type errors?|syntax errors?|doesn't compile)\b/i, backed: /compil|type ?error|syntax ?error|\bTS\d{4}\b/i },
  { id: "memory", said: /\b(out of memory|oom|memory)\b/i, backed: /memory|ENOMEM|\bOOM\b|heap/i },
  { id: "permissions", said: /\b(permissions?|access denied)\b/i, backed: /permission|EACCES|EPERM|denied/i },
  { id: "sudo", said: /\b(sudo|root (access|user|privileges?))\b/i, backed: /sudo|\broot\b/i },
  { id: "a lockfile", said: /\b(lock ?files?|unpinned|not pinned)\b/i, backed: /lock|pin/i },
  { id: "flaky tests", said: /\b(flak(y|iness)|intermittent(ly)?)\b/i, backed: /flak|intermittent/i },
  { id: "Docker", said: /\b(docker|podman|container runtime)\b/i, backed: /docker|podman|container/i },
  { id: "Python", said: /\b(python3?|pip|poetry|uv|pytest|venv)\b/i, backed: /python|pip|poetry|\buv\b|pytest|venv|pyproject/i },
  { id: "Go", said: /\bGo\b|\bgolang\b/, backed: /\bGo\b|go\.mod/ },
  { id: "the JVM", said: /\b(java|jdk|jvm|maven|gradle|kotlin)\b/i, backed: /java|jdk|jvm|maven|gradle|kotlin|pom\.xml/i },
  { id: "Rust", said: /\b(rust|cargo)\b/i, backed: /rust|cargo/i },
  { id: "Ruby", said: /\b(ruby|bundler|gem)\b/i, backed: /ruby|bundle|gem/i },
  { id: "PHP", said: /\b(php|composer)\b/i, backed: /php|composer/i },
  { id: ".NET", said: /\.net\b|\b(dotnet|nuget)\b/i, backed: /\.net|dotnet|nuget|\.sln|\.csproj/i },
  { id: "Bun", said: /\bbun\b/i, backed: /\bbun\b|bun\.lock/i },
  { id: "Yarn", said: /\byarn\b/i, backed: /yarn/i },
  { id: "pnpm", said: /\bpnpm\b/i, backed: /pnpm/i },
  { id: "a compiler toolchain", said: /\b(gcc|clang|compiler|build tools|native (module|build|addon)s?)\b/i, backed: /gcc|clang|g\+\+|compiler|node-gyp|make: |native/i },
];

// "needs no database", "without secrets": a cause the narration rules out isn't a claim.
const NEGATED = /\b(no|without|nor|needs? no|(doesn't|does not|don't|do not|never) (need|use|require)s?)\s+(a |an |any |the )?$/i;

// What the audit's records say, with where each piece came from so a matched cause names its row.
export function evidenceCorpus(r: ReportJson, audit: Audit | null): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const e of r.details.evidence) out.push({ where: e.id, text: `${e.check} ${e.ran} ${e.summary}` });
  for (const e of audit?.evidence ?? []) out.push({ where: e.id, text: [e.command, e.summary, e.diagnosis?.cause, e.diagnosis?.detail, e.blocked, e.outputTail].filter(Boolean).join(" ") });
  for (const c of r.components.included) {
    out.push({ where: `component ${c.id}`, text: `${c.toolchain} ${c.manifest ?? ""} ${c.lockfile ?? ""}` });
    for (const cr of c.capReasons) out.push({ where: `${c.id} ${cr.condition}`, text: `${cr.label} ${cr.reason}` });
  }
  for (const c of r.components.excluded) out.push({ where: `not assessed ${c.id}`, text: `${c.toolchain} ${c.manifest ?? ""} ${c.lockfile ?? ""} ${c.reason}` });
  for (const x of r.details.record) out.push({ where: `record ${x.label}`, text: x.value });
  for (const s of audit?.safety ?? []) out.push({ where: `safety ${s.file}`, text: JSON.stringify(s) });
  for (const i of audit?.instructions ?? []) out.push({ where: `instruction ${i.source}`, text: JSON.stringify(i) });
  for (const reg of audit?.environment.registryEnv ?? []) out.push({ where: "registry env", text: `registry ${reg}` });
  return out;
}

export function narratedTexts(audit: Audit | null): string[] {
  const n = audit?.narration;
  if (!n) return [];
  return [n.headline, n.ask, ...Object.values(n.gaps ?? {}), ...Object.values(n.titles ?? {})].filter((t): t is string => Boolean(t && t.trim()));
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function causeProblems(texts: string[], corpus: { where: string; text: string }[]): { problems: string[]; mapped: string[] } {
  const problems: string[] = [];
  const mapped: string[] = [];
  const said = new Set<string>();
  for (const t of texts) {
    for (const cause of CAUSES) {
      const re = new RegExp(cause.said.source, cause.said.flags.includes("g") ? cause.said.flags : cause.said.flags + "g");
      if ([...t.matchAll(re)].some((m) => !NEGATED.test(t.slice(Math.max(0, m.index! - 30), m.index)))) said.add(cause.id);
    }
    for (const m of t.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) said.add(`var:${m[0]}`);
    for (const m of t.matchAll(/\bports? (\d{2,5})\b/gi)) said.add(`port:${m[1]}`);
  }
  for (const id of said) {
    let hit: { where: string } | undefined;
    if (id.startsWith("var:")) hit = corpus.find((c) => c.text.includes(id.slice(4)));
    else if (id.startsWith("port:")) hit = corpus.find((c) => new RegExp(`\\b${id.slice(5)}\\b`).test(c.text));
    else hit = corpus.find((c) => CAUSES.find((x) => x.id === id)!.backed.test(c.text));
    const label = id.replace(/^var:/, "").replace(/^port:/, "port ");
    if (hit) mapped.push(`${label} -> ${hit.where}`);
    else problems.push(`names ${label} as a cause, but no evidence row mentions it`);
  }
  return { problems, mapped };
}

const pct = (share: number) => Math.round(share * 100);
// A narrated percentage is a rounding of the exact share: 4.8% may read "5%" or "4.8%", not "6%".
const near = (n: number, share: number) => Math.abs(n - share * 100) < 1;
// What may sit between two components that a percentage covers together: "alpha and bravo", "a, b or c".
const LIST_GAP = /^(?:,\s*|\s+(?:and|or)\s+|,\s+(?:and|or)\s+)$/i;

function shareProblems(texts: string[], r: ReportJson): string[] {
  const comps = [...r.components.included, ...r.components.excluded];
  const sum = (xs: { changeShare: number }[]) => xs.reduce((s, c) => s + c.changeShare, 0);
  // Totals part 1 reports; action impacts only when no component is named, since an impact is
  // another component's share.
  const totals = [sum(r.components.included.filter((c) => c.level !== null && c.level < 2)), sum(r.components.included.filter((c) => c.level !== null && c.level >= 2)), 1];
  const unnamed = [sum(r.components.included.filter((c) => r.maturity.setBy.includes(c.id))), sum(r.components.excluded), ...r.actions.map((a) => a.impact)];
  const problems: string[] = [];
  for (const t of texts) {
    for (const sentence of t.split(/(?<=[.;!?])\s+/)) {
      if (!/\bchange/i.test(sentence)) continue;
      const mentions = comps
        .flatMap((c) => [...sentence.matchAll(new RegExp(`\\b${escape(c.id)}\\b`, "gi"))].map((m) => ({ c, start: m.index!, end: m.index! + m[0].length })))
        .sort((a, b) => a.start - b.start);
      for (const m of sentence.matchAll(/(\d+(?:\.\d+)?)%/g)) {
        const n = Number(m[1]);
        const at = m.index!;
        if (!mentions.length) {
          if (![...comps.map((c) => c.changeShare), ...totals, ...unnamed].some((x) => near(n, x))) problems.push(`says ${m[0]} of changes, but no component or total has ${m[0]}`);
          continue;
        }
        // The percentage belongs to the component written nearest it, the one before it on a tie.
        const gap = (x: (typeof mentions)[number]) => (x.end <= at ? at - x.end : x.start - (at + m[0].length));
        const bound = mentions.reduce((best, x) => (gap(x) < gap(best) || (gap(x) === gap(best) && x.end <= at && best.end > at) ? x : best));
        // With a plain list of components next to it, the percentage may be their sum.
        let k = mentions.indexOf(bound);
        const group = [bound];
        for (let i = k - 1; i >= 0 && LIST_GAP.test(sentence.slice(mentions[i].end, mentions[i + 1].start)); i--) group.unshift(mentions[i]);
        for (k = mentions.indexOf(bound); k + 1 < mentions.length && LIST_GAP.test(sentence.slice(mentions[k].end, mentions[k + 1].start)); k++) group.push(mentions[k + 1]);
        const ids = [...new Set(group.map((g) => g.c))];
        const allowed = [bound.c.changeShare, ...(ids.length > 1 ? [sum(ids)] : []), ...totals];
        if (!allowed.some((x) => near(n, x))) problems.push(`says ${m[0]} of changes next to ${ids.map((c) => c.id).join(" and ")}, but ${ids.map((c) => `${c.id} has ${pct(c.changeShare)}%`).join(" and ")}${ids.length > 1 ? ` (${pct(sum(ids))}% together)` : ""}`);
      }
    }
  }
  return problems;
}

function levelProblems(texts: string[], r: ReportJson): string[] {
  const problems: string[] = [];
  const claim = String.raw`(?:\s+(?:is|sits|stays|remains|are)\s+(?:still\s+|now\s+|only\s+|already\s+)?(?:at\s+)?|\s*\(\s*|,\s*(?:at\s+)?|\s+at\s+)Level ([0-4])\b`;
  for (const t of texts) {
    for (const c of r.components.included) {
      for (const m of t.matchAll(new RegExp(String.raw`\b${escape(c.id)}\b` + claim, "g"))) {
        if (Number(m[1]) !== c.level) problems.push(`says ${c.id} is at Level ${m[1]}, but the scripts computed ${c.level === null ? "no level" : `Level ${c.level}`}`);
      }
    }
    for (const m of t.matchAll(new RegExp(String.raw`\b(?:the\s+)?repo(?:sitory)?\b` + claim, "gi"))) {
      if (Number(m[1]) !== r.maturity.level) problems.push(`says the repo is at Level ${m[1]}, but the scripts computed Level ${r.maturity.level}`);
    }
  }
  return problems;
}

// Every problem with the given narrated texts, and what each named cause was matched to.
export function narrationCheck(texts: string[], r: ReportJson, audit: Audit | null): { problems: string[]; mapped: string[] } {
  const causes = causeProblems(texts, evidenceCorpus(r, audit));
  return { problems: [...causes.problems, ...shareProblems(texts, r), ...levelProblems(texts, r)], mapped: causes.mapped };
}
