import { Agent } from "@cursor/sdk"

import {
  createConnectionStateHub,
  createReconnectAwareIdleTimer,
  watchStream,
  type ConnectionStateEvent,
  type LocalReconnectOptions,
  type StreamEvent,
} from "./reconnect.js"

const DEFAULT_IDLE_MS = 5_000

async function main() {
  const live = process.argv.includes("--live")
  if (live) {
    await runLive()
    return
  }
  await runSimulated()
}

async function runSimulated() {
  const hub = createConnectionStateHub()
  const idle = createReconnectAwareIdleTimer({
    idleMs: DEFAULT_IDLE_MS,
    isRetrying: () => hub.isRetrying(),
    onIdle: () => {
      console.error("idle timeout: model silence (SDK was not reconnecting)")
      process.exitCode = 2
    },
  })

  hub.onConnectionStateChange(logConnection)
  idle.start()

  const stream = simulatedRun(hub)
  for await (const event of watchStream(stream, hub)) {
    logStatus(event)
    idle.touch()
  }

  idle.stop()
}

async function runLive() {
  const apiKey = process.env.CURSOR_API_KEY
  if (!apiKey) {
    throw new Error("Set CURSOR_API_KEY to run --live.")
  }

  const hub = createConnectionStateHub()
  const local: LocalReconnectOptions = {
    enableAgentRetries: true,
    onConnectionStateChange: (event) => hub.notify(event),
  }
  const idle = createReconnectAwareIdleTimer({
    idleMs: Number(process.env.IDLE_MS ?? DEFAULT_IDLE_MS),
    isRetrying: () => hub.isRetrying(),
    onIdle: () => {
      throw new Error("idle timeout: model silence (SDK was not reconnecting)")
    },
  })

  hub.onConnectionStateChange(logConnection)

  await using agent = await Agent.create({
    apiKey,
    name: "Reconnect signal example",
    model: { id: process.env.CURSOR_MODEL ?? "composer-2" },
    local: {
      cwd: process.cwd(),
      ...local,
    },
  })

  const run = await agent.send(
    process.env.CURSOR_PROMPT ?? "Explain this project in one paragraph.",
  )
  idle.start()

  for await (const event of watchStream(run.stream() as AsyncIterable<StreamEvent>, hub)) {
    logStatus(event)
    if (event.type === "assistant") {
      process.stdout.write(assistantText(event))
    }
    idle.touch()
  }

  idle.stop()
  await run.wait()
}

function logStatus(event: StreamEvent & { message?: unknown }) {
  if (event.type !== "status") {
    return
  }
  const extra = typeof event.message === "string" ? `: ${event.message}` : ""
  console.log(`status ${event.status ?? ""}${extra}`)
}

function logConnection(event: ConnectionStateEvent) {
  if (event.state === "reconnecting") {
    console.log(`connection reconnecting (attempt ${event.attempt})`)
    return
  }
  console.log("connection connected")
}

async function* simulatedRun(hub: ReturnType<typeof createConnectionStateHub>) {
  yield {
    type: "status" as const,
    agent_id: "demo-agent",
    run_id: "demo-run",
    status: "RUNNING" as const,
  }
  await delay(80)
  hub.notify({ state: "reconnecting", attempt: 1 })
  await delay(120)
  hub.notify({ state: "connected" })
  yield {
    type: "status" as const,
    agent_id: "demo-agent",
    run_id: "demo-run",
    status: "FINISHED" as const,
  }
}

function assistantText(event: StreamEvent) {
  const message = (event as { message?: { content?: Array<{ type?: string; text?: string }> } }).message
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

await main()
