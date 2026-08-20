#!/usr/bin/env node

/**
 * Audit an afterMCPExecution payload without writing tool arguments or results
 * to the log by default. Hook scripts must not block the agent, so malformed
 * input and filesystem errors are reported on stderr and exit successfully.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const SENSITIVE_KEY = /token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key/i;
const MAX_KEYS = 100;
const MAX_PREVIEW = 240;

function redact(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.slice(0, MAX_KEYS).map((item) => redact(item, seen));

  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, seen);
  }
  return result;
}

function parseJson(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function preview(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > MAX_PREVIEW ? `${normalized.slice(0, MAX_PREVIEW)}...` : normalized;
}

function makeRecord(payload) {
  const input = parseJson(payload.tool_input);
  const result = parseJson(payload.result_json);
  const record = {
    timestamp: new Date().toISOString(),
    event: "afterMCPExecution",
    tool_name: typeof payload.tool_name === "string" ? payload.tool_name : null,
    duration_ms: typeof payload.duration === "number" ? payload.duration : null,
    // Cursor's documented payload does not currently contain server identity.
    // Preserve it when a future/runtime-specific payload provides one.
    server: typeof payload.server_name === "string"
      ? payload.server_name
      : typeof payload.mcp_server === "string"
        ? payload.mcp_server
        : null,
    tool_input: input === null
      ? { type: typeof payload.tool_input, length: String(payload.tool_input ?? "").length }
      : {
          type: Array.isArray(input) ? "array" : typeof input,
          keys: input && typeof input === "object" && !Array.isArray(input)
            ? Object.keys(input).slice(0, MAX_KEYS)
            : [],
        },
    result: {
      type: result === null ? typeof payload.result_json : "json",
      length: typeof payload.result_json === "string" ? payload.result_json.length : 0,
      has_error: Boolean(result && (result.error || result.isError)),
    },
  };

  if (process.env.CURSOR_MCP_AUDIT_VERBOSE === "1") {
    if (input !== null) record.tool_input = redact(input);
    const resultPreview = preview(payload.result_json);
    if (resultPreview !== null) record.result.preview = preview(JSON.stringify(redact(result)) || resultPreview);
  }
  return record;
}

const payloadText = await new Promise((resolve) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { text += chunk; });
  process.stdin.on("end", () => resolve(text));
});

try {
  const payload = JSON.parse(payloadText || "{}");
  const record = makeRecord(payload);
  const logFile = process.env.CURSOR_MCP_AUDIT_LOG || ".cursor/hook-logs/mcp-execution.jsonl";
  await mkdir(dirname(logFile), { recursive: true });
  await appendFile(logFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
} catch (error) {
  // Auditing is observational; it must never turn an MCP call into a failure.
  console.error(`MCP audit hook: ${error instanceof Error ? error.message : String(error)}`);
}
