const ANSI = /\u001B\[[0-9;]*m/g;

export type SdkReconnectSignal = "reconnecting" | "connected";

export function interpretSdkLog(line: string): SdkReconnectSignal | undefined {
  const text = line.replace(ANSI, "");
  if (text.includes("[AGENT_ERROR_DIAGNOSTICS]") && /decision=RETRY\b/.test(text)) {
    return "reconnecting";
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
 */
export function createSdkReconnectProbe(): {
  isRetrying: () => boolean;
  install: () => () => void;
} {
  let depth = 0;

  const note = (signal: SdkReconnectSignal | undefined): void => {
    if (signal === "reconnecting") {
      depth += 1;
      return;
    }
    if (signal === "connected" && depth > 0) {
      depth -= 1;
    }
  };

  const inspect = (args: unknown[]): void => {
    note(interpretSdkLog(args.map(String).join(" ")));
  };

  return {
    isRetrying: () => depth > 0,
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
