# Validation

## Boot

1. `<boot.start>`; wait for `<boot.health>`.
2. Seed: `<boot.seed>` (deterministic; safe to rerun).
3. Stop: `<boot.stop>`.

## Driving the app

- Tool: <Playwright script | project E2E suite | curl/hurl | CLI transcript>.
- Auth: <how a flow gets a session>.
- Stable selectors: <data-testid convention or roles>.

## Canonical flows

Short, user-level flows every UI-touching slice should re-run as a regression check. Keep each under 10 steps.

### <flow name>

1. <step>
2. <step>
Expected: <observable outcome>.

## Capture

- Screenshots: viewport <WxH>; capture <which states>.
- Recording: <when to record; keep it under limits.video_max_seconds>.
- Mobile viewport: <yes/no, size>.
