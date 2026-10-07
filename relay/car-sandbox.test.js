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
test("six inspection levels progressively reveal vehicle information",()=>{
  const car={id:"inspect_car",mileage:90000}; sandbox.buildCar(car);
  const one=sandbox.inspectCar(car,1);
  const four=sandbox.inspectCar(car,4);
  const six=sandbox.inspectCar(car,6);
  assert.equal(one.level,1);
  assert.equal(four.level,4);
  assert.equal(six.level,6);
  assert.equal(car.sandbox.diagnosticLevel,6);
  assert.ok(Array.isArray(one.visibleParts));
  assert.ok(four.hiddenDamage!==null);
  assert.ok(six.damagedFasteners!==null);
  assert.ok(car.sandbox.diagnosticsSpent>0);
});

test("warehouse preserves donor VIN, source part id, serial and extraction condition",()=>{
  const donor={id:"prov_donor",mileage:100000}; sandbox.buildCar(donor);
  const part=donor.sandbox.parts[0];
  part.condition=73;
  const r=sandbox.donorExtract(donor,part.id);
  assert.equal(r.ok,true);
  assert.equal(r.provenance.sourceCarId,"prov_donor");
  assert.equal(r.provenance.sourceVin,donor.sandbox.vin);
  assert.equal(r.provenance.originalPartId,part.id);
  assert.equal(r.provenance.sourceSerial,part.serial);
  assert.equal(r.provenance.extractedCondition,73);
});

test("warehouse transfer preserves provenance and installs compatible donor part",()=>{
  const donor={id:"prov_donor_2",mileage:100000}; const car={id:"prov_target_2",mileage:100000};
  sandbox.buildCar(donor); sandbox.buildCar(car);
  const source=donor.sandbox.parts[0];
  const target=car.sandbox.parts[0];
  target.installed=false;
  sandbox.donorExtract(donor,source.id);
  const moved=sandbox.transferWarehousePart(donor,car,source.id);
  assert.equal(moved.ok,true);
  assert.equal(car.sandbox.warehouse.length,1);
  const installed=sandbox.installWarehousePart(car,source.id);
  assert.equal(installed.ok,true);
  assert.equal(installed.part.installed,true);
  assert.equal(installed.part.provenance.sourceVin,donor.sandbox.vin);
  assert.equal(installed.part.provenance.originalPartId,source.id);
  assert.equal(installed.part.serial,source.serial);
});

test("warehouse sale removes item and creates revenue",()=>{
  const donor={id:"sell_donor",mileage:100000}; sandbox.buildCar(donor);
  const part=donor.sandbox.parts[0];
  sandbox.donorExtract(donor,part.id);
  const before=donor.sandbox.warehouse.length;
  const r=sandbox.sellWarehousePart(donor,part.id);
  assert.equal(r.ok,true);
  assert.ok(r.revenue>0);
  assert.equal(donor.sandbox.warehouse.length,before-1);
});

test("incompatible parts are explicitly blocked with a reason",()=>{
  const a={id:"compat_a",assembly:"block",system:"engine",name:"Блок цилиндров"};
  const b={id:"compat_b",assembly:"battery",system:"electrical",name:"Аккумулятор"};
  const r=sandbox.compatibility(a,b);
  assert.equal(r.ok,false);
  assert.equal(r.reason,"incompatible");
  assert.ok(r.details);
});


test("donor extraction moves a removed part to warehouse",()=>{
  const donor={id:"donor_1",mileage:100000}; sandbox.buildCar(donor);
  const part=donor.sandbox.parts[0];
  const r=sandbox.donorExtract(donor,part.id);
  assert.equal(r.ok,true);
  assert.equal(donor.sandbox.parts.some(p=>p.id===part.id),false);
  assert.equal(donor.sandbox.warehouse.some(p=>p.id===part.id),true);
});
test("compatible donor part can be installed into matching empty slot",()=>{
  const donor={id:"donor_2",mileage:100000}; const car={id:"car_2",mileage:100000};
  sandbox.buildCar(donor); sandbox.buildCar(car);
  const source=donor.sandbox.parts[0];
  sandbox.donorExtract(donor,source.id);
  const target=car.sandbox.parts[0]; target.installed=false;
  car.sandbox.warehouse.push({...source});
  const r=sandbox.installWarehousePart(car,source.id);
  assert.equal(r.ok,true);
  assert.equal(target.installed,true);
});

