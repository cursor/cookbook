import { mkdirSync, writeFileSync } from "node:fs";
import { discount } from "@fx/core";

mkdirSync("dist", { recursive: true });
writeFileSync("dist/prices.json", JSON.stringify({ sale: discount(120) }));
console.log("built dist/prices.json");
