import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { runCommand } from "./run.ts";
import type { RunOutcome } from "./run.ts";
import { fail } from "./util.ts";

export interface Runtime {
  bin: string;
}

// Only these runtimes: any other program given as --runtime would have its exit codes recorded as
// clean-container results.
export const RUNTIMES = ["auto", "docker", "podman", "none"];

export function detectRuntime(preference: string = "auto"): Runtime | null {
  if (!RUNTIMES.includes(preference)) fail(`--runtime takes ${RUNTIMES.join(", ")}; got ${preference}.`);
  if (preference === "none") return null;
  const candidates = preference === "auto" ? ["docker", "podman"] : [preference];
  for (const bin of candidates) {
    const r = spawnSync(bin, ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 20000 });
    if (r.status === 0) return { bin };
  }
  return null;
}

export function buildImage(runtime: Runtime, contextDir: string, dockerfile: string, tag: string): { ok: boolean; output: string } {
  const r = spawnSync(runtime.bin, ["build", "-q", "-t", tag, "-f", dockerfile, contextDir], { encoding: "utf8", timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

// Behind a proxy or TLS inspection, installs need the same settings the host has. A CA variable
// names a host path, so that file is mounted read-only at the same path.
export const NETWORK_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
export const CA_ENV = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "PIP_CERT"];

export function startArgs(name: string, image: string, hostDir: string, registryEnv: string[], env: Record<string, string | undefined> = process.env, pathExists: (p: string) => boolean = existsSync): string[] {
  const args = ["run", "-d", "--name", name, "-v", `${hostDir}:/work`, "-w", "/work", "-e", "CI=1", "-e", `HOME=${HOME_DIR}`];
  for (const key of registryEnv) args.push("-e", key);
  for (const key of NETWORK_ENV) if (env[key]) args.push("-e", key);
  for (const key of CA_ENV) {
    const path = env[key];
    if (!path || !isAbsolute(path) || !pathExists(path)) continue;
    args.push("-e", key, "-v", `${path}:${path}:ro`);
  }
  args.push(image, "sleep", "infinity");
  return args;
}

export function execArgs(name: string, command: string, cwd: string, user: string | null = null): string[] {
  const dir = cwd === "." || cwd === "" ? "/work" : `/work/${cwd}`;
  return ["exec", ...(user ? ["-u", user] : []), "-w", dir, name, "bash", "-o", "pipefail", "-lc", command];
}

// CI runs the repo's commands as an ordinary user, and tests that check file permissions only
// pass there. Root on the host means no ordinary user to borrow, so commands run as the image's.
export function hostUser(): string | null {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || uid === 0 ? null : `${uid}:${gid}`;
}

// The home every command shares, and the one the audit's own setup uses as the image's user, so
// pip, npm and the rest leave their caches there instead of root-owned files in the shared one.
export const HOME_DIR = "/tmp/home";
export const SETUP_HOME = "/tmp/readiness-setup-home";

export function imageUserArgs(name: string, command: string): string[] {
  return ["exec", "-e", `HOME=${SETUP_HOME}`, name, "bash", "-lc", `mkdir -p ${SETUP_HOME} && ${command}`];
}

export function homeCommand(user: string | null): string {
  return `mkdir -p ${HOME_DIR} && chmod 1777 ${HOME_DIR}${user ? ` && chown -R ${user} ${HOME_DIR}` : ""}`;
}

export function disconnectArgs(name: string, network = "bridge"): string[] {
  return ["network", "disconnect", network, name];
}

export function networksArgs(name: string): string[] {
  return ["inspect", "-f", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}", name];
}

export class ContainerSession {
  runtime: Runtime;
  name: string;
  image: string;
  hostDir: string;
  registryEnv: string[];
  user: string | null;

  constructor(runtime: Runtime, name: string, image: string, hostDir: string, registryEnv: string[], user: string | null = hostUser()) {
    this.runtime = runtime;
    this.name = name;
    this.image = image;
    this.hostDir = hostDir;
    this.registryEnv = registryEnv;
    this.user = user;
  }

  start(): { ok: boolean; output: string } {
    const env = { ...process.env } as Record<string, string>;
    const r = spawnSync(this.runtime.bin, startArgs(this.name, this.image, this.hostDir, this.registryEnv), { encoding: "utf8", env, timeout: 300000 });
    if (r.status === 0) this.reclaimHome();
    return { ok: r.status === 0, output: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  // The repo's own declared setup runs as its image's user; everything else as the ordinary user.
  async exec(command: string, cwd: string, timeoutSec: number, opts: { imageUser?: boolean } = {}): Promise<RunOutcome> {
    const user = opts.imageUser ? null : this.user;
    const argv = [this.runtime.bin, ...execArgs(this.name, command, cwd, user)].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    const out = await runCommand(argv, process.cwd(), process.env as Record<string, string>, timeoutSec);
    if (opts.imageUser && this.user) {
      this.asImageUser(`chown -R ${this.user} /work`);
      this.reclaimHome();
    }
    return out;
  }

  asImageUser(command: string, timeoutMs = 300000): { ok: boolean; output: string } {
    const r = spawnSync(this.runtime.bin, imageUserArgs(this.name, command), { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return { ok: r.status === 0, output: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  // Gives the shared home, and the caches a setup step left in it, back to the ordinary user.
  reclaimHome(): void {
    this.asImageUser(homeCommand(this.user));
  }

  enableCorepack(): void {
    this.asImageUser("command -v corepack >/dev/null && corepack enable >/dev/null 2>&1 || true", 60000);
  }

  // Podman attaches to "podman" rather than "bridge", and rootless networking lists no network at
  // all, so every attached network is cut and the container itself must show every interface but
  // loopback down. Kernels add tunnel devices such as tunl0 that are always down.
  disconnectNetwork(): boolean {
    const r = spawnSync(this.runtime.bin, networksArgs(this.name), { encoding: "utf8" });
    if (r.status !== 0) return false;
    for (const net of r.stdout.trim().split(/\s+/).filter(Boolean)) spawnSync(this.runtime.bin, disconnectArgs(this.name, net), { encoding: "utf8" });
    const probe = this.asImageUser('for i in /sys/class/net/*; do [ -f "$i/operstate" ] && echo "$(basename "$i") $(cat "$i/operstate")"; done; true', 30000);
    return probe.ok && probe.output.trim().split("\n").every((l) => l.startsWith("lo ") || l.endsWith(" down"));
  }

  stop(): void {
    spawnSync(this.runtime.bin, ["exec", this.name, "chown", "-R", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, "/work"], { encoding: "utf8" });
    spawnSync(this.runtime.bin, ["rm", "-f", this.name], { encoding: "utf8" });
  }
}
