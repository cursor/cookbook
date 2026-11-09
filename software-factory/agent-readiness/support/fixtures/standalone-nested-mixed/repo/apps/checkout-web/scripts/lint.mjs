import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let problems = 0;
for (const file of readdirSync("src")) {
  const text = readFileSync(join("src", file), "utf8");
  if (text.includes("console.log")) {
    console.error(`${file}: remove console.log`);
    problems++;
  }
}
process.exit(problems ? 1 : 0);
