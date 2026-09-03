const ANSI = /\u001B\[[0-9;]*m/g;
const ANON = "*";

export type SdkReconnectSignal = "reconnecting" | "connected";

function stripAnsi(line: string): string {
  return line.replace(ANSI, "");
}

function requestKey(text: string): string {
  const match = text.match(/originalRequestId[=:\s"']+([^\s"',}]+)/);
  return match?.[1] ?? ANON;
}

export function interpretSdkLog(line: string): SdkReconnectSignal | undefined {
  const text = stripAnsi(line);
  if (text.includes("[AGENT_ERROR_DIAGNOSTICS]") && /decision=RETRY\b/.test(text)) {
    return "reconnecting";
  }
  if (text.includes("[AGENT_ERROR_DIAGNOSTICS]") && /decision=THROW\b/.test(text)) {
    return "connected";
  }
  if (text.includes("[nal_agent_retries] Request successful")) {
    return "connected";
  }
  if (text.includes("[nal_agent_retries] Error not retryable")) {
    return "connected";
  }
  return undefined;
}

/**
 * `@cursor/sdk` retries transport stalls internally and does not forward
 * `onConnectionStateChange` on `local`. Watch the retry logs it already prints
 * so the idle timeout can pause during reconnect.
 *
 * One reconnect logs `decision=RETRY` per failed attempt and a single terminal
 * line, so in-flight state is keyed by `originalRequestId` rather than counted.
 * An unlabeled success/THROW log only closes a sole in-flight reconnect.
 */
export function createSdkReconnectProbe(): {
  isRetrying: () => boolean;
  install: () => () => void;
} {
  const inflight = new Set<string>();

  const note = (line: string): void => {
    const text = stripAnsi(line);
    const signal = interpretSdkLog(text);
    if (signal === undefined) return;
    const key = requestKey(text);
    if (signal === "reconnecting") {
      inflight.add(key);
      return;
    }
    if (key !== ANON) {
      inflight.delete(key);
      return;
    }
    if (inflight.has(ANON)) {
      inflight.delete(ANON);
      return;
    }
    if (inflight.size === 1) {
      inflight.clear();
    }
  };

  const inspect = (args: unknown[]): void => {
    note(args.map(String).join(" "));
  };

  return {
    isRetrying: () => inflight.size > 0,
    install: () => {
      const { log, warn, info } = console;
      console.log = (...args: unknown[]) => {
        inspect(args);
        log.apply(console, args);
      };
      console.warn = (...args: unknown[]) => {
        inspect(args);
        warn.apply(console, args);
      };
      console.info = (...args: unknown[]) => {
        inspect(args);
        info.apply(console, args);
      };
      return () => {
        console.log = log;
        console.warn = warn;
        console.info = info;
      };
    },
  };
}
