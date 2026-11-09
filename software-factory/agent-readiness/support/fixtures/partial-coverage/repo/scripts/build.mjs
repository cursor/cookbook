import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
cpSync("src", "dist", { recursive: true });
console.log("built dist/");
