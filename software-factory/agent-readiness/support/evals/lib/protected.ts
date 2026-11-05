import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// What an agent must never change except through the readiness CLI: the audit records and the
// installed skill's code. cli.log is left out because every CLI call, the grader's included, appends to it.
const ROOTS = [".agent-readiness", ".cursor/skills/agent-readiness/scripts", ".cursor/skills/agent-readiness/rubric", ".cursor/skills/agent-readiness/schema", ".cursor/skills/agent-readiness/templates"];
const SKIP = new Set([".agent-readiness/cli.log"]);

function walk(dir: string, root: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = relative(root, full);
    if (SKIP.has(rel)) continue;
    const s = statSync(full, { throwIfNoEntry: false });
    if (!s) continue;
    if (s.isDirectory()) walk(full, root, out);
    else if (s.isFile()) out.push(rel);
  }
}

export function protectedFiles(dir: string): string[] {
  const out: string[] = [];
  for (const r of ROOTS) if (existsSync(join(dir, r))) walk(join(dir, r), dir, out);
  return out;
}

// One digest over every protected file's path and bytes, so any write, rename or delete changes it.
export function protectedDigest(dir: string): string {
  const h = createHash("sha256");
  for (const f of protectedFiles(dir)) {
    let body: Buffer;
    try {
      body = readFileSync(join(dir, f));
    } catch {
      continue;
    }
    h.update(f).update("\0").update(createHash("sha256").update(body).digest("hex")).update("\n");
  }
  return h.digest("hex");
}
