import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ContainerSession, HOME_DIR, SETUP_HOME, detectRuntime, homeCommand, hostUser, imageUserArgs } from "../skill/agent-readiness/scripts/lib/container.ts";
import { containerImage, discoverContract, requiredPython } from "../skill/agent-readiness/scripts/lib/contract.ts";
import { diagnose } from "../skill/agent-readiness/scripts/lib/diagnose.ts";
import { buildProfile } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { environmentLimit } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import type { ContractCommand } from "../skill/agent-readiness/scripts/lib/types.ts";

const rubric = loadRubric("2026-11-alpha");
const cmd = (kind: ContractCommand["kind"]): ContractCommand => ({ id: `cmd-app-${kind}`, kind, component: "app", cwd: ".", command: "x", source: "readiness", reason: "x", timeoutSec: 600 });
const audit = { where: "container" as const, image: "node:22-bookworm", imageSource: "audit" as const };
const repoImage = { ...audit, imageSource: "repo" as const };

function tree(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "readiness-env-")), "repo");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

// Output from real-repo runs (Cleo and the FastAPI template).
const POETRY_VERBOSE = `  | All attempts to connect to pypi.org failed.
  |
  | Probable Causes:
  |  - the server is not responding to requests at the moment
  | Exception:
  |     | ("Connection broken: PermissionError(13, 'Permission denied')", PermissionError(13, 'Permission denied'))`;
const NPM_ROOT_CACHE = `npm error code EEXIST
npm error Your cache folder contains root-owned files, due to a bug in
npm error previous versions of npm which has since been addressed.
npm error To permanently fix this problem, please run:
npm error   sudo chown -R 501:20 "/tmp/home/.npm"`;
const NPM_EACCES = `npm error code EACCES
npm error syscall mkdir
npm error path /tmp/home/.npm/_cacache/index-v5/3c
npm error errno -13`;
const PIP_MISMATCH = "ERROR: Package 'app' requires a different Python: 3.11.2 not in '<4.0,>=3.14'";
const PLAYWRIGHT = `Error: browserType.launch: Executable doesn't exist at /tmp/home/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell
╔════════════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.       ║
║ Please run the following command to download new browsers: ║
║     npx playwright install                                 ║
╚════════════════════════════════════════════════════════════╝`;

describe("a home or cache directory the audit's user can't write is this machine's limit", () => {
  test("Poetry's PermissionError, npm's root-owned cache and EACCES on a cache path are permission, not network or unknown", () => {
    assert.deepEqual(diagnose(POETRY_VERBOSE, false, "install"), { cause: "permission", detail: "a permission error on a cache or home directory, which the tool reported as a failed connection" });
    assert.deepEqual(diagnose(NPM_ROOT_CACHE, false, "build"), { cause: "permission", detail: "the npm cache in the home directory belongs to another user" });
    assert.deepEqual(diagnose(NPM_EACCES, false, "install"), { cause: "permission", detail: "the audit's user can't write /tmp/home/.npm/_cacache/index-v5/3c, a home or cache directory" });
    assert.equal(diagnose("PermissionError: [Errno 13] Permission denied: '/tmp/home/.cache/pypoetry/virtualenvs'", false, "install").cause, "permission");
    for (const kind of ["install", "build", "test"] as const) assert.equal(environmentLimit(repoImage, cmd(kind), diagnose(NPM_ROOT_CACHE, false, kind), []), "the npm cache in the home directory belongs to another user on this machine", `${kind} is blocked, even in the repo's own image`);
  });

  test("a permission error on the repo's own files is still the repo's, and Poetry's bare connection failure is network", () => {
    assert.notEqual(diagnose("Error: EACCES: permission denied, open '/work/src/config.json'", false, "test").cause, "permission");
    assert.deepEqual(diagnose("  | All attempts to connect to pypi.org failed.", false, "install"), { cause: "network", detail: "a network connection failed" });
  });

  test("the audit's own setup gets its own HOME, and the shared one goes back to the ordinary user", () => {
    const args = imageUserArgs("c", "npm install -g bun@1");
    assert.deepEqual(args.slice(0, 4), ["exec", "-e", `HOME=${SETUP_HOME}`, "c"]);
    assert.notEqual(SETUP_HOME, HOME_DIR);
    assert.equal(homeCommand("501:20"), `mkdir -p ${HOME_DIR} && chmod 1777 ${HOME_DIR} && chown -R 501:20 ${HOME_DIR}`);
    assert.equal(homeCommand(null), `mkdir -p ${HOME_DIR} && chmod 1777 ${HOME_DIR}`);
  });

  test("Poetry installs verbosely, so a failed download says why", () => {
    const dir = tree({ "pyproject.toml": "[tool.poetry]\nname = \"cleo\"\n", "poetry.lock": "# This file is automatically @generated by Poetry 2.2.1 and should not be changed by hand.\n", "cleo/__init__.py": "" });
    const contract = discoverContract(buildProfile(dir, dir, rubric), dir, rubric, []);
    assert.equal(contract.find((c) => c.id === "cmd-repo-install")?.command, "POETRY_VIRTUALENVS_IN_PROJECT=true poetry sync --no-interaction -v");
  });
});

