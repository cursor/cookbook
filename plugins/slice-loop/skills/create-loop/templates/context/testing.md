# Testing

## Frameworks

- Unit/integration: <framework>, run with `<cmd>`, single file with `<cmd> {file}`.
- E2E: <framework or "none — see validation.md">.

## Layout

- New tests go in <convention>. Name them <pattern>.

## Fixtures and mocks

- Existing helpers: `<path>` — <what it provides>.
- Network mocking: <tool and where handlers live>.
- Never: <for example, hit real Stripe; write to the shared dev DB>.

## Known flakes

- `<test>`: <symptom, workaround>.
