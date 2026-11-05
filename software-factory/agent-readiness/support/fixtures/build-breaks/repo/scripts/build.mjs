import { cpSync, mkdirSync } from "node:fs";
import { banner } from "./banner.mjs";

mkdirSync("dist", { recursive: true });
cpSync("src", "dist", { recursive: true });
console.log(banner("built dist/"));
