# Remediate: fix a readiness blocker and prove it

Read this only when the user explicitly asks you to fix something, for example "fix the primary blocker" or "set up the environment for agents". An audit never remediates on its own.

The rules in [SKILL.md](SKILL.md) still hold. You don't decide that a fix worked: a new audit or a recheck does.

## Before you start

1. Take the step the user named, or the first step under "What moves the needle next" in `.agent-readiness/latest/report.md` (it is also part 1's "Next move"). Read its "Why it matters", "Done when" and steps in part 5.
2. Work on a new branch. The audit reads `git archive HEAD`, so a fix only counts once it's committed.
3. If the item lists a decision ("Decision needed: ..."), ask the user before acting on it, unless they already gave the answer.

## The environment setup contract

For an item about install, build or test setup in a clean checkout, such as "Set up the service the tests expect on port 5432 for agents in api", produce committed setup files that a clean container can run:

1. `readiness draft-env --remediate` writes:
   - `scripts/agent-install.sh`: system packages, then the repo's frozen install. Safe to rerun.
   - `scripts/agent-start.sh`: starts local services and waits until they're ready (for Postgres, until `pg_isready` answers). Safe to rerun.
   - `.cursor/environment.json` with only `name`, `install` and `start`. The schema rejects other fields, so add nothing else.
   - With `--dockerfile`, also `.cursor/Dockerfile`, built from the replay's base image plus the system packages, and referenced from `environment.json` as `build`. Write one only when the user wants a custom image. If the repo already uses a devcontainer, extend that instead.

   It picks services from the audit's diagnosis and from the images in a root `compose.yml` (or `docker-compose.yml`), and starts them without Docker. When the repo has a `.env.example`, the install script copies it to `.env` if there is none. Pass `--service postgres,redis` when neither names them; `--service` replaces both lists.
2. Read both scripts. They must start only local services and name no production hosts or credentials.
3. Commit the files.
4. Prove it: run a new audit (`readiness init --force --tier <tier>`, with the same `--scenario` as before if any, `readiness scan`, `readiness replay`, `readiness seal`). The item is done only when the new report shows it closed. If the replay still fails, read the failing evidence, fix the scripts, commit, and audit again.
5. Tell the user that committing `.cursor/environment.json` doesn't change a Cloud Agent environment by itself. A team admin points the Cloud Agent environment at the file. Never claim you configured Cloud Agents.

## The verify skill

Once the component's commands pass in a clean container:

1. `readiness draft-skill --remediate` writes `.cursor/skills/verify/SKILL.md` from `templates/verify-skill.md`. It holds only commands the audit ran and saw pass, in the order doctor, install, verify, plus a failure playbook built from failures earlier audits observed. It refuses any command the audit didn't run.
2. Don't add commands by hand. To include another command, add it to the contract in a new audit and let it pass there.
3. Commit it, then prove it with `readiness recheck`, which reruns the same commands.

## Tests that don't catch planted faults

For an item like "Make worker's tests catch wrong behavior":

1. The report names the file and the kind of fault, never the line or the edit. Don't look for planted-fault details in `.agent-readiness/`. The next audit plants fresh faults from a new seed, so tests aimed at old faults don't help.
2. Decide the intended behavior of the named files with the user when it isn't obvious, then write tests that assert results and edge cases.
3. Never delete tests, add skip markers or loosen assertions. `readiness diff` flags all three.
4. Prove it with a new audit: the fresh planted faults in that component must all be caught.

## Stale agent instructions

Fix each listed item in AGENTS.md, rules, skills or the README: the wrong package manager, a script that doesn't exist, a missing path. Then prove it with a new audit; its replay reruns every instruction command.

## Safety findings

- **Committed secrets:** rotating them is the owner's decision. Never print a secret's value. Move the value to the secret store and remove it from the repo.
- **An install hook that pipes a download into a shell:** vendor the script and review it, or remove the hook.
- **Tests that read production credentials:** replace them with a fake or a sandbox value from checked-in test config.

## After the fix

1. Run `readiness diff` between the previous audit and the new one. Report the level changes and any weakened-test flags.
2. Summarize for the user: what changed, the item closed, the level before and after, and what the report now lists next.
3. Open a PR with the fix and the updated `.agent-readiness/roadmap.json` and `.agent-readiness/latest/`.
