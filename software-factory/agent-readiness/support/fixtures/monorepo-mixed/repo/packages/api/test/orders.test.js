import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { orderTotal } from "../src/orders.js";

function database() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(5432, "127.0.0.1");
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("error", reject);
  });
}

test("orders are totalled against the database", async () => {
  await database();
  assert.equal(orderTotal([]), 0);
  assert.equal(orderTotal([{ price: 10, qty: 1 }]), 10);
  assert.equal(orderTotal([{ price: 10, qty: 2 }, { price: 5, qty: 1 }]), 25);
  assert.throws(() => orderTotal([{ price: 10, qty: 0 }]), RangeError);
});
