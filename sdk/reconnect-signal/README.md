# Reconnect / retry signal

Headless embedders keep `local.enableAgentRetries: true` so a stalled transport can recover. `@cursor/sdk` already has a stall detector and an `onConnectionStateChange` hook (`reconnecting` / `connected`), but those are not on the public TypeScript surface. There is also no stream status for `RETRYING`.

Without that signal, an idle timeout cannot tell model silence from an in-progress SDK reconnect. This example exports the missing public hook so embedders can keep retries enabled and still observe them.

```ts
import { Agent } from "@cursor/sdk"
import {
  createConnectionStateHub,
  createReconnectAwareIdleTimer,
  watchStream,
} from "./src/reconnect.js"

const hub = createConnectionStateHub()

await using agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2" },
  local: {
    cwd: process.cwd(),
    enableAgentRetries: true,
    // Typed extra field. The SDK already calls this internally; it is not
    // forwarded today. Keep it so a future release can light up the hook.
    onConnectionStateChange: hub.notify,
  },
})

const idle = createReconnectAwareIdleTimer({
  idleMs: 60_000,
  isRetrying: () => hub.isRetrying(),
  onIdle: () => {
    throw new Error("idle timeout: model silence")
  },
})

const run = await agent.send("Summarize this repository.")
idle.start()

for await (const event of watchStream(run.stream(), hub)) {
  if (event.type === "status" && event.status === "RETRYING") {
    console.log("SDK is reconnecting; idle clock is paused")
  }
  idle.touch()
}

idle.stop()
await run.wait()
```

`watchStream` yields a `status: "RETRYING"` event whenever the hub reports `reconnecting`. The idle timer freezes for that window and resumes after `connected`, so a transport retry is not logged as a dead model.

## Getting started

Use Node.js 22 or newer.

```bash
pnpm install
pnpm test
pnpm dev
```

`pnpm dev` runs a simulated reconnect so you can see `RETRYING` and the paused idle clock without an API key.

To attach the same helper to a live local agent:

```bash
export CURSOR_API_KEY="crsr_..."
pnpm dev -- --live
```
