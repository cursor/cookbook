import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCents, isFree, toCents } from "../src/money.js";

test("toCents rounds to whole cents", () => {
  assert.equal(toCents(1.5), 150);
  assert.equal(toCents(0.015), 2);
  assert.throws(() => toCents("1.50"), TypeError);
});

test("formatCents prints dollars and cents", () => {
  assert.equal(formatCents(0), "$0.00");
  assert.equal(formatCents(1999), "$19.99");
  assert.equal(formatCents(-250), "-$2.50");
});

test("isFree is true at or below zero", () => {
  assert.equal(isFree(0), true);
  assert.equal(isFree(-1), true);
  assert.equal(isFree(1), false);
});
