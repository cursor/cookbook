# The checks (rubric 2026-11-alpha)

Six checks, plus an informational inventory of agent assets. The checks are the same under 2026-10-alpha; 2026-11-alpha changed Levels 3 and 4, the repo rollup and the action matrix, which [levels.md](levels.md) describes. What the audit supports, stack by stack, is in [supported.md](supported.md). Each check lists what it runs, when it passes, the evidence strength it needs, why it matters, and the usual fixes.

Evidence strength, weakest to strongest: stated in docs (`asserted`), read from files (`static`), ran on host (`executed`), ran in a clean container (`clean_replay`), confirmed by outcomes (`outcome_validated`). A check passes only at its required strength. A pass below it reads "not proven", never "passed".

## `scope.profile`: components and where changes land

Informational. Walks the whole tree for manifests at any depth: workspace packages (npm, pnpm and yarn workspaces), standalone Node and Python packages, and projects in toolchains the audit doesn't support yet (`.csproj`, `.fsproj` and `.vbproj` projects, `.sln` solutions, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle`, `Gemfile`, `composer.json`, `Package.swift`, `pubspec.yaml`, and any folder of `.tf` files, root module included). Each becomes a component with its own scripts, lockfile and install. Next to a root package, a nested package counts only with its own lockfile. A solution groups the projects under it; a root with several solutions is named after the one that matches the repo, or after the repo. Unsupported components are listed as not assessed with the reason ("isn't supported yet", linking [supported.md](supported.md)) and keep their share of changes. Poetry, Bun, Yarn 2 or later and uv workspaces are installed with their own frozen install; each member of a uv workspace is a component, installed from the root `uv.lock`. Yarn 2 or later with no version pin is recognised and not assessed yet, rather than installed with the wrong Yarn.

A Python, PHP or Ruby app next to a root `package.json` is its own component, not assessed, and takes the root's files of its type plus everything that isn't a Node file. When the root package has no test script, it goes with that app and isn't assessed on its own either; the report says so, so release tooling at the root never makes the repo "have no tests".

A nested manifest under a folder that usually holds tests, samples or tooling (`test`, `tests`, `spec`, `e2e`, `sample`, `example`, `demo`, `bench`, `plugin`, `util`, `config`), another toolchain's project under a packaging or platform folder (`HomebrewFormula`, `pkg`, `packaging`, `android`, `ios`), or a shared config package such as `@acme/eslint-config`, is a satellite: it's listed in part 5, not made a component, and only becomes one when the repo has nothing else to assess.

Each component's share counts changed files over 90 days. Bot authors, lockfile-only commits, generated files and renames don't count. The most active six supported components are assessed; when there are more, the report labels the scope "sampled" and lists the rest. Part 5 lists every component found, included or excluded, with its path, toolchain, manifest, lockfile and reason. Whenever a component that isn't assessed holds a share of changes, part 1 says how much, by name.

## `scope.agent_assets`: agent assets in the repo

Informational and never scored. Lists AGENTS.md and CLAUDE.md, skills (`.cursor/skills`, `.claude/skills`, `.agents/skills`), rules, hooks, environment config, MCP config and Copilot instructions, with git authors, the last change and whether their commands replay. Skill frontmatter must have a `name` and a `description`. It shows who in the repo already builds agent setup; it is never a reason for a recommendation by itself.

## `bootstrap.cold_replay`: setup works from a clean checkout