test("hierarchy creates assemblies and individual fasteners",()=>{
  const car={id:"car_h1",mileage:100000};
  sandbox.buildCar(car);
  assert.equal(car.sandbox.hierarchyVersion,1);
  const part=car.sandbox.parts[0];
  assert.equal(part.level,3);
  assert.equal(part.node.level,2);
  assert.ok(Array.isArray(part.fasteners));
  assert.ok(part.fasteners.length>=2);
  assert.ok(part.fasteners.every(f=>f.level===1&&f.installed===true));
  assert.ok(sandbox.listAssemblies(car,"engine").length>0);
});

test("fastener unscrew and screw are reversible",()=>{
  const car={id:"car_h2",mileage:100000};
  sandbox.buildCar(car);
  const part=car.sandbox.parts[0], f=part.fasteners[0];
  const a=sandbox.actionFastener(car,"unscrew",part.id,f.id);
  assert.equal(a.ok,true);
  assert.equal(f.installed,false);
  const b=sandbox.actionFastener(car,"screw",part.id,f.id);
  assert.equal(b.ok,true);
  assert.equal(f.installed,true);
  assert.ok(part.history.some(h=>String(h.action).startsWith("fastener_")));
});

test("missing fastener prevents part removal and installation",()=>{
  const car={id:"car_h3",mileage:100000};
  sandbox.buildCar(car);
  const part=car.sandbox.parts[0], f=part.fasteners[0];
  sandbox.actionFastener(car,"unscrew",part.id,f.id);
  const blockedRemove=sandbox.actionPart(car,"remove",part.id);
  assert.equal(blockedRemove.ok,false);
  assert.equal(blockedRemove.reason,"missing_fasteners");
  sandbox.actionFastener(car,"screw",part.id,f.id);
  assert.equal(sandbox.actionPart(car,"remove",part.id).ok,true);
  sandbox.actionFastener(car,"unscrew",part.id,f.id);
  const blockedInstall=sandbox.actionPart(car,"install",part.id);
  assert.equal(blockedInstall.ok,false);
  assert.equal(blockedInstall.reason,"fasteners_not_ready");
});

test("donor extraction no longer crashes on missing clone helper",()=>{
  const donor={id:"donor_h4",mileage:100000};
  sandbox.buildCar(donor);
  const part=donor.sandbox.parts[0];
  const r=sandbox.donorExtract(donor,part.id);
  assert.equal(r.ok,true);
  assert.ok(donor.sandbox.warehouse.length>0);
});

test("dependency graph blocks removal of a required installed part",()=>{
  const car={id:"dep_1",mileage:100000};
  sandbox.buildCar(car);
  const battery=car.sandbox.parts.find(p=>p.assembly==="battery");
  const starter=car.sandbox.parts.find(p=>p.assembly==="starter");
  const r=sandbox.actionPart(car,"remove",battery.id);
  assert.equal(r.ok,false);
  assert.equal(r.reason,"dependent_parts_installed");
  assert.ok(r.blockedBy.some(x=>x.id===starter.id));
});

test("dependency graph allows removal after dependent part is removed",()=>{
  const car={id:"dep_2",mileage:100000};
  sandbox.buildCar(car);
  const battery=car.sandbox.parts.find(p=>p.assembly==="battery");
  const starter=car.sandbox.parts.find(p=>p.assembly==="starter");
  for(const f of starter.fasteners) f.installed=true;
  const removedStarter=sandbox.actionPart(car,"remove",starter.id);
  assert.equal(removedStarter.ok,true);
  const removedBattery=sandbox.actionPart(car,"remove",battery.id);
  assert.equal(removedBattery.ok,true);
});