describe("a Python or Playwright the image doesn't have is blocked, not a repo failure", () => {
  test("requires-python the image can't satisfy is a missing tool, blocked in the audit's image", () => {
    const d = diagnose(PIP_MISMATCH, false, "install");
    assert.deepEqual(d, { cause: "missing_tool", detail: "Python <4.0,>=3.14 is not installed" });
    assert.equal(environmentLimit(audit, cmd("install"), d, []), "Python <4.0,>=3.14 is not installed in the audit's image (node:22-bookworm)");
    assert.equal(environmentLimit(repoImage, cmd("install"), d, []), undefined, "the repo's own image is the repo's to fix");
    assert.equal(diagnose("error: No interpreter found for Python >=3.14 in virtual environments, managed installations, or search path", false, "install").detail, "Python >=3.14 is not installed");
    assert.equal(diagnose("The currently activated Python version 3.12.3 is not supported by the project (>=3.14).", false, "install").detail, "Python >=3.14 is not installed");
  });

  test("the audit picks a Python image new enough for requires-python", () => {
    const uv = tree({ "pyproject.toml": "[project]\nname = \"app\"\nrequires-python = \">=3.14,<4.0\"\n", "uv.lock": "", "app/main.py": "" });
    assert.equal(requiredPython(uv), "3.14");
    assert.equal(containerImage(buildProfile(uv, uv, rubric), uv), "ghcr.io/astral-sh/uv:python3.14-bookworm-slim");
    const poetry = tree({ "pyproject.toml": "[tool.poetry]\nname = \"app\"\n\n[tool.poetry.dependencies]\npython = \"^3.13\"\n", "poetry.lock": "", "app/main.py": "" });
    assert.equal(containerImage(buildProfile(poetry, poetry, rubric), poetry), "python:3.13-slim");
    const old = tree({ "pyproject.toml": "[project]\nname = \"app\"\nrequires-python = \">=3.9\"\n", "requirements.txt": "", "app/main.py": "" });
    assert.equal(containerImage(buildProfile(old, old, rubric), old), "python:3.12-slim", "an older floor keeps the default");
    const pinned = tree({ "pyproject.toml": "[project]\nname = \"app\"\nrequires-python = \">=3.14\"\n", ".python-version": "3.13\n", "uv.lock": "", "app/main.py": "" });
    assert.equal(containerImage(buildProfile(pinned, pinned, rubric), pinned), "ghcr.io/astral-sh/uv:python3.13-bookworm-slim", ".python-version wins");
  });

  test("Playwright's missing browsers are a missing tool, blocked in the audit's image", () => {
    const d = diagnose(PLAYWRIGHT, false, "test");
    assert.deepEqual(d, { cause: "missing_tool", detail: "Playwright's browsers are not installed" });
    assert.equal(environmentLimit(audit, cmd("test"), d, []), "Playwright's browsers are not installed in the audit's image (node:22-bookworm)");
  });
});

const runtime = detectRuntime("auto");
const user = hostUser();

describe("in a container, setup as root leaves the shared home writable", { skip: !runtime ? "no container runtime" : !user ? "running as root, so commands run as the image's user" : false }, () => {
  test("caches a root setup step writes don't block the ordinary user", { timeout: 120000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "readiness-env-work-"));
    const session = new ContainerSession(runtime!, `readiness-env-test-${process.pid}`, "node:22-bookworm-slim", work, [], user);
    assert.ok(session.start().ok, "container starts");
    try {
      const setup = session.asImageUser('mkdir -p "$HOME/.npm/_cacache" "$HOME/.cache/pip" && echo "$HOME"');
      assert.equal(setup.output.trim(), SETUP_HOME, "setup writes its caches outside the shared home");
      // Docker Desktop runs exec with umask 022, so caches root writes are closed to other users.
      session.asImageUser(`umask 022 && mkdir -p ${HOME_DIR}/.npm/_cacache ${HOME_DIR}/.cache/pip`);
      const before = await session.exec('mkdir -p "$HOME/.npm/_cacache/x"', ".", 60);
      assert.notEqual(before.exitCode, 0, "a root-owned cache shuts the ordinary user out");
      assert.equal(diagnose(before.output, false, "build").cause, "permission");
      session.reclaimHome();
      const out = await session.exec('mkdir -p "$HOME/.npm/_cacache/x" "$HOME/.cache/pypoetry" && npm cache verify >/dev/null && echo ok', ".", 60);
      assert.equal(out.exitCode, 0, out.output);
      assert.match(out.output, /ok/);
    } finally {
      session.stop();
    }
  });
});
