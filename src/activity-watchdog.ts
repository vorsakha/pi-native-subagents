export interface ActivityWatchdog {
  arm(): void;
  touch(): void;
  clear(): void;
}

/**
 * Bounds provider silence without imposing a wall-clock limit on active work.
 * Arm at turn start; touch only resets an armed turn, so late events cannot
 * resurrect a watchdog after completion or teardown.
 */
export function createActivityWatchdog(timeoutMs: number, onInactive: () => void): ActivityWatchdog {
  let timer: NodeJS.Timeout | undefined;
  let armed = false;
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      armed = false;
      onInactive();
    }, timeoutMs);
    timer.unref();
  };
  return {
    arm() {
      armed = true;
      schedule();
    },
    touch() {
      if (armed) schedule();
    },
    clear() {
      armed = false;
      clearTimer();
    },
  };
}