test("dependency graph exposes machine-readable relations",()=>{
  const car={id:"dep_3",mileage:100000};
  sandbox.buildCar(car);
  const graph=sandbox.dependencyGraph(car);
  const starter=graph.find(x=>x.assembly==="starter");
  assert.ok(starter);
  assert.ok(starter.dependencies.length>0);
});


test("parts market exposes all five sources",()=>{
  const car={id:"market_sources",mileage:100000}; sandbox.buildCar(car);
  sandbox.refreshPartMarket(car,12345);
  const summary=sandbox.partMarketSummary(car);
  assert.equal(sandbox.PART_SOURCES.length,5);
  assert.equal(summary.total,60);
  for(const source of sandbox.PART_SOURCES) assert.ok(summary.bySource[source.id]>0);
});

test("parts market offers carry source, condition, price and provenance",()=>{
  const car={id:"market_offer",mileage:100000}; sandbox.buildCar(car);
  sandbox.refreshPartMarket(car,777);
  const offers=sandbox.listPartMarket(car);
  assert.ok(offers.length>0);
  const offer=offers[0];
  assert.ok(offer.source);
  assert.ok(offer.sourceTitle);
  assert.ok(offer.condition>=0&&offer.condition<=100);
  assert.ok(offer.price>0);
  assert.equal(offer.provenance.offerId,offer.id);
});

test("buying a part moves it to warehouse and preserves market provenance",()=>{
  const car={id:"market_buy",mileage:100000}; sandbox.buildCar(car);
  sandbox.refreshPartMarket(car,888);
  const offer=sandbox.listPartMarket(car,{source:"dismantler"})[0];
  const before=car.sandbox.warehouse.length;
  const result=sandbox.buyPartMarketOffer(car,offer.id,offer.price+1000);
  assert.equal(result.ok,true);
  assert.equal(car.sandbox.warehouse.length,before+1);
  assert.equal(result.part.provenance.marketSource,"dismantler");
  assert.equal(result.part.provenance.offerId,offer.id);
  assert.equal(result.part.serial,offer.serial);
  assert.equal(result.part.condition,offer.condition);
  assert.equal(result.part.fasteners.length>0,true);
});

test("parts market refuses purchase without enough money and does not mutate warehouse",()=>{
  const car={id:"market_money",mileage:100000}; sandbox.buildCar(car);
  sandbox.refreshPartMarket(car,999);
  const offer=sandbox.listPartMarket(car)[0];
  const before=car.sandbox.warehouse.length;
  const result=sandbox.buyPartMarketOffer(car,offer.id,offer.price-1);
  assert.equal(result.ok,false);
  assert.equal(result.reason,"insufficient_funds");
  assert.equal(car.sandbox.warehouse.length,before);
  assert.ok(sandbox.getPartMarketOffer(car,offer.id));
});

test("used and new market offers have source-specific economics",()=>{
  const car={id:"market_types",mileage:100000}; sandbox.buildCar(car);
  sandbox.refreshPartMarket(car,13579);
  const store=sandbox.listPartMarket(car,{source:"store"})[0];
  const dismantler=sandbox.listPartMarket(car,{source:"dismantler"})[0];
  const china=sandbox.listPartMarket(car,{source:"china"})[0];
  assert.equal(store.type,"new");
  assert.equal(dismantler.type,"used");
  assert.equal(china.type,"new");
  assert.ok(store.condition>=98);
  assert.ok(dismantler.condition<98);
});

test("market filters by system, type and maximum price",()=>{
  const car={id:"market_filters",mileage:100000}; sandbox.buildCar(car);
  sandbox.refreshPartMarket(car,2468);
  const offers=sandbox.listPartMarket(car,{system:"engine",type:"used",maxPrice:50000});
  assert.ok(offers.every(o=>o.system==="engine"&&o.type==="used"&&o.price<=50000));
});
