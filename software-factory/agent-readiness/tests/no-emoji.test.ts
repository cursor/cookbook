import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, test } from "node:test";
import { renderHtml } from "../skill/agent-readiness/scripts/lib/render-html.ts";
import { renderMarkdown, validatePart1 } from "../skill/agent-readiness/scripts/lib/render.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { EMOJI } from "../skill/agent-readiness/scripts/lib/util.ts";
import type { AuditSpec } from "./helpers.ts";
import { makeAudit, reportFor } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");
const rubric = loadRubric("2026-10-alpha");
const TEXT = new Set([".md", ".html", ".json", ".ts", ".mjs", ".js", ".yml", ".yaml", ".txt", ".sh"]);

function emojiIn(text: string): string[] {
  return [...text.matchAll(new RegExp(EMOJI.source, "gu"))].map((m) => `U+${m[0].codePointAt(0)!.toString(16).toUpperCase()}`);
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "node_modules" ? [] : files(p);
    return TEXT.has(extname(p)) ? [p] : [];
  });
}

const specs: Record<string, AuditSpec> = {
  "a Level 0 monorepo": {
    components: [
      { id: "api", share: 0.56, test: "fail", diagnosis: { cause: "service", detail: "connection refused on port 5432", service: "Postgres" }, faults: "not_run" },
      { id: "worker", share: 0.27, faults: "fail" },
      { id: "shared", share: 0.15, faults: "pass" },
      { id: "infra", share: 0.02, assessed: false },
    ],
  },
  "a clean Level 2 repo": { components: [{ id: "app", share: 1, faults: "pass" }] },
  "a repo with nothing assessed": { components: [{ id: "infra", share: 1, assessed: false }] },
};

describe("no emoji anywhere", () => {
  for (const [name, spec] of Object.entries(specs)) {
    test(`the rendered report.md and report.html for ${name} contain no emoji`, () => {
      const r = reportFor(makeAudit(spec));
      assert.deepEqual(emojiIn(renderMarkdown(r, rubric)), []);
      assert.deepEqual(emojiIn(renderHtml(r)), []);
    });
  }

  test("the examples, the skill (SKILL.md, references, scripts) and PRODUCT.md contain no emoji", () => {
    const found = [...files(join(ROOT, "examples")), ...files(join(ROOT, "skill")), join(ROOT, "support", "PRODUCT.md"), join(ROOT, "README.md")].flatMap((p) => {
      const hits = emojiIn(readFileSync(p, "utf8"));
      return hits.length ? [`${relative(ROOT, p)}: ${[...new Set(hits)].join(", ")}`] : [];
    });
    assert.deepEqual(found, []);
  });

  test("the CLI's help output contains no emoji", () => {
    const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "skill/agent-readiness/scripts/readiness.ts"), "--help"], { encoding: "utf8" });
    assert.ok(out.includes("readiness <command>"));
    assert.deepEqual(emojiIn(out), []);
  });

  test("the seal refuses narration with an emoji", () => {
    const r = reportFor(makeAudit(specs["a clean Level 2 repo"]));
    r.executive.headline = "app sets the level, and nothing blocks it \u{2705}";
    assert.ok(validatePart1(r, rubric, null).some((e) => e === "headline uses an emoji; say the status in words"));
    r.executive.ask = "Approve the targets \u{1F680}";
    assert.ok(validatePart1(r, rubric, null).some((e) => e === "ask uses an emoji; say the status in words"));
  });
});
