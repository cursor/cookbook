import { execFileSync } from "node:child_process";
import type { Audit, ReportJson } from "../../../skill/agent-readiness/scripts/lib/types.ts";

// The files git tracks at the audited commit: what the audit read through `git archive`.
export function trackedFiles(repo: string, commit = "HEAD"): Set<string> {
  const out = execFileSync("git", ["ls-tree", "-r", "--name-only", commit], { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return new Set(out.split("\n").filter(Boolean));
}

function readAt(repo: string, commit: string, file: string): string | null {
  try {
    return execFileSync("git", ["show", `${commit}:${file}`], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

// Every config, script and path the report states as present must be in the tree. Paths the report
// quotes as missing, such as a stale instruction's target, aren't claims of presence and aren't read.
export function claimsNotInTree(report: ReportJson, audit: Audit, repo: string, commit = audit.repo.commit): string[] {
  const files = trackedFiles(repo, commit);
  const dirs = new Set<string>(["."]);
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const problems: string[] = [];
  const file = (p: string | null | undefined, what: string) => {
    if (p && !files.has(p)) problems.push(`${what} ${p} isn't in the tree`);
  };
  const dir = (p: string, what: string) => {
    if (!dirs.has(p.replace(/\/$/, ""))) problems.push(`${what} ${p} isn't in the tree`);
  };
  for (const c of [...report.components.included, ...report.components.excluded]) {
    dir(c.path, `component ${c.id}'s path`);
    file(c.manifest, `component ${c.id}'s manifest`);
    file(c.lockfile, `component ${c.id}'s lockfile`);
  }
  for (const a of report.details.assets) if (!files.has(a.path) && !dirs.has(a.path)) problems.push(`agent asset ${a.path} isn't in the tree`);
  for (const cmd of audit.contract) {
    const m = cmd.source.match(/^(\S+) scripts\.([\w:.-]+)$/);
    if (m) {
      const text = readAt(repo, commit, m[1]);
      if (text === null) problems.push(`command ${cmd.id} cites ${m[1]}, which isn't in the tree`);
      else {
        let scripts: Record<string, string> = {};
        try {
          scripts = (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {};
        } catch {
          problems.push(`command ${cmd.id} cites ${m[1]}, which isn't valid JSON`);
        }
        if (!(m[2] in scripts)) problems.push(`command ${cmd.id} runs scripts.${m[2]}, which ${m[1]} doesn't define`);
      }
    }
    const at = cmd.source.match(/^([^\s:]+):\d+$/);
    if (at) file(at[1], `command ${cmd.id}'s source`);
  }
  for (const e of audit.evidence.filter((x) => x.condition === "toolchain" && x.result === "pass")) {
    for (const part of e.summary.replace(/^toolchain pinned in /, "").split(", ")) file(part.replace(/ (engines\.node|packageManager|\([^)]*\))$/, ""), "the toolchain pin");
  }
  const ci = report.details.signals.find((s) => s.id === "ci");
  if (ci?.found) for (const p of ci.detail.split(/,\s*|\s+and\s+/).map((x) => x.trim()).filter((x) => /^[.\w-]+\/\S+$/.test(x))) file(p, "the CI config");
  return [...new Set(problems)];
}
