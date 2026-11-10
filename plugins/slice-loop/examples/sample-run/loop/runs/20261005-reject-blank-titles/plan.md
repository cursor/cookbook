# Plan: Reject blank task titles

**Slice:** `20261005-reject-blank-titles` · **Surfaces:** http-api, web-ui · **Requirement:** [slice.md](./slice.md)

## Goal

Callers and users can no longer create tasks with empty or whitespace-only titles. The API answers 400 with `{ "error": "Title is required" }`, and the page shows that message under the input until the next successful add.

## Acceptance criteria

| ID | Given / When / Then | Proof |
| --- | --- | --- |
| AC-1 | Given the server is running, when a caller POSTs `/api/tasks` with `{ "title": "" }`, then the response is 400 with body `{ "error": "Title is required" }` and `GET /api/tasks` is unchanged. | integration: `test/api.test.js` |
| AC-2 | Given the server is running, when a caller POSTs a whitespace-only title (spaces, tab, newline), then the response is 400 with the same body and no task is created. | integration: `test/api.test.js` |
| AC-3 | Given the server is running, when a caller POSTs `{}` (no title), then the response is 400 with the same body and no task is created. | integration: `test/api.test.js` |
| AC-4 | Given the task board, when the user submits an empty title and then a whitespace-only title, then "Title is required" appears directly under the input each time and the list does not grow. | e2e: `flows/blank-title.mjs` |
| AC-5 | Given the message is showing, when the user submits a valid title, then the task is added and the message disappears. | e2e: `flows/blank-title.mjs` |

## Approach

- `server.js`: in the `POST /api/tasks` branch, return `json(res, 400, { error: "Title is required" })` when `title` is not a string or is blank after trim. Follows the existing `json()` error pattern.
- `public/index.html`: add an empty message element (`#title-error`, `role="alert"`) between the form and the list, styled with the existing palette; point the input's `aria-describedby` at it.
- `public/app.js`: on submit, read the response; on a non-2xx status show `body.error` in `#title-error` and keep the list as is; on success clear the message, clear the input, and refresh.
- `test/api.test.js` (new): spawn `server.js` on port 4399 with `SEED=0`, exercise AC-1..3 over real HTTP.
- `.cursor/loop/flows/blank-title.mjs` (new): AC-4..5 in the browser.

## Evidence plan

- New flows: `blank-title`: open board → submit empty → check message under input and count → submit whitespace → check again → submit a valid title → check task added and message gone.
- Regression flows: `create-task`.
- API transcripts: curl for AC-1..3 (`raw/api-AC-n.txt`).
- Captures: `AC-4-error` (message under input), `AC-5-cleared` (task added, no message). Recording of `blank-title`. Desktop only.

## Non-goals

- Client-side validation without a request; the message comes from the API's error body.
- Title length limits, duplicate detection, or editing/deleting tasks.

## Risks

- `readBody` throws on malformed JSON and the server answers 500; unchanged by this slice, but a reviewer may expect 400. Out of scope.
- The UI previously ignored the POST response; if error handling is wrong a valid add could stop refreshing. The `create-task` regression flow catches that.

## Assumptions

- A missing or non-string `title` counts as blank (AC-3), because today it creates a task titled "undefined". Say so if missing titles should be handled differently.
- The UI shows the server's message rather than validating locally, so the API stays the single source of the rule. Say so if you want an instant client-side check as well.
- The message element sits between the form and the list ("inline under the input"), in the page's existing accent color `#f54e00` (no new colors).

## Later slices

- Return 400 instead of 500 for malformed JSON bodies.

## Feedback log

<!-- Appended verbatim on re-plan. -->
