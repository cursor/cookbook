export interface SecretHit {
  type: string;
  line: number;
}

const PATTERNS: { type: string; re: RegExp }[] = [
  { type: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { type: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "Stripe live key", re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g },
  { type: "Private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { type: "Cursor API key", re: /\bcrsr_[A-Za-z0-9]{20,}\b/g },
  { type: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { type: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
];

const ASSIGNMENT = /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']([^"'\s]{12,})["']/gi;
const PLACEHOLDER = /example|xxx|changeme|placeholder|dummy|fake|test|<|\$\{|your[-_]/i;

export function scanText(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    let specific = false;
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      if (p.re.test(line)) {
        hits.push({ type: p.type, line: i + 1 });
        specific = true;
      }
    }
    if (specific) return;
    ASSIGNMENT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ASSIGNMENT.exec(line))) {
      if (!PLACEHOLDER.test(m[2])) hits.push({ type: "Secret assignment", line: i + 1 });
    }
  });
  return hits;
}

export function redact(text: string, extraValues: string[] = []): string {
  let out = text;
  for (const value of extraValues) {
    if (value && value.length >= 4) out = out.split(value).join("[redacted:env]");
  }
  for (const p of PATTERNS) out = out.replace(p.re, `[redacted:${p.type}]`);
  out = out.replace(ASSIGNMENT, (whole, key: string, value: string) =>
    PLACEHOLDER.test(value) ? whole : whole.replace(value, "[redacted:secret]"),
  );
  return out;
}

export function tail(text: string, maxChars = 4000): string {
  return text.length <= maxChars ? text : "…" + text.slice(text.length - maxChars);
}
