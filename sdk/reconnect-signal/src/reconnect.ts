export type ConnectionState = "connected" | "reconnecting"

export type ConnectionStateEvent =
  | { state: "connected" }
  | { state: "reconnecting"; attempt: number; trigger?: unknown }

export type ConnectionStateListener = (event: ConnectionStateEvent) => void

export type RunStreamStatus =
  | "CREATING"
  | "RUNNING"
  | "RETRYING"
  | "FINISHED"
  | "ERROR"
  | "CANCELLED"
  | "EXPIRED"

export type RetryingStatusMessage = {
  type: "status"
  agent_id: string
  run_id: string
  status: "RETRYING"
  message?: string
}

export type StreamEvent = {
  type: string
  agent_id?: string
  run_id?: string
  status?: string
}

export type ConnectionStateHub = {
  getState(): ConnectionState
  isRetrying(): boolean
  onConnectionStateChange(listener: ConnectionStateListener): () => void
  notify(event: ConnectionStateEvent): void
}

export type ReconnectAwareIdleTimer = {
  start(): void
  touch(): void
  stop(): void
}

/**
 * Public reconnect/retry signal. `@cursor/sdk` already has this hook internally
 * (`onConnectionStateChange` with `reconnecting` / `connected`) but does not
 * export it. Pass `hub.notify` as `local.onConnectionStateChange` so a future
 * SDK release can forward events without an embedder change.
 */
export function createConnectionStateHub(): ConnectionStateHub {
  let state: ConnectionState = "connected"
  const listeners = new Set<ConnectionStateListener>()

  return {
    getState() {
      return state
    },
    isRetrying() {
      return state === "reconnecting"
    },
    onConnectionStateChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    notify(event) {
      state = event.state
      for (const listener of listeners) {
        listener(event)
      }
    },
  }
}

export function asRetryingStatus(input: {
  agentId: string
  runId: string
  attempt?: number
}): RetryingStatusMessage {
  return {
    type: "status",
    agent_id: input.agentId,
    run_id: input.runId,
    status: "RETRYING",
    message:
      input.attempt === undefined
        ? "SDK reconnect in progress"
        : `SDK reconnect attempt ${input.attempt}`,
  }
}

/**
 * Idle watchdog that freezes while the SDK is reconnecting so a stall retry
 * is not reported as a dead model.
 */
export function createReconnectAwareIdleTimer(options: {
  idleMs: number
  isRetrying: () => boolean
  onIdle: () => void
}): ReconnectAwareIdleTimer {
  const { idleMs, isRetrying, onIdle } = options
  let handle: ReturnType<typeof setTimeout> | undefined
  let stopped = true
  let remaining = idleMs
  let lastTick = 0

  const clear = () => {
    if (handle !== undefined) {
      clearTimeout(handle)
      handle = undefined
    }
  }

  const arm = () => {
    clear()
    if (stopped) {
      return
    }
    handle = setTimeout(tick, Math.max(5, Math.min(remaining, 25)))
  }

  const tick = () => {
    if (stopped) {
      return
    }
    const now = Date.now()
    const elapsed = now - lastTick
    lastTick = now
    if (!isRetrying()) {
      remaining -= elapsed
      if (remaining <= 0) {
        onIdle()
        return
      }
    }
    arm()
  }

  return {
    start() {
      stopped = false
      remaining = idleMs
      lastTick = Date.now()
      arm()
    },
    touch() {
      remaining = idleMs
      lastTick = Date.now()
      if (!stopped) {
        arm()
      }
    },
    stop() {
      stopped = true
      clear()
    },
  }
}

export async function* watchStream<T extends StreamEvent>(
  stream: AsyncIterable<T>,
  hub: ConnectionStateHub,
): AsyncGenerator<T | RetryingStatusMessage> {
  const iterator = stream[Symbol.asyncIterator]()
  let agentId = ""
  let runId = ""
  const pending: Array<T | RetryingStatusMessage> = []
  let wake: (() => void) | undefined

  const unsub = hub.onConnectionStateChange((event) => {
    if (event.state !== "reconnecting") {
      return
    }
    pending.push(
      asRetryingStatus({
        agentId,
        runId,
        attempt: event.attempt,
      }),
    )
    wake?.()
  })

  const readNext = () =>
    iterator.next().then(
      (result) => ({ kind: "message" as const, result }),
      (error: unknown) => ({ kind: "error" as const, error }),
    )

  try {
    let next = readNext()
    for (;;) {
      if (pending.length > 0) {
        yield pending.shift()!
        continue
      }

      const signaled = new Promise<void>((resolve) => {
        wake = resolve
      })
      const winner = await Promise.race([
        next,
        signaled.then(() => ({ kind: "signal" as const })),
      ])

      if (winner.kind === "signal") {
        continue
      }
      if (winner.kind === "error") {
        throw winner.error
      }
      if (winner.result.done) {
        break
      }

      const value = winner.result.value
      agentId = value.agent_id ?? agentId
      runId = value.run_id ?? runId
      yield value
      next = readNext()
    }

    while (pending.length > 0) {
      yield pending.shift()!
    }
  } finally {
    unsub()
    await iterator.return?.()
  }
}

/** Extra field `@cursor/sdk` already honors internally but does not type. */
export type LocalReconnectOptions = {
  enableAgentRetries?: boolean
  onConnectionStateChange?: ConnectionStateListener
}
