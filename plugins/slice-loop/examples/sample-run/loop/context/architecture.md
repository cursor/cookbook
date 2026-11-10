# Architecture

## Map

| Path | What lives here |
| --- | --- |
| `server.js` | HTTP server (`node:http`): JSON API under `/api/tasks`, static files from `public/` |
| `src/tasks.js` | `createStore(seed)`: in-memory task store with `list()` and `add(title)` |
| `public/index.html` | The single page: add form (`#add-form`, `#title`) and task list (`#list`), inline CSS |
| `public/app.js` | Browser script: renders the list, submits the form via `fetch` |
| `test/` | `node:test` unit tests for `src/` |

## Entrypoints

- HTTP API: `server.js` — `GET /api/tasks` → 200 list; `POST /api/tasks` `{ title }` → 201 task. Errors are JSON `{ error: "<message>" }` via the `json(res, status, body)` helper.
- Web UI: `public/index.html` loads `public/app.js` as a module.

## Conventions the loop must follow

- ES modules, Node standard library only. Do not add dependencies.
- Two-space indent, double quotes, semicolons.
- API errors use `json(res, <status>, { error: "<Human message>" })`.
- Styling is inline in `index.html` using its existing palette (`#26251e` text, `#f54e00` accent, `#e1e0db` borders). Do not add new colors without reason.
- `npm run lint` is only `node --check` on each file; add new source files to the `lint` script.

## Things that look editable but are not

- None. Nothing in the repo is generated.
