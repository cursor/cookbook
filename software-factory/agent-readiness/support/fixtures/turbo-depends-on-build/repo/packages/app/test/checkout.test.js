import assert from "node:assert/strict";
import { test } from "node:test";
import { checkout } from "../src/checkout.js";

test("checkout applies the discount", () => {
  assert.equal(checkout(99), 99);
  assert.equal(checkout(100), 90);
});
