---
name: verify
description: Check a change in {{repo}} before pushing. Runs the setup check, install and the build, lint, type-check and test commands that the agent readiness audit {{auditId}} ran and saw pass.
---

# Verify a change in {{repo}}

Run these in order from the repository root. Stop at the first failure and use "If it fails" below.

Every command here passed in audit `{{auditId}}` ({{strengthLabel}}). Do not add commands that the audit did not run; rerun the audit instead.

## Doctor

{{doctor}}

## Install

{{install}}

## Verify

{{verify}}

## If it fails

{{playbook}}
