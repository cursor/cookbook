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

test("treats AGENT_ERROR_DIAGNOSTICS THROW as connected", () => {
  assert.equal(
    interpretSdkLog(
      "WARN  [AGENT_ERROR_DIAGNOSTICS] requestId=abc originalRequestId=def decision=THROW stall",
    ),
    "connected",
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

test("one reconnect with extra RETRY attempts clears on a single success", () => {
  const probe = createSdkReconnectProbe();
  const stop = probe.install();
  try {
    console.warn(
      "[AGENT_ERROR_DIAGNOSTICS] requestId=a1 originalRequestId=run-1 decision=RETRY (countAsTransportError=1)",
    );
    console.warn(
      "[AGENT_ERROR_DIAGNOSTICS] requestId=a2 originalRequestId=run-1 decision=RETRY (countAsTransportError=1)",
    );
    assert.equal(probe.isRetrying(), true);
    console.log("[nal_agent_retries] Request successful originalRequestId=run-1");
    assert.equal(probe.isRetrying(), false);
  } finally {
    stop();
  }
});

test("RETRY that ends in THROW does not leave the probe stuck", () => {
  const probe = createSdkReconnectProbe();
  const stop = probe.install();
  try {
    console.warn(
      "[AGENT_ERROR_DIAGNOSTICS] requestId=a1 originalRequestId=run-1 decision=RETRY (countAsTransportError=1)",
    );
    console.warn(
      "[AGENT_ERROR_DIAGNOSTICS] requestId=a2 originalRequestId=run-1 decision=THROW stall",
    );
    assert.equal(probe.isRetrying(), false);
  } finally {
    stop();
  }
});

test("overlapping reconnects on different originalRequestIds stay independent", () => {
  const probe = createSdkReconnectProbe();
  const stop = probe.install();
  try {
    console.warn(
      "[AGENT_ERROR_DIAGNOSTICS] requestId=a originalRequestId=run-a decision=RETRY (countAsServerError=1)",
    );
    console.warn(
      "[AGENT_ERROR_DIAGNOSTICS] requestId=b originalRequestId=run-b decision=RETRY (countAsTransportError=1)",
    );
    assert.equal(probe.isRetrying(), true);
    console.log("[nal_agent_retries] Request successful originalRequestId=run-a");
    assert.equal(probe.isRetrying(), true);
    console.log("[nal_agent_retries] Request successful originalRequestId=run-b");
    assert.equal(probe.isRetrying(), false);
  } finally {
    stop();
  }
});

test("anonymous Request successful does not clear sibling reconnects", () => {
  const probe = createSdkReconnectProbe();
  const stop = probe.install();
  try {
    console.warn(
      "[AGENT_ERROR_DIAGNOSTICS] requestId=a originalRequestId=run-a decision=RETRY (countAsServerError=1)",
    );
    console.warn(
      "[AGENT_ERROR_DIAGNOSTICS] requestId=b originalRequestId=run-b decision=RETRY (countAsTransportError=1)",
    );
    console.log("[nal_agent_retries] Request successful");
    assert.equal(probe.isRetrying(), true);
    console.warn(
      "[AGENT_ERROR_DIAGNOSTICS] requestId=a2 originalRequestId=run-a decision=THROW stall",
    );
    assert.equal(probe.isRetrying(), true);
    console.log("[nal_agent_retries] Request successful originalRequestId=run-b");
    assert.equal(probe.isRetrying(), false);
  } finally {
    stop();
  }
});

test("anonymous Error not retryable does not clear sibling reconnects", () => {
  const probe = createSdkReconnectProbe();
  const stop = probe.install();
  try {
    console.warn(
      "[AGENT_ERROR_DIAGNOSTICS] requestId=a originalRequestId=run-a decision=RETRY (countAsServerError=1)",
    );
    console.warn(
      "[AGENT_ERROR_DIAGNOSTICS] requestId=b originalRequestId=run-b decision=RETRY (countAsTransportError=1)",
    );
    console.warn("[nal_agent_retries] Error not retryable");
    assert.equal(probe.isRetrying(), true);
    console.warn(
      "[AGENT_ERROR_DIAGNOSTICS] requestId=b2 originalRequestId=run-b decision=THROW stall",
    );
    assert.equal(probe.isRetrying(), true);
    console.warn(
      "[AGENT_ERROR_DIAGNOSTICS] requestId=a2 originalRequestId=run-a decision=THROW stall",
    );
    assert.equal(probe.isRetrying(), false);
  } finally {
    stop();
  }
});

test("unlabeled success still clears a sole in-flight reconnect", () => {
  const probe = createSdkReconnectProbe();
  const stop = probe.install();
  try {
    console.warn(
      "[AGENT_ERROR_DIAGNOSTICS] requestId=a1 originalRequestId=run-1 decision=RETRY (countAsTransportError=1)",
    );
    console.warn(
      "[AGENT_ERROR_DIAGNOSTICS] requestId=a2 originalRequestId=run-1 decision=RETRY (countAsTransportError=1)",
    );
    console.log("[nal_agent_retries] Request successful");
    assert.equal(probe.isRetrying(), false);
  } finally {
    stop();
  }
});
