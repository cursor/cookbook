import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/tasks.js";

test("lists seeded tasks in order", () => {
  const store = createStore(["a", "b"]);
  assert.deepEqual(store.list().map((t) => t.title), ["a", "b"]);
});

test("add trims the title and assigns increasing ids", () => {
  const store = createStore();
  const first = store.add("  write tests ");
  const second = store.add("ship");
  assert.equal(first.title, "write tests");
  assert.ok(second.id > first.id);
});
