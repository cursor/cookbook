import { readFileSync } from "node:fs";

interface Entry {
  id: string;
  repeat: number;
  root: string;
  dir: string;
  prompts: string[];
  turnHooks: boolean[];
}

const ACCELERATOR = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

export function externalPrompt(e: Entry): string {
  const [first, ...rest] = e.prompts;
  const lines = ["You are a coding agent working for a user. Act exactly as you would for them, using what's in the repository and its skills.", "", first.replace(/\n(Run an agent|I fixed)/, "\nUser: $1")];
  rest.forEach((p, i) => {
    lines.push("", `When you have finished that and replied, the user follows up with:`, "", `User: ${p}`);
    if (e.turnHooks[i + 1]) lines.push("", `Before acting on the follow-up, run \`cd ${ACCELERATOR} && npm run -s evals -- --hook ${e.root} --turn ${i + 2}\`. It applies the change the user describes.`);
  });
  lines.push("", `When you're finished, write the reply you would send the user into ${e.root}/reply.md. Then return only the word done.`);
  return lines.join("\n");
}

if (process.argv[1]?.endsWith("external.ts")) {
  const manifest = JSON.parse(readFileSync(process.argv[2], "utf8")) as Entry[];
  for (const i of process.argv.slice(3).map(Number)) process.stdout.write(`=== ${i} ${manifest[i].id} #${manifest[i].repeat}\n${externalPrompt(manifest[i])}\n\n`);
}
