export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export function isTimeoutError(err: unknown): boolean {
  return err instanceof TimeoutError;
}

export interface IdleTimeoutOptions {
  idleMs: number;
  deadline: number;
  isRetrying?: () => boolean;
  idleMessage: string;
  deadlineMessage: string;
}

/**
 * Wait for `promise`, but treat stream silence as idle only while the SDK is
 * not reconnecting. The hard `deadline` still wins during a retry.
 */
export async function withIdleTimeout<T>(
  promise: Promise<T>,
  options: IdleTimeoutOptions,
): Promise<T> {
  const isRetrying = options.isRetrying ?? (() => false);
  let leftover = options.idleMs;
  let lastTick = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout: ((error: TimeoutError) => void) | undefined;

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const arm = () => {
    clear();
    const now = Date.now();
    if (now >= options.deadline) {
      rejectTimeout?.(new TimeoutError(options.deadlineMessage));
      return;
    }
    const untilDeadline = options.deadline - now;
    if (isRetrying()) {
      lastTick = now;
      timer = setTimeout(arm, Math.min(25, untilDeadline));
      return;
    }
    leftover -= now - lastTick;
    lastTick = now;
    if (leftover <= 0) {
      rejectTimeout?.(new TimeoutError(options.idleMessage));
      return;
    }
    timer = setTimeout(arm, Math.min(leftover, untilDeadline, 25));
  };

  const timeout = new Promise<T>((_, reject) => {
    rejectTimeout = reject;
    arm();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clear();
  }
}
