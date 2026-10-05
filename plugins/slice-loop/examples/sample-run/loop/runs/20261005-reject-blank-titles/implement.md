# Implement log

## Iteration 1
- Fixed: AC-1, AC-2, AC-3 (blank or missing title accepted — added a guard in the `POST /api/tasks` branch of `server.js` that answers `json(res, 400, { error: "Title is required" })`)
- Fixed: AC-4, AC-5 (UI ignored the POST result — `public/app.js` now shows the API's `error` in `#title-error` on a non-2xx response and clears it on success; `public/index.html` adds the `role="alert"` message element under the form, hidden while empty)
- Remaining: none
- Test changes: none
- Note: the `blank-title` flow logs two browser console errors, "Failed to load resource: the server responded with a status of 400". They are Chrome's automatic log lines for the 400 responses AC-4 requires, not script errors.
