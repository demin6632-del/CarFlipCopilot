/*
 * СИМУЛЯТОР ПЕРЕКУПА — SANDBOX CORE V1
 * Полностью собственная модель автомобиля.
 * Не зависит от сторонних игровых ботов.
 */

const SYSTEMS = [
  { id:"engine", title:"Двигатель" },
  { id:"transmission", title:"Трансмиссия" },
  { id:"chassis", title:"Ходовая часть" },
  { id:"brakes", title:"Тормозная система" },
  { id:"electrical", title:"Электрика" },
  { id:"body", title:"Кузов" },
  { id:"interior", title:"Салон" },
  { id:"wheels", title:"Колёса" },
  { id:"options", title:"Опции" }
];

const ACTIONS = [
  "remove","install","repair","replace_new","replace_used","sell_part",
  "buy_part","paint","polish","upholstery","clean","odometer","ecu_tune",
  "weld","dent_repair","disable_egr","vin_replace","reinforce"
];

const PART_TEMPLATES = [
  ["engine","block","Блок цилиндров",4,92000,0.88],
  ["engine","head","Головка блока",4,68000,0.82],
  ["engine","timing","Комплект ГРМ",3,24000,0.76],
  ["engine","oil_pump","Масляный насос",3,15000,0.78],
  ["engine","starter","Стартер",3,13000,0.84],
  ["engine","alternator","Генератор",3,18000,0.86],
  ["transmission","gearbox","Коробка передач",5,115000,0.82],
  ["transmission","clutch","Сцепление",3,28000,0.80],
  ["transmission","driveshaft","Приводной вал",3,22000,0.86],
  ["chassis","front_subframe","Передний подрамник",4,34000,0.88],
  ["chassis","shock_front_l","Передний амортизатор левый",2,9000,0.82],
  ["chassis","shock_front_r","Передний амортизатор правый",2,9000,0.82],
  ["chassis","arm_front_l","Передний рычаг левый",2,7500,0.80],
  ["chassis","arm_front_r","Передний рычаг правый",2,7500,0.80],
  ["chassis","steering","Рулевая рейка",4,42000,0.79],
  ["brakes","disc_front_l","Передний тормозной диск левый",2,6500,0.86],
  ["brakes","disc_front_r","Передний тормозной диск правый",2,6500,0.86],
  ["brakes","caliper_l","Суппорт левый",2,8500,0.82],
  ["brakes","caliper_r","Суппорт правый",2,8500,0.82],
  ["electrical","battery","Аккумулятор",1,11000,0.90],
  ["electrical","ecu","Блок управления двигателем",4,36000,0.76],
  ["electrical","wiring","Проводка",3,17000,0.80],
  ["body","hood","Капот",2,26000,0.82],
  ["body","fender_l","Крыло левое",2,18000,0.84],
  ["body","fender_r","Крыло правое",2,18000,0.84],
  ["body","door_l","Дверь левая",3,31000,0.83],
  ["body","door_r","Дверь правая",3,31000,0.83],
  ["body","bumper","Бампер",2,24000,0.86],
  ["interior","driver_seat","Сиденье водителя",2,19000,0.88],
  ["interior","dashboard","Панель приборов",3,27000,0.82],
  ["wheels","wheel_l","Колесо левое",2,15000,0.90],
  ["wheels","wheel_r","Колесо правое",2,15000,0.90],
  ["options","climate","Климатическая установка",3,32000,0.81],
  ["options","multimedia","Мультимедиа",2,22000,0.86]
];

function money(n){ return Math.round(Number(n)||0); }
function clamp(n,min,max){ return Math.max(min,Math.min(max,n)); }

function makePartId(carId,index){
  return carId+"_part_"+String(index+1);
}

function createPart(carId, row, index, seed){
  const [system,assembly,name,wear,purchaseValue,reliability]=row;
  const wave=((seed*(index+11))%37)/100;
  const condition=clamp(Math.round(58+wave*40),15,100);
  return {
    id:makePartId(carId,index),
    system,
    assembly,
    name,
    level:3,
    condition,
    wear:100-condition,
    purchaseValue:money(purchaseValue),
    marketValue:money(purchaseValue*(0.45+condition/180)),
    repairable:true,
    reliability,
    installed:true,
    hiddenDamage:condition<65,
    serial:carId.toUpperCase()+"-"+String(index+1).padStart(3,"0"),
    fasteners:Math.max(2,wear+1),
    history:[],
    modifications:[]
  };
}

