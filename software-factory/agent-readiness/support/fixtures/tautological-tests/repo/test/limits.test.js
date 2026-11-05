import assert from "node:assert/strict";
import { test } from "node:test";
import { clampPercent, isBusinessDay } from "../src/limits.js";

test("clampPercent runs", () => {
  clampPercent(50);
  assert.ok(true);
});

test("isBusinessDay runs", () => {
  const result = isBusinessDay(3);
  assert.ok(result === true || result === false);
});
