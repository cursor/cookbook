import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

// The bundle carries a load banner, the way generated output often does.
mkdirSync("dist", { recursive: true });
const sources = readdirSync("src").map((f) => readFileSync(`src/${f}`, "utf8"));
writeFileSync("dist/bundle.js", ['console.log("pricing bundle loaded");', ...sources].join("\n"));
console.log("built dist/bundle.js");
