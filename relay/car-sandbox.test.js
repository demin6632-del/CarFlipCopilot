const assert=require("node:assert/strict");
const sandbox=require("./car-sandbox");

function test(name,fn){fn();console.log("PASS:",name);}

test("buildCar creates a 3-level part model",()=>{
  const car={id:"car_test_1",mileage:120000};
  sandbox.buildCar(car);
  assert.equal(car.sandbox.parts.length,35);
  assert.equal(sandbox.SYSTEMS.length,9);
  assert.ok(car.sandbox.parts.every(p=>p.system&&p.assembly&&p.name&&p.condition>=15&&p.condition<=100));
});

test("remove and install are reversible",()=>{
  const car={id:"car_test_2",mileage:90000};
  sandbox.buildCar(car);
  const part=car.sandbox.parts[0];
  const a=sandbox.actionPart(car,"remove",part.id);
  assert.equal(a.ok,true);
  assert.equal(part.installed,false);
  const b=sandbox.actionPart(car,"install",part.id);
  assert.equal(b.ok,true);
  assert.equal(part.installed,true);
});

test("repair improves condition and creates history",()=>{
  const car={id:"car_test_3",mileage:80000};
  sandbox.buildCar(car);
  const part=car.sandbox.parts[1];
  part.condition=40;
  const before=part.condition;
  const r=sandbox.actionPart(car,"repair",part.id);
  assert.equal(r.ok,true);
  assert.ok(part.condition>before);
  assert.ok(part.history.length>0);
});

test("part replacement has its own economics",()=>{
  const car={id:"car_test_4",mileage:70000};
  sandbox.buildCar(car);
  const part=car.sandbox.parts[2];
  const r=sandbox.actionPart(car,"replace_new",part.id);
  assert.equal(r.ok,true);
  assert.equal(part.condition,100);
  assert.ok(r.cost>0);
});

test("full disassembly affects every part",()=>{
  const car={id:"car_test_5",mileage:100000};
  sandbox.buildCar(car);
  const r=sandbox.applyGlobalAction(car,"full_disassembly");
  assert.equal(r.ok,true);
  assert.equal(car.sandbox.disassembled,true);
  assert.ok(car.sandbox.parts.every(p=>p.installed===false));
});

test("illegal-risk actions are recorded instead of hidden",()=>{
  const car={id:"car_test_6",mileage:150000};
  sandbox.buildCar(car);
  const ecu=car.sandbox.parts.find(p=>p.name.includes("Блок управления"));
  const r=sandbox.actionPart(car,"ecu_tune",ecu.id);
  assert.equal(r.ok,true);
  assert.equal(car.sandbox.flags.ecuTune,true);
  assert.equal(car.sandbox.history.some(h=>h.action==="ecu_tune"),true);
});

console.log("Car sandbox tests: OK");
