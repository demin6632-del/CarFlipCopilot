"use strict";

const assert = require("node:assert/strict");
const { readBatchSize, main } = require("./player-marketplace-expiry-worker");

assert.equal(readBatchSize(undefined), 50);
assert.equal(readBatchSize("1"), 1);
assert.equal(readBatchSize("500"), 500);
for (const value of ["0", "501", "-1", "1.5", "abc", " 5"]) {
  assert.throws(() => readBatchSize(value), /integer from 1 to 500/);
}

(async () => {
  await assert.rejects(
    () => main({}),
    /DATABASE_URL is required/
  );
  console.log("PASS: marketplace expiry worker validates batch size and refuses to run without DATABASE_URL");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
