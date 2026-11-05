import { spawnSync } from "node:child_process";

export interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function gh(args: string[], cwd?: string): GhResult {
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function ghJson<T>(args: string[], cwd?: string): T {
  const r = gh(args, cwd);
  if (!r.ok) throw new Error(`gh ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout) as T;
}

export function ghAvailable(): boolean {
  return gh(["auth", "status"]).ok;
}
