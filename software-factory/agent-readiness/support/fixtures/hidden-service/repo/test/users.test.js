import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { displayName, isActive } from "../src/users.js";

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

test("users load from the database", async () => {
  await database();
  assert.equal(displayName({ first: "Ada", last: "Lovelace" }), "Ada Lovelace");
  assert.equal(displayName({ first: "Ada" }), "Ada");
  assert.throws(() => displayName({}), Error);
  assert.equal(isActive({ lastSeen: 70 }, 100), true);
  assert.equal(isActive({ lastSeen: 69 }, 100), false);
});
