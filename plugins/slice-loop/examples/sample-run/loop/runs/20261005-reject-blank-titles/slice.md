# Requirement (verbatim)

Reject empty or whitespace-only task titles. POST /api/tasks with a blank title must return HTTP 400 with JSON `{ "error": "Title is required" }` and must not create a task. In the UI, submitting a blank title shows the message 'Title is required' inline under the input, does not add a task, and the message clears after a successful add.

## Links and attachments

None.
