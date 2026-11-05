import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Like `biome check --write`: with --fix it reformats every source file before it reports,
// and it reads every .js file it finds, generated output included.
const fix = process.argv.includes("--fix");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "scripts" || name === "test" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

let problems = 0;
for (const file of walk(".")) {
  let text = readFileSync(file, "utf8");
  if (fix && file.startsWith("src")) {
    text = text.replace(/^( +)/gm, (indent) => indent.replace(/ {2}/g, "    "));
    writeFileSync(file, text);
  }
  if (text.includes("console.log")) {
    console.error(`${file}: remove console.log`);
    problems++;
  }
}
process.exit(problems ? 1 : 0);