- **Runs:** the frozen install (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `uv sync --frozen`, or a virtualenv install from requirements), then each component's build and full test suite, in a clean container started from the repo's pinned toolchain. The network is on for install and build, and off for tests. A repo-declared `.cursor/environment.json` install and start replace the defaults, and a declared `.cursor/Dockerfile` is built and used as the image.
- **Passes:** each step exits 0 in the container. A pass on the host or in a fresh copy on the host is "blocked on this machine", because it can't rule out a service or tool the machine already had.
- **Blocked, not failed:** with no container runtime, a step that fails because this machine lacks a tool (`dotnet: command not found`), a setup command that uses `sudo`, and every step behind a blocked install are blocked. In a container, a tool missing from an image the audit picked (not one the repo declared), a network, TLS, certificate or proxy error, or an HTTP error from a package mirror (apt's `403  Forbidden` from deb.debian.org, or a 403, 407, 429 or 5xx from npm, Yarn, pnpm or PyPI), during the doctor, install, build or start step, and a build or test that fails because a sibling workspace package wasn't built first are blocked too. So are, at any step, a home or cache directory the audit's user can't write (`EACCES`, a `PermissionError`, npm's root-owned cache), a Python older than the project's `requires-python`, and Playwright browsers that aren't installed, unless the repo's own image is the one missing them. Commands share `HOME=/tmp/home`, which belongs to the user they run as; the audit's own setup as the image's user writes its caches elsewhere. Where no `.python-version` pins one, the audit's Python image is new enough for `requires-python`. Blocked never counts against the repo and never counts as met. When the repo's declared image installs the missing tool, the report says so. The container gets the host's `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`, and its CA settings (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `PIP_CERT`) with the files they name mounted read-only.
- **Also records:** whether a frozen install left the lockfile unchanged, and whether the toolchain is pinned (`.nvmrc`, `engines.node`, `packageManager`, `.python-version`). Repo-wide changes need both.
- **Needs:** ran in a clean container.
- **Why:** every agent starts from a clean checkout, so setup that only works on a prepared machine breaks every agent run. In the BootstrapAgent study, a reusable, verified setup cut later agents' token use by 25.9% and build time by 22.3%, measured on the study's benchmark repositories ([arXiv 2605.15815](https://arxiv.org/abs/2605.15815), [code](https://github.com/Vossera/BootstrapAgent)).
- **Usual fixes:** a service the tests expect on localhost (start it in the setup's start script), a credential the tests read (fake it), a lockfile that isn't committed, a registry token (pass its name with `--registry-env`).

## `verify.canonical_interface`: build, lint, type-check and test commands pass

- **Runs:** every discovered or documented build, lint, type-check and test command at `HEAD`. Lint runs before the build, so it never reads build output; one that fails there runs again after a build that passed. Lint and type-check run check-only: write flags such as `--write`, `--fix` and `--unsafe` are removed, `prettier`, `ruff format`, `black` and `isort` run in their check mode, and the report shows the command that ran next to the one the repo declares. The supported tools are listed in [supported.md](supported.md).
- **Passes:** all of them exit 0, and a test command exists. Stale documented commands count as failed, not missing. A lint or type-check that still changes the repo's files fails, and the files are put back before faults are planted.
- **Needs:** ran on host or stronger.
- **Why:** agents need one known way to check their own work before they push.
- **Usual fixes:** fix the failing command on the main branch; add a missing test or lint script.

## `verify.behavioral_oracle`: tests catch planted faults

- **Runs:** in a throwaway copy, the scripts plant up to 5 faults per component in files the component's tests import, most recently changed first. The operators flip a comparison boundary, negate a condition, shift by one, swap a boolean return, drop a throw or early return, or change a constant. The seed is fresh for each audit, so planted faults can't be learned. TypeScript, JavaScript and Python are supported.
- **Flake guard:** the suite must pass twice before any fault is planted. A fault counts as caught only if the suite fails on two runs. A fault that breaks compilation is discarded, not counted.
- **Passes:** every counted fault is caught, and at least 3 gave a clear result. Coverage alone never passes.
- **Needs:** ran on host or stronger. Level 2 also needs Level 1, which needs a clean container.
- **Why:** green tests aren't proof that a change is right.
  - OpenAI's SWE-Bench Pro audit flagged 200 of the 731 public tasks automatically (27.4%) and found 249 in human review (34.1%), so OpenAI estimates about 30% are broken, including low-coverage tests that let incomplete fixes pass. Caveat: an audit of one benchmark ([Jul 8, 2026](https://openai.com/index/separating-signal-from-noise-coding-evaluations)). It also sets a design rule here: a planted fault must be one any correct suite catches, not one tied to a particular implementation.
  - OpenAI's SWE-bench Verified audit found material test or description flaws in 59.4% of 138 tasks that o3 failed inconsistently. Caveat: that rate is within a selected subset of about 27.6% of the benchmark, not the whole benchmark.
- **Usual fixes:** tests that assert results and edge cases instead of only calling the code.

## `context.instructions_verified`: agent instructions are accurate

- **Reads:** AGENTS.md and CLAUDE.md at any depth, `.cursor/rules`, `.github/copilot-instructions.md` and `.instructions.md` files, skills, and the root README.
- **Static pre-pass:** each command and path is checked first, by file and line: the wrong package manager, a script missing from `package.json`, a missing Make target, a path that doesn't exist.
- **Replay:** every remaining command runs in the clean container, inside `--budget-total`: each gets what's left of it, up to 5 minutes, and none starts once it's spent. Install commands are checked statically, since the replay runs the frozen install. Long-running commands (dev servers, watchers) and risky ones (deploy, publish, delete, network piped into a shell) are listed and not run.
- **Skipped:** commands with a placeholder to fill in (`<component>`), commands that ask questions (`init`, `create`, `login`), commands that add or remove packages (`pnpm add`, `npm i <pkg>`), and every command in a vendored third-party skill are listed as skipped and never run. A skill is vendored when `skills-lock.json` lists it, a license ships with it, or its frontmatter names a `source`. An instruction file reached twice, through a symlink or as an identical skill copy, is checked once.
- **Passes:** no item fails and every replayable command replayed.
- **Needs:** ran on host or stronger.
- **Why:** agents follow these files literally, so a stale command costs more than a missing one. The conventions scanned are AGENTS.md (Codex's `/init` and its root-to-folder discovery), GitHub's `copilot-instructions.md` and path-specific `.instructions.md`, and Cursor's `.cursor/rules` plus AGENTS.md. No outcome study yet measures how much these files help.

## `safety.execution_boundary`: normal work needs no production access

- **Fails on:** committed secrets (reported by type and line, never the value) outside tests, fixtures, docs, examples and generated code, tests that read production credentials (an environment variable with `PROD`, `PRODUCTION` or `LIVE` as a word of its name and a secret word such as `KEY`, `TOKEN`, `PASSWORD`, `DSN` or `URL`, so `STRIPE_LIVE_KEY` counts and `PRODUCT_DATABASE_URL` doesn't; or a test failure that names a missing key, secret, token or password), and install hooks that pipe a download into a shell.
- **Lists for review without failing:** a secret-shaped value in a test, fixture, doc, example or generated file (such as `tests/`, `__tests__/`, `integration-tests/`, `test-utils/`, `*.test.js`, `*.spec.ts`, `docs/`, a Markdown file, `.env.example` or `__generated__/`), which is almost always a dummy, other install hooks, destructive scripts, deploy or publish scripts, and any setup or script that runs `sudo`.
- **Needs:** read from files.
- **Why:** agents run with whatever access setup gives them, so normal work must never need production credentials, and setup must not need more privilege than a container gives it. When a hook pipes a download into a shell, the replay installs with `--ignore-scripts` instead of running it. A command that uses `sudo` runs only inside the throwaway container, never on the host.

## Other signals (informational)

Part 5 lists five signals read from files. None of them sets a level, adds a roadmap step or appears in part 1.

- **CI config:** a GitHub Actions, GitLab CI, CircleCI or Buildkite config, and whether it runs tests.
- **A way to run one test file:** whether each assessed component's test runner takes a file or a name filter (`node --test`, vitest, jest, mocha, pytest), so an agent can rerun only the tests near its change.
- **Sample env file:** when the code reads environment variables of its own, whether a `.env.example` or similar names them.
- **Worktree and port isolation:** fixed ports and machine-specific absolute paths in package scripts, the environment setup, Makefiles, shell scripts and compose files, which collide when two agents work in separate worktrees.
- **AGENTS.md length:** the root AGENTS.md's word count, marked long over 900 words, since agents load all of it on every task.

An environment setup whose install or start uses `sudo` is listed in the agent assets as not a working setup, and `draft-skill` never puts a sudo command into agent setup.

## Met, not met, blocked and unknown

Every condition ends in one of four states. Met and not met come from a run at the strength the check needs. Blocked means a limit of this machine kept the deciding run from happening. Unknown means it didn't run for another reason, such as the time budget. A level needs every condition met.

No real results, no level: when no Level 1 check ran and passed, or failed for a reason in the repo, the report gives no level, plans no actions, adds no roadmap steps and says why. That covers an audit where no component could be assessed, where every check was blocked on this machine, and the read-only tier.

The report names each condition that holds the level where it is, and gives a confidence (high, medium or low) with its reasons. Confidence drops when setup ran on the host, a deciding check was blocked, part of the recent changes isn't assessed, or the scope was sampled. It's reported next to the level and never raises it.

## Why scripts own the results

The session that audits may later remediate. Factory's GDAL result reports 89.8% on a held-out suite with a separate validation system, against 35.8% for the same model working as a single agent. Caveat: one reported task ([repo](https://github.com/Factory-AI/pb-gdal-fable), [write-up](https://factory.ai/news/what-it-takes-for-coding-agents-to-complete-large-software-tasks)). So this skill keeps the grading out of the agent's hands: scripts create the evidence, plant the faults, compute the levels, seal the audit with a digest of the scripts and rubric, and flag weakened tests in `diff`.

## Not assessed by this rubric

Whether CI matches the local commands, flaky tests, the quality of error messages, how easily code can be found, and outcome checks on held-out tasks. The report names these as "not assessed", which is different from unknown.
