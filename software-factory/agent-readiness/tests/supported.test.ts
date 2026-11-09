import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { RUNTIMES } from "../skill/agent-readiness/scripts/lib/container.ts";
import { DETECTED_STACKS } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { REPLAY_STACKS, assertHostFallbackSupported } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { STACKS, SUPPORTED_DOC, notSupportedReason } from "../skill/agent-readiness/scripts/lib/support.ts";
import type { SupportTier } from "../skill/agent-readiness/scripts/lib/support.ts";
import { ACCELERATOR, SKILL } from "../support/tools/fixture.ts";

const TIERS: Record<string, SupportTier> = { "## Supported": "supported", "## Not yet supported": "not_yet", "## Not assessed": "not_assessed" };

interface Row {
  id: string;
  tier: SupportTier;
  label: string;
  note: string;
  proof: string[];
}

// The table rows under each tier heading of references/supported.md.
function documented(): Row[] {
  const rows: Row[] = [];
  let tier: SupportTier | null = null;
  for (const line of readFileSync(join(SKILL, SUPPORTED_DOC), "utf8").split("\n")) {
    if (line.startsWith("## ")) tier = TIERS[line.trim()] ?? null;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (!tier || cells.length !== 5 || !/^`[\w-]+`$/.test(cells[0])) continue;
    const proof = cells[4] === "none yet" ? [] : [...cells[4].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    rows.push({ id: cells[0].slice(1, -1), tier, label: cells[1], note: cells[3], proof });
  }
  return rows;
}

describe("supported.md", () => {
  test("lists every support entry once, in the tier, with the reason and proof the code has", () => {
    const rows = documented();
    assert.deepEqual(rows.map((r) => r.id).sort(), STACKS.map((s) => s.id).sort(), "same entries in supported.md and support.ts");
    for (const s of STACKS) {
      const row = rows.find((r) => r.id === s.id)!;
      assert.equal(row.tier, s.tier, `${s.id} tier`);
      assert.equal(row.label, s.label, `${s.id} label`);
      assert.equal(row.note, s.reason ?? "", `${s.id} reason`);
      assert.deepEqual(row.proof, s.proof, `${s.id} proof`);
    }
  });

  test("every stack the scan or replay can assign, and every container runtime, has an entry", () => {
    const ids = new Set(STACKS.map((s) => s.id));
    for (const id of [...DETECTED_STACKS, ...REPLAY_STACKS]) assert.ok(ids.has(id), `${id} is detected but not in support.ts`);
    for (const rt of RUNTIMES.filter((r) => r !== "auto" && r !== "none")) assert.ok(ids.has(rt), `runtime ${rt} has no entry`);
    for (const s of STACKS.filter((x) => x.kind === "stack")) assert.ok(DETECTED_STACKS.includes(s.id) || REPLAY_STACKS.includes(s.id), `${s.id} has an entry but no detector assigns it`);
  });

  test("every proof exists: fixtures and tests are in the accelerator, repos are pinned at a SHA", () => {
    for (const s of STACKS) {
      if (s.tier !== "not_assessed") assert.ok(s.proof.length > 0, `${s.id} needs a fixture or repo that proves it`);
      for (const p of s.proof) {
        if (/^fixtures\//.test(p)) assert.ok(existsSync(join(ACCELERATOR, "support", p)), `${s.id}: ${p} doesn't exist`);
        else if (/^tests\//.test(p)) assert.ok(existsSync(join(ACCELERATOR, p)), `${s.id}: ${p} doesn't exist`);
        else assert.match(p, /^[\w.-]+\/[\w.-]+@[0-9a-f]{7,40}$/, `${s.id}: ${p} isn't owner/repo@sha`);
      }
    }
  });

  test("a stack outside the supported tier says it isn't supported yet, with its reason", () => {
    assert.equal(notSupportedReason("task-graph"), "a package that needs a sibling package built first isn't supported yet: the audit builds packages one by one, not in Turbo's or Nx's order");
    assert.equal(notSupportedReason("go"), "Go isn't supported yet");
    assert.match(notSupportedReason("python-behind-root-package"), /^a Python app next to a root package\.json isn't supported yet: /);
  });

  test("SKILL.md points the agent at supported.md", () => {
    assert.match(readFileSync(join(SKILL, "SKILL.md"), "utf8"), /\(references\/supported\.md\)/);
  });
});

describe("Windows without a container runtime", () => {
  test("the host fallback stops with a plain message instead of failing in bash", () => {
    assert.throws(() => assertHostFallbackSupported("win32"), (e: Error) => /no Docker or Podman/.test(e.message) && /WSL 2/.test(e.message) && e.message.includes("supported.md"));
    assert.doesNotThrow(() => assertHostFallbackSupported("linux"));
    assert.doesNotThrow(() => assertHostFallbackSupported("darwin"));
  });
});
