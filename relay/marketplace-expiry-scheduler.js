"use strict";

function startMarketplaceExpiryScheduler({
  run,
  intervalMs = 5 * 60 * 1000,
  onResult = () => {},
  onError = () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  if (typeof run !== "function") throw new TypeError("Marketplace expiry scheduler requires a run function");
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) {
    throw new RangeError("Marketplace expiry interval must be an integer of at least 1000ms");
  }

  let running = false;
  let stopped = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await run();
      if (!stopped) onResult(result);
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      running = false;
    }
  };

  const timer = setIntervalFn(tick, intervalMs);
  if (typeof timer?.unref === "function") timer.unref();
  void tick();

  return () => {
    if (stopped) return;
    stopped = true;
    clearIntervalFn(timer);
  };
}

module.exports = { startMarketplaceExpiryScheduler };
