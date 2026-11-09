import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Eval agents must see only the repo's own rules and skills, never the machine owner's: a laptop's
// ~/.cursor can hold hundreds of rules and skills a CI runner doesn't have, which makes runs on
// different machines different instruments. The SDK driver already loads only the "project"
// settings layer; on top of that, each worker gets an empty HOME, so there is no ~/.cursor,
// ~/.claude, ~/.agents or ~/.codex for any layer to load. Container runtimes keep their real
// configuration (DOCKER_CONFIG, and Podman's XDG folders), and git gets a placeholder identity.
// The baseline records ISOLATION, and compare() refuses runs made with another.

export const ISOLATION = "project-only: settingSources project, empty HOME";

// The folders a Cursor-compatible agent reads user rules and skills from, relative to HOME.
export const USER_AGENT_DIRS = [".cursor", ".claude", ".agents", ".codex", ".grok"];

export interface Isolation {
  id: string;
  home: string;
  // User rule or skill folders found in the isolated HOME; always empty unless something wrote one.
  userDirs: string[];
}

export function isolateHome(env: NodeJS.ProcessEnv = process.env): Isolation {
  const real = env.HOME ?? homedir();
  const home = mkdtempSync(join(tmpdir(), "eval-home-"));
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Contributor A\n\temail = a@example.com\n[commit]\n\tgpgsign = false\n");
  if (!env.DOCKER_CONFIG && existsSync(join(real, ".docker"))) env.DOCKER_CONFIG = join(real, ".docker");
  env.XDG_CONFIG_HOME ??= join(real, ".config");
  env.XDG_DATA_HOME ??= join(real, ".local", "share");
  env.HOME = home;
  env.USERPROFILE = home;
  return { id: ISOLATION, home, userDirs: userAgentDirs(home) };
}

export function userAgentDirs(home: string): string[] {
  return USER_AGENT_DIRS.filter((d) => existsSync(join(home, d)) && readdirSync(join(home, d)).length > 0);
}
