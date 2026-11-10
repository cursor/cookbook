# Question bank

Ask only the questions whose gap survived discovery. Each question names what you found and offers it as an option. Phrase options so the first one is your best guess.

Use the `AskQuestion` tool. One call holds up to 5 questions. Order them by impact on validation.

## Round 1 — can the loop validate at all?

**Surface.** "Which surfaces should validation exercise for a typical slice?"
Options: detected surfaces (multi-select) · "Only the surface the slice touches" · Other.

**Boot.** "How should the loop start the app for end-to-end checks?"
Options: detected dev command on the chosen port · `docker compose up <services>` · "There is no runnable app; validate through tests only" · Other.

**External services and secrets.** "We found references to <services>. How should the loop handle them?"
Options: "Mock at the network boundary (MSW/nock/responses)" · "Use local emulators or containers" · "Use sandbox credentials from env vars (the agent never sees values)" · Other.

**Auth.** "E2E flows hit authenticated routes. How should the loop sign in?"
Options: "Mock session/JWT injected in test setup" · "Seeded test user via seed script" · "Auth is disabled in dev" · Other.

**Canonical commands** (only when sources disagree). "CI runs `<a>`, README says `<b>`. Which should the loop treat as the gate?"
Options: `<a>` · `<b>` · Other.

## Round 2 — what does a good slice look like here?

**Slice size.** "What is the largest change one loop run should attempt?"
Options: "One user-visible behavior + its tests" · "One endpoint or component" · "One ticket, whatever it takes" · Other.

**Definition of done.** "Which gates must pass before a slice goes to review?" (multi-select)
Options: lint · typecheck · unit tests · E2E flows · build · visual check of changed screens · Other.

**Test placement.** "Where should new tests live?"
Options: detected convention (for example colocated `*.test.ts`) · `tests/` mirror tree · Other.

**Off-limits.** "Anything the loop must never touch?"
Options: detected generated dirs · migrations · public API contracts · "Nothing special" · Other.

**Domain context.** "Is there domain knowledge we should load that isn't in the repo? (attach or link it)"
Options: "I'll attach docs now" · "Ticket/spec links" · "No, the code is enough" · Other.

## Round 3 — what does the reviewer want to see?

**Evidence format.** "What should the review packet lead with?" (multi-select)
Options: "Screenshots of changed screens" · "Short screen recording of the main flow" · "API request/response transcripts" · "Test summary only" · Other.

**Report persistence.** "Where should review packets live?"
Options: "Cloud agent artifacts only (gitignored runs)" · "Commit the report markdown with the change" · Other.

**PR policy.** "When a slice passes review, what should happen?"
Options: "Open a draft PR" · "Commit and push only" · "Leave changes uncommitted" · Other.

**Iteration budget.** "How many implement→validate retries before the loop stops and asks?"
Options: 3 · 5 · 1 · Other.

## Autonomous-mode defaults

When nobody is present to answer, use these and log each under `## Assumptions` in `LOOP.md`:

| Gap | Default |
| --- | --- |
| Surfaces | every detected surface that the slice touches |
| Boot | detected dev command on a fixed uncommon port that differs from the app's default |
| External services | mock at the network boundary; never call real services |
| Auth | mock session injected in test setup |
| Slice size | one user-visible behavior plus its tests |
| Gates | every gate that ran green during discovery |
| Test placement | follow the dominant existing convention |
| Off-limits | generated dirs, lockfiles (except via the package manager), migrations already applied |
| Evidence | screenshots and a short recording for UI; transcripts for API/CLI (record in `LOOP.md`; do not write `context/review.md` from assumptions alone) |
| Persistence | gitignored runs, exported to cloud agent artifacts |
| PR policy | commit and push only (`push: false` when the repo has no remote) |
| Iterations | 3 implement retries, 1 re-plan |
