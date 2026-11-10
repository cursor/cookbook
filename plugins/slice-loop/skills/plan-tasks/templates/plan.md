# Plan: <slice title>

**Slice:** `<slice-id>` · **Surfaces:** <web-ui, http-api, ...> · **Requirement:** [slice.md](./slice.md)

## Goal

<One or two sentences: what a user or caller can do after this slice that they could not before.>

## Acceptance criteria

| ID | Given / When / Then | Proof |
| --- | --- | --- |
| AC-1 | Given <state>, when <action>, then <observable result>. | unit: `<file>` |
| AC-2 | Given <bad input>, when <action>, then <error shown/returned>. | e2e: `<flow>` |

## Approach

- <Files to add or change, one line each, with the reason.>
- <Pattern being followed: `<existing file>`.>

## Evidence plan

- New flows: <flow name: 3–6 steps>.
- Regression flows: <canonical flows from context/validation.md>.
- Captures: <screens and states; recording yes/no>.

## Non-goals

- <What this slice deliberately does not do.>

## Risks

- <What could break, and how validation will catch it.>

## Assumptions

- <Decision — why — what the user could say instead.>

## Later slices

- <Follow-up slices, one line each.>

## Feedback log

<!-- Appended verbatim on re-plan. -->
