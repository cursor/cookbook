import assert from "node:assert/strict";
import { test } from "node:test";
import { canRefund, pageSize } from "../src/roles.js";

test("canRefund runs", () => {
  canRefund("admin");
  assert.ok(true);
});

test("pageSize runs", () => {
  const n = pageSize(20);
  assert.ok(typeof n === "number");
});
