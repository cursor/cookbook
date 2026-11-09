import { cpSync, mkdirSync } from "node:fs";

mkdirSync("static/dist", { recursive: true });
cpSync("static/css", "static/dist", { recursive: true });
console.log("built static/dist/");
