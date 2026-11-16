"use strict";

const assert = require("node:assert/strict");
const { readBatchSize, main } = require("./player-marketplace-expiry-worker");
const { startMarketplaceExpiryScheduler } = require("./marketplace-expiry-scheduler");

assert.equal(readBatchSize(undefined), 50);
assert.equal(readBatchSize("1"), 1);
assert.equal(readBatchSize("500"), 500);
for (const value of ["0", "501", "-1", "1.5", "abc", " 5"]) {
  assert.throws(() => readBatchSize(value), /integer from 1 to 500/);
}

(async () => {
  await (async () => {
    let releaseRun;
    let calls = 0;
    let timerCallback;
    let cleared = false;
    const errors = [];
    const stop = startMarketplaceExpiryScheduler({
      run: () => {
        calls += 1;
        return new Promise(resolve => { releaseRun = resolve; });
      },
      intervalMs: 1000,
      setIntervalFn: callback => { timerCallback = callback; return { unref() {} }; },
      clearIntervalFn: () => { cleared = true; },
      onError: error => errors.push(error)
    });
    await Promise.resolve();
    assert.equal(calls, 1, "scheduler performs an initial cleanup");
    await timerCallback();
    assert.equal(calls, 1, "overlapping timer ticks are skipped");
    releaseRun({ expiredCount: 2 });
    await new Promise(resolve => setImmediate(resolve));
    await timerCallback();
    assert.equal(calls, 2, "a later tick runs after the previous batch finishes");
    stop();
    stop();
    assert.equal(cleared, true, "stop clears the interval and is idempotent");
    await timerCallback();
    assert.equal(calls, 2, "stopped scheduler does not start more work");
    assert.deepEqual(errors, []);
    console.log("PASS: marketplace expiry scheduler prevents overlap and stops cleanly");
  })();
  await assert.rejects(
    () => main({}),
    /DATABASE_URL is required/
  );
  console.log("PASS: marketplace expiry worker validates batch size and refuses to run without DATABASE_URL");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
