export interface ActivityWatchdog {
  arm(): void;
  touch(): void;
  clear(): void;
  /** Stops counting silence while the host is deliberately parked. Safe to call twice. */
  suspend(): void;
  /** Resumes counting from now, but only if the turn was armed when suspended. */
  resume(): void;
}

/**
 * Bounds provider silence without imposing a wall-clock limit on active work.
 * Arm at turn start; touch only resets an armed turn, so late events cannot
 * resurrect a watchdog after completion or teardown.
 *
 * A validated host interaction parks the turn for as long as its own bounded
 * deadline allows, which is legitimately silent provider time: `suspend()`
 * holds the countdown instead of letting inactivity kill a healthy wait.
 */
export function createActivityWatchdog(timeoutMs: number, onInactive: () => void): ActivityWatchdog {
  let timer: NodeJS.Timeout | undefined;
  let armed = false;
  let suspended = 0;
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clearTimer();
    if (suspended > 0) return;
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
      suspended = 0;
      clearTimer();
    },
    suspend() {
      suspended++;
      clearTimer();
    },
    resume() {
      if (suspended === 0) return;
      suspended--;
      if (suspended === 0 && armed) schedule();
    },
  };
}
