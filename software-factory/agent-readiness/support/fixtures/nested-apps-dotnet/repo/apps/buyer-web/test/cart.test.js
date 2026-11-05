import assert from "node:assert/strict";
import { test } from "node:test";
import { freeShipping, isPostcode, lineTotal, nextStep, parseQuantity } from "../src/cart.js";

test("lineTotal multiplies and ignores empty lines", () => {
  assert.equal(lineTotal(5, 0), 0);
  assert.equal(lineTotal(5, 1), 5);
  assert.equal(lineTotal(5, 3), 15);
});

test("freeShipping starts at 50", () => {
  assert.equal(freeShipping(49), false);
  assert.equal(freeShipping(50), true);
  assert.equal(freeShipping(80), true);
});

test("nextStep stops at the last step", () => {
  assert.equal(nextStep(1, 3), 2);
  assert.equal(nextStep(2, 3), 3);
  assert.equal(nextStep(3, 3), 3);
});

test("isPostcode wants a 5-character string", () => {
  assert.equal(isPostcode("12345"), true);
  assert.equal(isPostcode("1234"), false);
  assert.equal(isPostcode("123456"), false);
  assert.equal(isPostcode(12345), false);
});

test("parseQuantity floors and rejects text", () => {
  assert.equal(parseQuantity("2"), 2);
  assert.equal(parseQuantity("2.7"), 2);
  assert.throws(() => parseQuantity("abc"), TypeError);
});