function buildCar(car){
  const carId=String(car.id);
  if(car.sandbox && Array.isArray(car.sandbox.parts)) return car;
  const seed=String(carId).split("").reduce((a,c)=>a+c.charCodeAt(0),0);
  const parts=PART_TEMPLATES.map((row,i)=>createPart(carId,row,i,seed));
  car.sandbox={
    version:1,
    mileage:money(car.mileage),
    odometerOriginal:money(car.mileage),
    vin:String(carId).toUpperCase(),
    vinOriginal:String(carId).toUpperCase(),
    disassembled:false,
    parts,
    warehouse:[],
    history:[{
      time:Date.now(),
      action:"acquire",
      text:"Автомобиль принят в личный гараж."
    }],
    flags:{
      ecuTune:false,
      egrDisabled:false,
      vinChanged:false,
      reinforced:false,
      restored:false
    }
  };
  return car;
}

function getPart(car,partId){
  return car?.sandbox?.parts?.find(p=>p.id===partId) || null;
}

function record(car,action,part,text){
  car.sandbox.history.unshift({
    time:Date.now(),
    action,
    partId:part?.id||null,
    text
  });
  car.sandbox.history=car.sandbox.history.slice(0,120);
  if(part){
    part.history.unshift({time:Date.now(),action,text});
    part.history=part.history.slice(0,40);
  }
}

function actionRules(action){
  const rules={
    remove:{time:1,cost:250,needsInstalled:true},
    install:{time:1,cost:350,needsInstalled:false},
    repair:{time:2,cost:0,needsInstalled:true},
    replace_new:{time:3,cost:0,needsInstalled:true},
    replace_used:{time:2,cost:0,needsInstalled:true},
    sell_part:{time:1,cost:0,needsInstalled:false},
    buy_part:{time:1,cost:0,needsInstalled:false},
    paint:{time:2,cost:6500,needsInstalled:true},
    polish:{time:1,cost:1800,needsInstalled:true},
    upholstery:{time:3,cost:9000,needsInstalled:true},
    clean:{time:1,cost:1200,needsInstalled:true},
    odometer:{time:2,cost:14000,needsInstalled:true},
    ecu_tune:{time:2,cost:22000,needsInstalled:true},
    weld:{time:2,cost:7500,needsInstalled:true},
    dent_repair:{time:2,cost:5000,needsInstalled:true},
    disable_egr:{time:1,cost:9000,needsInstalled:true},
    vin_replace:{time:4,cost:45000,needsInstalled:true},
    reinforce:{time:3,cost:28000,needsInstalled:true}
  };
  return rules[action]||null;
}

