import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSdkReconnectProbe,
  interpretSdkLog,
} from "./sdk_reconnect.js";

test("treats AGENT_ERROR_DIAGNOSTICS RETRY as reconnecting", () => {
  assert.equal(
    interpretSdkLog(
      "WARN  [AGENT_ERROR_DIAGNOSTICS] requestId=abc originalRequestId=def decision=RETRY (countAsServerError=0, countAsTransportError=1)",
    ),
    "reconnecting",
  );
});

test("ignores AGENT_ERROR_DIAGNOSTICS THROW", () => {
  assert.equal(
    interpretSdkLog(
      "WARN  [AGENT_ERROR_DIAGNOSTICS] requestId=abc originalRequestId=def decision=THROW stall",
    ),
    undefined,
  );
});

test("treats nal_agent_retries success and non-retry as connected", () => {
  assert.equal(
    interpretSdkLog("INFO  [nal_agent_retries] Request successful"),
    "connected",
  );
  assert.equal(
    interpretSdkLog("WARN  [nal_agent_retries] Error not retryable"),
    "connected",
  );
});

test("strips ANSI color codes before matching", () => {
  assert.equal(
    interpretSdkLog(
      "\u001B[33mWARN \u001B[0m [AGENT_ERROR_DIAGNOSTICS] decision=RETRY (countAsTransportError=1)",
    ),
    "reconnecting",
  );
});

test("probe pauses while SDK retry logs are in flight", () => {
  const probe = createSdkReconnectProbe();
  const stop = probe.install();
  try {
    assert.equal(probe.isRetrying(), false);
    console.warn(
      "[AGENT_ERROR_DIAGNOSTICS] requestId=a originalRequestId=b decision=RETRY (countAsTransportError=1)",
    );
    assert.equal(probe.isRetrying(), true);
    console.log("[nal_agent_retries] Request successful");
    assert.equal(probe.isRetrying(), false);
  } finally {
    stop();
  }
});

test("probe refcounts overlapping reconnects from parallel tasks", () => {
  const probe = createSdkReconnectProbe();
  const stop = probe.install();
  try {
    console.warn("[AGENT_ERROR_DIAGNOSTICS] decision=RETRY (countAsServerError=1)");
    console.warn("[AGENT_ERROR_DIAGNOSTICS] decision=RETRY (countAsTransportError=1)");
    assert.equal(probe.isRetrying(), true);
    console.log("[nal_agent_retries] Request successful");
    assert.equal(probe.isRetrying(), true);
    console.log("[nal_agent_retries] Request successful");
    assert.equal(probe.isRetrying(), false);
  } finally {
    stop();
  }
});
