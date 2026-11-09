import { join } from "node:path";
import { skillDigest } from "../../skill/agent-readiness/scripts/lib/workspace.ts";
import { readJson, writeJson } from "../../skill/agent-readiness/scripts/lib/util.ts";
import { SKILL } from "./fixture.ts";

const pkg = readJson<{ version?: string }>(join(SKILL, "..", "..", "package.json"));
const version = process.argv[2] ?? pkg.version ?? "0.1.0";
const manifest = { version, tag: `agent-readiness-v${version}`, scriptsDigest: skillDigest() };
writeJson(join(SKILL, "RELEASE.json"), manifest);
process.stdout.write(`RELEASE.json: ${manifest.tag} ${manifest.scriptsDigest}\n`);
