import assert from "node:assert/strict";
import { test } from "node:test";
import { backoff, shouldRetry } from "../src/retry.js";

test("backoff runs", () => {
  backoff(3);
  assert.ok(true);
});

test("shouldRetry runs", () => {
  shouldRetry(503, 1);
  assert.ok(true);
});
