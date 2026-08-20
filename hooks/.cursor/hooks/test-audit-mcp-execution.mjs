#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const hook = new URL("./audit-mcp-execution.mjs", import.meta.url);
const hookPath = hook.pathname;

function run(input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

const directory = await mkdtemp(join(tmpdir(), "cursor-mcp-audit-"));
const logFile = join(directory, "audit.jsonl");
try {
  const result = await run({
    tool_name: "search_contacts",
    tool_input: JSON.stringify({ query: "Ada", api_key: "do-not-log" }),
    result_json: JSON.stringify({ contacts: [{ name: "Ada" }] }),
    duration: 42,
  }, { CURSOR_MCP_AUDIT_LOG: logFile });
  if (result.code !== 0) throw new Error(`hook exited ${result.code}: ${result.stderr}`);

  const record = JSON.parse((await readFile(logFile, "utf8")).trim());
  if (record.event !== "afterMCPExecution") throw new Error("event was not recorded");
  if (record.tool_name !== "search_contacts") throw new Error("tool name was not recorded");
  if (record.duration_ms !== 42) throw new Error("duration was not recorded");
  if (record.server !== null) throw new Error("unknown server must remain null");
  if (!record.tool_input.keys.includes("api_key")) throw new Error("input keys were not recorded");
  if (JSON.stringify(record).includes("do-not-log")) throw new Error("secret leaked into audit record");
  if (record.result.preview !== undefined) throw new Error("result preview leaked without verbose mode");

  const malformed = await run({ tool_name: "broken", tool_input: "not-json", result_json: "not-json" }, {
    CURSOR_MCP_AUDIT_LOG: logFile,
  });
  if (malformed.code !== 0) throw new Error("malformed optional fields should not fail the hook");

  console.log("audit-mcp-execution: all tests passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
