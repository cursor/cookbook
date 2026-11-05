import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "src";
let problems = 0;
for (const file of readdirSync(dir)) {
  if (readFileSync(join(dir, file), "utf8").includes("console.log")) {
    console.error(`${join(dir, file)}: remove console.log`);
    problems++;
  }
}
process.exit(problems ? 1 : 0);