function actionPart(car,action,partId){
  const part=getPart(car,partId);
  const rule=actionRules(action);
  if(!rule) return {ok:false,reason:"unknown_action"};
  if(!part) return {ok:false,reason:"part_missing"};
  if(rule.needsInstalled && !part.installed) return {ok:false,reason:"part_removed"};
  if(action==="remove"){
    part.installed=false;
    car.sandbox.disassembled=true;
    record(car,action,part,"Деталь снята с автомобиля.");
    return {ok:true,time:rule.time,cost:rule.cost,part};
  }
  if(action==="install"){
    part.installed=true;
    record(car,action,part,"Деталь установлена обратно.");
    return {ok:true,time:rule.time,cost:rule.cost,part};
  }
  if(action==="repair"){
    const gain=Math.max(8,Math.round((100-part.condition)*0.55));
    part.condition=clamp(part.condition+gain,0,100);
    part.wear=100-part.condition;
    part.hiddenDamage=part.condition<60;
    const cost=money(Math.max(2500,part.purchaseValue*(gain/100)*0.45));
    record(car,action,part,"Деталь восстановлена до "+part.condition+"%.");
    return {ok:true,time:rule.time,cost,part};
  }
  if(action==="paint" || action==="polish" || action==="upholstery" || action==="clean"){
    part.modifications.push(action);
    record(car,action,part,"Выполнена операция: "+action+".");
    return {ok:true,time:rule.time,cost:rule.cost,part};
  }
  if(action==="weld" || action==="dent_repair" || action==="reinforce"){
    part.condition=clamp(part.condition+12,0,100);
    part.wear=100-part.condition;
    part.modifications.push(action);
    record(car,action,part,"Кузовная/усиливающая операция завершена.");
    return {ok:true,time:rule.time,cost:rule.cost,part};
  }
  if(action==="ecu_tune"){
    car.sandbox.flags.ecuTune=true;
    part.modifications.push(action);
    record(car,action,part,"ECU перенастроен.");
    return {ok:true,time:rule.time,cost:rule.cost,part};
  }
  if(action==="disable_egr"){
    car.sandbox.flags.egrDisabled=true;
    record(car,action,part,"EGR отключён.");
    return {ok:true,time:rule.time,cost:rule.cost,part};
  }
  if(action==="odometer"){
    car.sandbox.mileage=Math.max(0,Math.round(car.sandbox.mileage*0.72));
    part.modifications.push(action);
    record(car,action,part,"Показание одометра изменено. История сохранила факт вмешательства.");
    return {ok:true,time:rule.time,cost:rule.cost,warning:"history_flag"};
  }
  if(action==="vin_replace"){
    car.sandbox.vin=car.sandbox.vin+"-R";
    car.sandbox.flags.vinChanged=true;
    record(car,action,part,"Идентификатор кузова изменён. История сохранила факт вмешательства.");
    return {ok:true,time:rule.time,cost:rule.cost,warning:"legal_risk"};
  }
  if(action==="sell_part"){
    if(part.installed) return {ok:false,reason:"remove_first"};
    const value=money(part.marketValue*(0.75+part.condition/400));
    car.sandbox.warehouse=car.sandbox.warehouse.filter(p=>p.id!==part.id);
    record(car,action,part,"Деталь продана отдельно за "+value+" ₽.");
    return {ok:true,time:rule.time,cost:0,revenue:value,part};
  }
  if(action==="replace_new" || action==="replace_used"){
    const oldCondition=part.condition;
    part.condition=action==="replace_new"?100:Math.round(65+part.reliability*30);
    part.wear=100-part.condition;
    part.hiddenDamage=false;
    part.modifications.push(action);
    const cost=action==="replace_new"
      ? money(part.purchaseValue*1.18)
      : money(part.purchaseValue*(0.45+part.reliability*0.25));
    record(car,action,part,"Деталь заменена: было "+oldCondition+"%, стало "+part.condition+"%.");
    return {ok:true,time:rule.time,cost,part};
  }
  return {ok:false,reason:"unsupported_action"};
}

function listSystems(car){
  return SYSTEMS.map(s=>{
    const parts=car.sandbox.parts.filter(p=>p.system===s.id);
    const avg=parts.length?Math.round(parts.reduce((a,p)=>a+p.condition,0)/parts.length):0;
    return {id:s.id,title:s.title,count:parts.length,averageCondition:avg};
  });
}

function listParts(car,systemId){
  return car.sandbox.parts.filter(p=>!systemId||p.system===systemId);
}

