import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { config } from "../src/config.js";
import { displayName, isExpired, remainingSeconds, sessionKey } from "../src/sessions.js";

function reachable(url) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname);
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("error", reject);
  });
}

test("users load from Postgres and sessions from Redis", async () => {
  const c = config();
  await reachable(c.databaseUrl);
  await reachable(c.redisUrl);
  assert.equal(displayName({ first: "Ada", last: "Lovelace" }), "Ada Lovelace");
  assert.equal(displayName({ first: "Ada" }), "Ada");
  assert.equal(sessionKey("u1"), "session:u1");
  assert.throws(() => sessionKey(""), TypeError);
});

test("sessions expire after their time to live", () => {
  const c = config();
  assert.equal(c.sessionTtl, 3600);
  assert.equal(isExpired(0, 60, 59999), false);
  assert.equal(isExpired(0, 60, 60000), true);
  assert.equal(remainingSeconds(0, 60, 30000), 30);
  assert.equal(remainingSeconds(0, 60, 61000), 0);
  assert.equal(remainingSeconds(0, 60, 0), 60);
});
