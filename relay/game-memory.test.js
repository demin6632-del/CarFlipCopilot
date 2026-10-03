const assert=require("assert");
const memory=require("./game-memory");
assert.equal(typeof memory.recordScreen,"function");
assert.equal(typeof memory.recordAction,"function");
assert.equal(typeof memory.recent,"function");
Promise.resolve(memory.recent("test",1)).then(rows=>{
  assert.ok(Array.isArray(rows));
  console.log("GAME MEMORY TESTS: PASS");
}).catch(err=>{console.error(err);process.exit(1);});
