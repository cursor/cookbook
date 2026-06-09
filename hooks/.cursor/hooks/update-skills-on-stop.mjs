#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const SKILL_MAPPINGS = [
  {
    name: "Data access skill",
    paths: ["src/db/", "db/schema", "schema.ts", "prisma/", "migrations/"],
    skill: ".cursor/skills/data-access/SKILL.md",
    checks: ["Refresh generated schema documentation if this repository has a schema-doc generation step."],
  },
  {
    name: "Design system skill",
    paths: ["src/components/", "components/ui/", "src/app/", "design-system/"],
    skill: ".cursor/skills/designer/SKILL.md",
    checks: ["Document new component patterns, variants, tokens, or layout conventions."],
  },
  {
    name: "Cursor integration skill",
    paths: ["src/lib/cursor/", "lib/cursor/", "cursor/"],
    skill: ".cursor/skills/cursor/SKILL.md",
    checks: ["Document new Cursor API helpers, agent workflow changes, or integration caveats."],
  },
];

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

function gitLines(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function changedFiles() {
  const tracked = gitLines(["diff", "--name-only", "HEAD"]);
  const untracked = gitLines(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...tracked, ...untracked])].sort();
}

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function matchesPrefixOrFile(filePath, matcher) {
  const normalizedFile = normalizePath(filePath);
  const normalizedMatcher = normalizePath(matcher);

  if (normalizedMatcher.endsWith("/")) {
    return normalizedFile.startsWith(normalizedMatcher);
  }

  return normalizedFile === normalizedMatcher || normalizedFile.endsWith(`/${normalizedMatcher}`);
}

function matchingMappings(files) {
  return SKILL_MAPPINGS.map((mapping) => {
    const matchedFiles = files.filter((file) =>
      mapping.paths.some((pathPattern) => matchesPrefixOrFile(file, pathPattern)),
    );

    return { ...mapping, matchedFiles };
  }).filter((mapping) => mapping.matchedFiles.length > 0);
}

function buildFollowup(matches) {
  const sections = matches.map((match) => {
    const files = match.matchedFiles.map((file) => `- ${file}`).join("\n");
    const checks = match.checks.map((check) => `- ${check}`).join("\n");

    return [
      `${match.name}: ${match.skill}`,
      "Changed files:",
      files,
      "Checks:",
      checks,
    ].join("\n");
  });

  return [
    "Before finishing, review whether related Cursor skills need updates because this run changed files in configured areas.",
    "",
    sections.join("\n\n"),
    "",
    "If a skill is stale, update it now. If no update is needed, briefly explain why. Then run the relevant verification for the files you changed.",
  ].join("\n");
}

const input = await readStdin();
const payload = JSON.parse(input || "{}");

if (payload.status && payload.status !== "completed") {
  console.log(JSON.stringify({}));
  process.exit(0);
}

if (Number(payload.loop_count || 0) > 0) {
  console.log(JSON.stringify({}));
  process.exit(0);
}

const matches = matchingMappings(changedFiles());

if (matches.length === 0) {
  console.log(JSON.stringify({}));
} else {
  console.log(JSON.stringify({ followup_message: buildFollowup(matches) }));
}
