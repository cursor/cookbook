const assert = require("node:assert/strict");
const { test } = require("node:test");
const store = require("../src/store");
const { card } = require("../src/theme");

test("addItem appends and refuses empty lines", () => {
  assert.deepEqual(store.addItem([], { sku: "a", quantity: 1 }), [{ sku: "a", quantity: 1 }]);
  assert.throws(() => store.addItem([], { sku: "a", quantity: 0 }), RangeError);
});

test("itemCount adds quantities", () => {
  assert.equal(store.itemCount([]), 0);
  assert.equal(store.itemCount([{ quantity: 2 }, { quantity: 3 }]), 5);
});

test("isEmpty is true only for an empty cart", () => {
  assert.equal(store.isEmpty([]), true);
  assert.equal(store.isEmpty([{ quantity: 1 }]), false);
});

test("bulkDiscount starts at 10 items", () => {
  assert.equal(store.bulkDiscount(9), 0);
  assert.equal(store.bulkDiscount(10), 15);
  assert.equal(store.bulkDiscount(12), 15);
});

test("the card style exists", () => {
  assert.equal(typeof card, "object");
});
