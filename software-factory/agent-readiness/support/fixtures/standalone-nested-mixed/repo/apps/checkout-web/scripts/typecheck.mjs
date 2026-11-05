import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const file of readdirSync("src").filter((f) => f.endsWith(".ts"))) {
  await import(pathToFileURL(join("src", file)).href);
}
