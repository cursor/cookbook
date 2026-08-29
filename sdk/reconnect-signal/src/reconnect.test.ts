import assert from "node:assert/strict"
import { test } from "node:test"

import {
  asRetryingStatus,
  createConnectionStateHub,
  createReconnectAwareIdleTimer,
  watchStream,
} from "./reconnect.js"

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

test("hub notifies listeners of reconnecting then connected", () => {
  const hub = createConnectionStateHub()
  const events: string[] = []
  const stop = hub.onConnectionStateChange((event) => {
    events.push(event.state)
  })

  assert.equal(hub.getState(), "connected")
  assert.equal(hub.isRetrying(), false)

  hub.notify({ state: "reconnecting", attempt: 1 })
  assert.equal(hub.getState(), "reconnecting")
  assert.equal(hub.isRetrying(), true)

  hub.notify({ state: "connected" })
  assert.equal(hub.getState(), "connected")
  assert.equal(hub.isRetrying(), false)
  assert.deepEqual(events, ["reconnecting", "connected"])

  stop()
})

test("idle timer fires after silence when the SDK is not retrying", async () => {
  const hub = createConnectionStateHub()
  let fired = false
  const timer = createReconnectAwareIdleTimer({
    idleMs: 40,
    isRetrying: () => hub.isRetrying(),
    onIdle: () => {
      fired = true
    },
  })

  timer.start()
  await delay(80)
  timer.stop()
  assert.equal(fired, true)
})

test("idle timer does not fire while an SDK reconnect is in progress", async () => {
  const hub = createConnectionStateHub()
  let fired = false
  const timer = createReconnectAwareIdleTimer({
    idleMs: 40,
    isRetrying: () => hub.isRetrying(),
    onIdle: () => {
      fired = true
    },
  })

  timer.start()
  hub.notify({ state: "reconnecting", attempt: 1 })
  await delay(90)
  timer.stop()
  assert.equal(fired, false)
})

test("idle timer resumes after reconnect and fires on later silence", async () => {
  const hub = createConnectionStateHub()
  let fired = false
  const timer = createReconnectAwareIdleTimer({
    idleMs: 40,
    isRetrying: () => hub.isRetrying(),
    onIdle: () => {
      fired = true
    },
  })

  timer.start()
  hub.notify({ state: "reconnecting", attempt: 2 })
  await delay(50)
  hub.notify({ state: "connected" })
  assert.equal(fired, false)
  await delay(80)
  timer.stop()
  assert.equal(fired, true)
})

test("asRetryingStatus exports a public RETRYING stream status", () => {
  assert.deepEqual(
    asRetryingStatus({ agentId: "agent-1", runId: "run-1", attempt: 3 }),
    {
      type: "status",
      agent_id: "agent-1",
      run_id: "run-1",
      status: "RETRYING",
      message: "SDK reconnect attempt 3",
    },
  )
})

test("watchStream yields RETRYING when the hub reports a reconnect", async () => {
  const hub = createConnectionStateHub()
  const stream = (async function* () {
    yield {
      type: "status" as const,
      agent_id: "agent-1",
      run_id: "run-1",
      status: "RUNNING" as const,
    }
    await delay(30)
    hub.notify({ state: "reconnecting", attempt: 1 })
    await delay(20)
    yield {
      type: "status" as const,
      agent_id: "agent-1",
      run_id: "run-1",
      status: "RUNNING" as const,
    }
  })()

  const seen: string[] = []
  for await (const event of watchStream(stream, hub)) {
    if (event.type === "status") {
      seen.push(event.status)
    }
  }

  assert.deepEqual(seen, ["RUNNING", "RETRYING", "RUNNING"])
})

test("watchStream does not leak an unhandled rejection when reconnect wins and the stream later fails", async () => {
  const hub = createConnectionStateHub()
  const leaked: unknown[] = []
  const onUnhandled = (reason: unknown) => {
    leaked.push(reason)
  }
  process.on("unhandledRejection", onUnhandled)

  try {
    const stream = (async function* () {
      yield {
        type: "status" as const,
        agent_id: "agent-1",
        run_id: "run-1",
        status: "RUNNING" as const,
      }
      await delay(20)
      hub.notify({ state: "reconnecting", attempt: 1 })
      await delay(20)
      throw new Error("transport failed")
    })()

    await assert.rejects(
      async () => {
        for await (const event of watchStream(stream, hub)) {
          void event
        }
      },
      { message: "transport failed" },
    )

    await delay(30)
    assert.equal(leaked.length, 0)
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

test("watchStream closes the underlying iterator when the consumer stops early", async () => {
  const hub = createConnectionStateHub()
  let closed = false
  const stream = (async function* () {
    try {
      yield {
        type: "status" as const,
        agent_id: "agent-1",
        run_id: "run-1",
        status: "RUNNING" as const,
      }
      await new Promise(() => {})
    } finally {
      closed = true
    }
  })()

  for await (const event of watchStream(stream, hub)) {
    if (event.status === "RUNNING") {
      break
    }
  }

  assert.equal(closed, true)
})
