import test from "node:test";
import assert from "node:assert/strict";
import { delay } from "./helpers.ts";
import { createActivityWatchdog } from "../src/activity-watchdog.ts";

test("activity watchdog resets on progress and disarms cleanly", async () => {
  let expirations = 0;
  const watchdog = createActivityWatchdog(200, () => { expirations++; });

  watchdog.arm();
  await delay(30);
  watchdog.touch();
  await delay(80);
  assert.equal(expirations, 0, "total elapsed time does not expire an active run");
  await delay(150);
  assert.equal(expirations, 1, "one uninterrupted inactivity window expires the run");

  watchdog.arm();
  watchdog.clear();
  watchdog.touch();
  await delay(220);
  assert.equal(expirations, 1, "clearing prevents expiry and late activity cannot re-arm it");
});

test("a suspended watchdog holds the countdown for a parked interaction and resumes from now", async () => {
  let expirations = 0;
  const watchdog = createActivityWatchdog(150, () => { expirations++; });

  watchdog.arm();
  watchdog.suspend();
  await delay(220);
  assert.equal(expirations, 0, "a validated wait is legitimate provider silence, not inactivity");

  // Nesting is safe: the countdown restarts only when the last wait ends.
  watchdog.suspend();
  watchdog.resume();
  await delay(120);
  assert.equal(expirations, 0, "an inner resume cannot restart the countdown while another wait is open");
  watchdog.resume();
  await delay(80);
  assert.equal(expirations, 0, "resuming counts from now, not from when the wait began");
  await delay(120);
  assert.equal(expirations, 1);

  // A watchdog that was never armed, or was cleared, stays disarmed.
  watchdog.suspend();
  watchdog.resume();
  await delay(200);
  assert.equal(expirations, 1, "resume never arms a turn that had already expired");

  watchdog.arm();
  watchdog.suspend();
  watchdog.clear();
  watchdog.resume();
  await delay(200);
  assert.equal(expirations, 1, "teardown during a wait cannot be resurrected by a late resume");
});
