import assert from "node:assert/strict";
import { test } from "node:test";
import { discount, isAdult, isValidCode, nextPage, parsePercent } from "../src/pricing.js";

test("isAdult is true from 18", () => {
  assert.equal(isAdult(17), false);
  assert.equal(isAdult(18), true);
  assert.equal(isAdult(19), true);
});

test("discount takes 10 off from 100", () => {
  assert.equal(discount(99), 99);
  assert.equal(discount(100), 90);
  assert.equal(discount(150), 140);
});

test("nextPage stops at the last page", () => {
  assert.equal(nextPage(1, 3), 2);
  assert.equal(nextPage(2, 3), 3);
  assert.equal(nextPage(3, 3), 3);
});

test("isValidCode wants a 6-character string", () => {
  assert.equal(isValidCode("123456"), true);
  assert.equal(isValidCode("12345"), false);
  assert.equal(isValidCode("1234567"), false);
  assert.equal(isValidCode(123456), false);
});

test("parsePercent divides by 100 and rejects text", () => {
  assert.equal(parsePercent("50"), 0.5);
  assert.equal(parsePercent("100"), 1);
  assert.throws(() => parsePercent("abc"), TypeError);
});
