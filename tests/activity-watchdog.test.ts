import test from "node:test";
import assert from "node:assert/strict";
import { createActivityWatchdog } from "../src/activity-watchdog.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
