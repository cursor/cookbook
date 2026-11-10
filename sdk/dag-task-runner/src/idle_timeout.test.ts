import assert from "node:assert/strict";
import { test } from "node:test";

import { TimeoutError, withIdleTimeout } from "./idle_timeout.js";

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

test("rejects after idleMs when the SDK is not reconnecting", async () => {
  await assert.rejects(
    () =>
      withIdleTimeout(delay(80, "late"), {
        idleMs: 30,
        deadline: Date.now() + 1_000,
        isRetrying: () => false,
        idleMessage: "idle",
        deadlineMessage: "deadline",
      }),
    (err: unknown) => err instanceof TimeoutError && err.message === "idle",
  );
});

test("does not idle-timeout while an SDK reconnect is in progress", async () => {
  const result = await withIdleTimeout(delay(90, "recovered"), {
    idleMs: 30,
    deadline: Date.now() + 1_000,
    isRetrying: () => true,
    idleMessage: "idle",
    deadlineMessage: "deadline",
  });
  assert.equal(result, "recovered");
});

test("still honors the hard task deadline during reconnect", async () => {
  await assert.rejects(
    () =>
      withIdleTimeout(delay(200, "late"), {
        idleMs: 1_000,
        deadline: Date.now() + 40,
        isRetrying: () => true,
        idleMessage: "idle",
        deadlineMessage: "deadline",
      }),
    (err: unknown) => err instanceof TimeoutError && err.message === "deadline",
  );
});