function compatibility(source,target){
  if(!source||!target) return {ok:false,score:0,reason:"missing_part"};
  const sameAssembly=source.assembly===target.assembly;
  const sameSystem=source.system===target.system;
  const score=(sameAssembly?0.65:0)+(sameSystem?0.25:0)+(source.name===target.name?0.10:0);
  return {ok:score>=0.9,score,reason:score>=0.9?"compatible":"incompatible"};
}
function removeToWarehouse(car,partId){
  const part=getPart(car,partId);
  if(!part) return {ok:false,reason:"part_missing"};
  if(part.installed) return {ok:false,reason:"remove_first"};
  if(!Array.isArray(car.sandbox.warehouse)) car.sandbox.warehouse=[];
  if(!car.sandbox.warehouse.some(p=>p.id===part.id)) car.sandbox.warehouse.push(clone(part));
  car.sandbox.parts=car.sandbox.parts.filter(p=>p.id!==part.id);
  record(car,"warehouse_add",part,"Деталь помещена на склад.");
  return {ok:true,part};
}
function donorExtract(donor,partId){
  if(!donor?.sandbox) buildCar(donor);
  const part=getPart(donor,partId);
  if(!part) return {ok:false,reason:"part_missing"};
  if(part.installed){
    const removed=actionPart(donor,"remove",part.id);
    if(!removed.ok) return removed;
  }
  return removeToWarehouse(donor,part.id);
}
function installWarehousePart(car,partId){
  if(!car?.sandbox) buildCar(car);
  if(!Array.isArray(car.sandbox.warehouse)) car.sandbox.warehouse=[];
  const source=car.sandbox.warehouse.find(p=>p.id===partId);
  if(!source) return {ok:false,reason:"warehouse_missing"};
  const target=car.sandbox.parts.find(p=>p.name===source.name&&!p.installed);
  if(!target) return {ok:false,reason:"no_matching_slot"};
  const c=compatibility(source,target);
  if(!c.ok) return {ok:false,reason:"incompatible",compatibility:c};
  Object.assign(target,{condition:source.condition,wear:source.wear,marketValue:source.marketValue,hiddenDamage:source.hiddenDamage,serial:source.serial,modifications:(source.modifications||[]).slice(),installed:true});
  car.sandbox.warehouse=car.sandbox.warehouse.filter(p=>p.id!==partId);
  record(car,"donor_install",target,"Донорская деталь установлена. Серийный номер: "+target.serial);
  return {ok:true,part:target,source};
}
function donorCompatibility(car,donor){
  if(!car?.sandbox||!donor?.sandbox) return {compatible:[],incompatible:[]};
  const compatible=[],incompatible=[];
  for(const source of donor.sandbox.parts.filter(p=>p.installed)){
    const target=car.sandbox.parts.find(p=>p.name===source.name);
    if(target){const c=compatibility(source,target);(c.ok?compatible:incompatible).push({source,target,score:c.score});}
  }
  return {compatible,incompatible};
}

function carSandboxSummary(car){
  const parts=car.sandbox.parts;
  const avg=parts.length?Math.round(parts.reduce((a,p)=>a+p.condition,0)/parts.length):0;
  const installed=parts.filter(p=>p.installed).length;
  const hidden=parts.filter(p=>p.hiddenDamage).length;
  return {
    averageCondition:avg,
    installedParts:installed,
    totalParts:parts.length,
    hiddenDefects:hidden,
    legalRisk:!!(car.sandbox.flags.vinChanged||car.sandbox.flags.egrDisabled||car.sandbox.flags.ecuTune),
    estimatedPartsValue:parts.reduce((a,p)=>a+money(p.marketValue),0)
  };
}

function applyGlobalAction(car,action){
  if(!car.sandbox) buildCar(car);
  if(action==="full_disassembly"){
    for(const p of car.sandbox.parts) p.installed=false;
    car.sandbox.disassembled=true;
    record(car,action,null,"Автомобиль полностью разобран до уровня деталей.");
    return {ok:true,time:8,cost:12000};
  }
  if(action==="partial_disassembly"){
    car.sandbox.parts.filter(p=>p.condition<70).forEach(p=>p.installed=false);
    car.sandbox.disassembled=true;
    record(car,action,null,"Выполнена частичная разборка проблемных узлов.");
    return {ok:true,time:4,cost:6000};
  }
  if(action==="restoration"){
    const cost=money(car.sandbox.parts.reduce((a,p)=>a+(100-p.condition)*p.purchaseValue/9000,0));
    for(const p of car.sandbox.parts){p.condition=Math.max(p.condition,95);p.wear=100-p.condition;p.hiddenDamage=false;}
    car.sandbox.flags.restored=true;
    record(car,action,null,"Выполнено комплексное восстановление автомобиля.");
    return {ok:true,time:12,cost:Math.max(30000,cost)};
  }
  if(action==="frankenstein"){
    record(car,action,null,"Подготовлено объединение с донорским автомобилем. Совместимость деталей проверяется отдельно.");
    return {ok:true,time:10,cost:25000,requiresDonor:true};
  }
  if(action==="tuning"){
    car.sandbox.flags.ecuTune=true;
    record(car,action,null,"Запущен комплексный тюнинг.");
    return {ok:true,time:8,cost:65000};
  }
  return {ok:false,reason:"unknown_global_action"};
}

module.exports={
  SYSTEMS,ACTIONS,buildCar,getPart,actionRules,actionPart,
  listSystems,listParts,carSandboxSummary,applyGlobalAction,
  compatibility,removeToWarehouse,donorExtract,installWarehousePart,donorCompatibility
};
