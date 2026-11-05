import assert from "node:assert/strict";
import { test } from "node:test";
import { fee } from "../src/payments.js";

const key = process.env.PAYMENTS_LIVE_KEY;

test("fees match the live pricing API", () => {
  if (!key) throw new Error("Missing PAYMENTS_LIVE_KEY");
  assert.equal(fee(1000), 59);
  assert.throws(() => fee(0), RangeError);
});
