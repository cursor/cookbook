import assert from "node:assert/strict"
import { test } from "node:test"

import { disposeCreatedAgent, settledAgent } from "./agent.js"

test("settledAgent returns a resolved handle", async () => {
  const value = await settledAgent("ready", () => {
    throw new Error("should not recreate")
  })
  assert.equal(value, "ready")
})

test("settledAgent recreates after a rejected create", async () => {
  let created = 0
  const value = await settledAgent(Promise.reject(new Error("create failed")), () => {
    created += 1
    return "recovered"
  })
  assert.equal(value, "recovered")
  assert.equal(created, 1)
})

test("settledAgent does not swallow a failed recreate", async () => {
  await assert.rejects(
    () =>
      settledAgent(Promise.reject(new Error("create failed")), () => {
        throw new Error("still failing")
      }),
    /still failing/
  )
})

test("disposeCreatedAgent ignores a rejected create", async () => {
  await disposeCreatedAgent(Promise.reject(new Error("create failed")))
})
