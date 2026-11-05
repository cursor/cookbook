import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { ACCELERATOR } from "../support/tools/fixture.ts";
import { unprefixedEnvVars } from "../support/tools/env-prefix.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "env-prefix-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe("environment variable prefix", () => {
  test("every variable the accelerator defines starts with SA_", () => {
    const found = unprefixedEnvVars(ACCELERATOR).map((f) => `${f.file}:${f.line} ${f.name} (${f.how})`);
    assert.deepEqual(found, [], `rename these to SA_ names:\n${found.join("\n")}`);
  });

  test("the check catches each way a variable is defined or read, and ignores external names and test data", () => {
    const root = tree({
      "scripts/a.ts": [
        "const now = process.env.READINESS_NOW;",
        "const img = process.env['MY_IMAGE'];",
        "env.MY_SEED = '1';",
        "run(repo, args, { MY_RUNTIME: \"none\" });",
        "const ok = process.env.SA_READINESS_NOW ?? process.env.CURSOR_API_KEY ?? process.env.PATH;",
        "const KIND_CHECK: Record<string, string> = {};",
        "const note = blocked ? INSTALL_BLOCKED : \"x\";",
        "write(\"src/db.js\", \"export const url = process.env.DATABASE_URL;\");",
      ].join("\n"),
      ".github/workflows/ci.yml": "env:\n  ACCELERATOR_REF: v1\n  SA_ACCELERATOR_REPO: x\njobs:\n  a:\n    steps:\n      - run: $READINESS scan && echo ok >> \"$GITHUB_OUTPUT\"\n        with:\n          ref: ${{ env.ACCELERATOR_REF }}\n",
      "README.md": "```bash\nexport MY_TOKEN_DIR=/tmp\nSA_READINESS_IMAGE=x npm run check\nCURSOR_API_KEY=... npm run evals\n```\n",
      "fixtures/x/repo/app.js": "process.env.CUSTOMER_KEY",
    });
    const found = unprefixedEnvVars(root).map((f) => `${f.file}:${f.line} ${f.name} (${f.how})`);
    assert.deepEqual(found, [
      ".github/workflows/ci.yml:2 ACCELERATOR_REF (a workflow env key)",
      ".github/workflows/ci.yml:7 READINESS (a shell reference)",
      ".github/workflows/ci.yml:9 ACCELERATOR_REF (a workflow reference)",
      "README.md:2 MY_TOKEN_DIR (a shell assignment)",
      "scripts/a.ts:1 READINESS_NOW (read in code)",
      "scripts/a.ts:2 MY_IMAGE (read in code)",
      "scripts/a.ts:3 MY_SEED (set on an env object)",
      "scripts/a.ts:4 MY_RUNTIME (an env object key)",
    ]);
  });
});
