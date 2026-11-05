import { expect, test } from "bun:test";
import { discount, isAdult, isValidCode, nextPage, parsePercent } from "../src/pricing.js";

test("isAdult is true from 18", () => {
  expect(isAdult(17)).toBe(false);
  expect(isAdult(18)).toBe(true);
  expect(isAdult(19)).toBe(true);
});

test("discount takes 10 off from 100", () => {
  expect(discount(99)).toBe(99);
  expect(discount(100)).toBe(90);
  expect(discount(150)).toBe(140);
});

test("nextPage stops at the last page", () => {
  expect(nextPage(1, 3)).toBe(2);
  expect(nextPage(2, 3)).toBe(3);
  expect(nextPage(3, 3)).toBe(3);
});

test("isValidCode wants a 6-character string", () => {
  expect(isValidCode("123456")).toBe(true);
  expect(isValidCode("12345")).toBe(false);
  expect(isValidCode("1234567")).toBe(false);
  expect(isValidCode(123456)).toBe(false);
});

test("parsePercent divides by 100 and rejects text", () => {
  expect(parsePercent("50")).toBe(0.5);
  expect(parsePercent("100")).toBe(1);
  expect(() => parsePercent("abc")).toThrow(TypeError);
});
