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
  if(!source||!target) return {ok:false,score:0,reason:"missing_part",details:"Не найдена исходная или целевая деталь."};
  const sameAssembly=source.assembly===target.assembly;
  const sameSystem=source.system===target.system;
  const sameName=source.name===target.name;
  const score=(sameAssembly?0.65:0)+(sameSystem?0.25:0)+(sameName?0.10:0);
  let details;
  if(score>=0.9) details="Совпадают система, узел и назначение детали.";
  else if(!sameSystem) details="Деталь относится к другой системе автомобиля.";
  else if(!sameAssembly) details="Деталь относится к другому узлу.";
  else details="Тип детали не совпадает.";
  return {ok:score>=0.9,score,reason:score>=0.9?"compatible":"incompatible",details};
}
function removeToWarehouse(car,partId){
  const part=getPart(car,partId);
  if(!part) return {ok:false,reason:"part_missing"};
  if(part.installed) return {ok:false,reason:"remove_first"};
  if(!Array.isArray(car.sandbox.warehouse)) car.sandbox.warehouse=[];
  if(car.sandbox.warehouse.some(p=>p.id===part.id)) return {ok:false,reason:"already_in_warehouse"};
  const item=clone(part);
  item.warehouseStatus="stored";
  item.provenance={
    sourceCarId:String(car.id),
    sourceVin:String(car.sandbox.vin),
    originalPartId:String(part.id),
    sourceSerial:String(part.serial),
    extractedCondition:Number(part.condition)||0,
    extractedAt:Date.now()
  };
  item.history=Array.isArray(item.history)?item.history:[];
  item.history.unshift({time:Date.now(),action:"warehouse_extract",text:"Снята с автомобиля и помещена на склад."});
  car.sandbox.warehouse.push(item);
  car.sandbox.parts=car.sandbox.parts.filter(p=>p.id!==part.id);
  record(car,"warehouse_add",part,"Деталь помещена на склад. Происхождение и серийный номер сохранены.");
  return {ok:true,part:item,provenance:item.provenance};
}
function donorExtract(donor,partId){
  if(!donor?.sandbox) buildCar(donor);
  const part=getPart(donor,partId);
  if(!part) return {ok:false,reason:"part_missing"};
  if(part.installed){
    const dependencyCheck=canRemovePart(donor,part);
    if(!dependencyCheck.ok) return dependencyCheck;
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
  const dependencyCheck=canInstallPart(car,target);
  if(!dependencyCheck.ok) return dependencyCheck;
  const provenance=clone(source.provenance||{});
  Object.assign(target,{condition:source.condition,wear:source.wear,marketValue:source.marketValue,hiddenDamage:source.hiddenDamage,serial:source.serial,modifications:(source.modifications||[]).slice(),installed:true});
  target.provenance=provenance;
  target.history=Array.isArray(target.history)?target.history:[];
  target.history.unshift({time:Date.now(),action:"donor_install",text:"Установлена складская/донорская деталь. Источник VIN: "+(provenance.sourceVin||"не указан")+", серийный номер: "+target.serial});
  source.warehouseStatus="installed";
  car.sandbox.warehouse=car.sandbox.warehouse.filter(p=>p.id!==partId);
  record(car,"donor_install",target,"Донорская деталь установлена. Происхождение сохранено.");
  return {ok:true,part:target,source,provenance};
}

function transferWarehousePart(sourceCar,targetCar,partId){
  if(!sourceCar?.sandbox) buildCar(sourceCar);
  if(!targetCar?.sandbox) buildCar(targetCar);
  const item=sourceCar.sandbox.warehouse?.find(p=>p.id===partId);
  if(!item) return {ok:false,reason:"warehouse_missing"};
  if(String(sourceCar.id)===String(targetCar.id)) return {ok:false,reason:"same_car"};
  if(!Array.isArray(targetCar.sandbox.warehouse)) targetCar.sandbox.warehouse=[];
  const targetSlot=targetCar.sandbox.parts.find(p=>p.name===item.name&&!p.installed);
  if(!targetSlot) return {ok:false,reason:"no_matching_slot"};
  const check=compatibility(item,targetSlot);
  if(!check.ok) return {ok:false,reason:"incompatible",compatibility:check};
  const moved=clone(item);
  moved.warehouseStatus="stored";
  moved.provenance=Object.assign({},moved.provenance||{},{
    transferredToCarId:String(targetCar.id),
    transferredAt:Date.now()
  });
  moved.history=Array.isArray(moved.history)?moved.history:[];
  moved.history.unshift({time:Date.now(),action:"warehouse_transfer",text:"Перемещена со склада донора на склад целевого автомобиля."});
  targetCar.sandbox.warehouse.push(moved);
  sourceCar.sandbox.warehouse=sourceCar.sandbox.warehouse.filter(p=>p.id!==partId);
  record(sourceCar,"warehouse_transfer_out",item,"Деталь передана со склада автомобиля-донора.");
  record(targetCar,"warehouse_transfer_in",moved,"Деталь принята на склад с сохранением происхождения.");
  return {ok:true,part:moved,compatibility:check};
}

function sellWarehousePart(car,partId){
  if(!car?.sandbox) buildCar(car);
  const item=car.sandbox.warehouse?.find(p=>p.id===partId);
  if(!item) return {ok:false,reason:"warehouse_missing"};
  const revenue=money((item.marketValue||item.purchaseValue||0)*(0.70+(Number(item.condition)||0)/500));
  car.sandbox.warehouse=car.sandbox.warehouse.filter(p=>p.id!==partId);
  record(car,"warehouse_sell",item,"Складская деталь продана за "+revenue+" ₽.");
  return {ok:true,revenue,part:item};
}

function warehouseItem(car,partId){
  return car?.sandbox?.warehouse?.find(p=>p.id===partId)||null;
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

const INSPECTION_LEVELS=[
  {level:1,title:"Визуальный осмотр",cost:0,time:0},
  {level:2,title:"Компьютерная диагностика",cost:5000,time:1},
  {level:3,title:"Механическая диагностика",cost:12000,time:2},
  {level:4,title:"Глубокая диагностика",cost:25000,time:4},
  {level:5,title:"Экспертная диагностика",cost:45000,time:6},
  {level:6,title:"Полная дефектовка",cost:80000,time:10}
];

function inspectCar(car,level){
  if(!car?.sandbox) buildCar(car);
  ensureHierarchy(car);
  const n=Math.max(1,Math.min(6,Number(level)||1));
  const spec=INSPECTION_LEVELS[n-1];
  const visible=car.sandbox.parts.filter(p=>{
    if(n>=3) return true;
    if(n===2) return ["engine","transmission","brakes","electrical"].includes(p.system);
    return p.system==="body"||p.system==="wheels";
  });
  const hidden=n>=4?car.sandbox.parts.filter(p=>p.hiddenDamage):[];
  const fasteners=n>=6?car.sandbox.parts.reduce((a,p)=>a+(p.fasteners||[]).filter(f=>f.condition<50).length,0):null;
  car.sandbox.diagnosticLevel=Math.max(Number(car.sandbox.diagnosticLevel)||0,n);
  car.sandbox.diagnosticsSpent=(Number(car.sandbox.diagnosticsSpent)||0)+spec.cost;
  record(car,"inspection_"+n,null,"Проведена диагностика: "+spec.title+".");
  return {
    ok:true,level:n,title:spec.title,cost:spec.cost,time:spec.time,
    visibleParts:visible.map(p=>({id:p.id,name:p.name,condition:p.condition,system:p.system,assembly:p.assembly,hiddenDamage:n>=4&&!!p.hiddenDamage})),
    hiddenDamage:n>=4?hidden.length:null,
    damagedFasteners:fasteners,
    legalRisk:n>=5?!!(car.sandbox.flags.vinChanged||car.sandbox.flags.egrDisabled||car.sandbox.flags.ecuTune):null,
    provenanceCount:n>=5?car.sandbox.parts.filter(p=>p.provenance).length:null
  };
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
  SYSTEMS,ACTIONS,INSPECTION_LEVELS,buildCar,getPart,actionRules,actionPart,
  listSystems,listParts,carSandboxSummary,applyGlobalAction,
  compatibility,removeToWarehouse,donorExtract,installWarehousePart,donorCompatibility
};


/* V3 HIERARCHY: SYSTEM -> ASSEMBLY -> PART -> FASTENER */
function clone(value){ return JSON.parse(JSON.stringify(value)); }

const ASSEMBLY_TITLES={
  block:"Блок двигателя",head:"Головка блока",timing:"ГРМ",oil_pump:"Масляная система",
  starter:"Стартер",alternator:"Генератор",gearbox:"Корпус КПП",clutch:"Сцепление",driveshaft:"Приводной вал",
  front_subframe:"Передний подрамник",shock_front_l:"Передняя подвеска — левый амортизатор",
  shock_front_r:"Передняя подвеска — правый амортизатор",arm_front_l:"Передняя подвеска — левый рычаг",
  arm_front_r:"Передняя подвеска — правый рычаг",steering:"Рулевое управление",
  disc_front_l:"Передний тормоз — левый диск",disc_front_r:"Передний тормоз — правый диск",
  caliper_l:"Передний тормоз — левый суппорт",caliper_r:"Передний тормоз — правый суппорт",
  battery:"Питание",ecu:"ЭБУ",wiring:"Жгуты проводки",hood:"Капот",fender_l:"Левое крыло",
  fender_r:"Правое крыло",door_l:"Левая дверь",door_r:"Правая дверь",bumper:"Бампер",
  driver_seat:"Сиденье водителя",dashboard:"Панель приборов",wheel_l:"Левое колесо",
  wheel_r:"Правое колесо",climate:"Климат",multimedia:"Мультимедиа"
};

const FASTENER_TYPES=[
  ["bolt","Болт",12,450],["nut","Гайка",10,180],["washer","Шайба",8,90],
  ["clip","Клипса",1,60],["seal","Уплотнитель",2,250],["connector","Разъём",3,350],
  ["gasket","Прокладка",3,500]
];

function createFastener(part,index){
  const [type,title,size,value]=FASTENER_TYPES[index%FASTENER_TYPES.length];
  const condition=clamp(part.condition+((index%3)-1)*4,15,100);
  return {
    id:part.id+"_f_"+String(index+1),level:1,type,title,spec:String(size)+" мм",quantity:1,
    condition,installed:true,purchaseValue:value,marketValue:money(value*(0.65+condition/300)),
    history:[],serial:part.serial+"-F"+String(index+1).padStart(2,"0")
  };
}

function fastenerCountForPart(part){
  if(part.assembly==="wiring"||part.assembly==="multimedia") return 3;
  if(part.assembly==="wheel_l"||part.assembly==="wheel_r") return 5;
  if(part.assembly==="gearbox"||part.assembly==="block"||part.assembly==="head") return 6;
  return Math.max(2,Math.min(5,part.fasteners||3));
}

function ensureHierarchy(car){
  if(!car?.sandbox?.parts) return car;
  for(const part of car.sandbox.parts){
    part.level=3;
    part.node=part.node||{id:part.assembly,level:2,title:ASSEMBLY_TITLES[part.assembly]||part.assembly,system:part.system};
    if(!Array.isArray(part.fasteners)){
      const count=fastenerCountForPart(part);
      part.fasteners=Array.from({length:count},(_,i)=>createFastener(part,i));
    }else{
      part.fasteners=part.fasteners.map((f,i)=>Object.assign({
        id:part.id+"_f_"+String(i+1),level:1,installed:true,quantity:1,condition:part.condition,history:[]
      },f));
    }
    part.fastenersRequired=part.fasteners.length;
  }
  car.sandbox.hierarchyVersion=1;
  return car;
}

function getFastener(car,partId,fastenerId){
  const part=getPart(car,partId);
  return part?.fasteners?.find(f=>f.id===fastenerId)||null;
}

function fastenerSummary(part){
  const list=part.fasteners||[];
  return {
    total:list.length,installed:list.filter(f=>f.installed).length,
    missing:list.filter(f=>!f.installed).length,damaged:list.filter(f=>f.condition<50).length,
    ready:list.length>0&&list.every(f=>f.installed&&f.condition>=35)
  };
}

function actionFastener(car,action,partId,fastenerId){
  const part=getPart(car,partId),fastener=getFastener(car,partId,fastenerId);
  if(!part) return {ok:false,reason:"part_missing"};
  if(!fastener) return {ok:false,reason:"fastener_missing"};
  const costs={unscrew:{time:1,cost:50},screw:{time:1,cost:70},remove:{time:1,cost:30},
    install:{time:1,cost:40},replace:{time:1,cost:fastener.purchaseValue},
    buy:{time:1,cost:fastener.purchaseValue},sell:{time:1,cost:0}};
  const rule=costs[action];
  if(!rule) return {ok:false,reason:"unknown_fastener_action"};
  if(action==="unscrew"||action==="remove"){
    if(!fastener.installed) return {ok:false,reason:"already_removed"};
    fastener.installed=false;
    fastener.history.unshift({time:Date.now(),action,text:"Крепёж снят."});
    part.history.unshift({time:Date.now(),action:"fastener_"+action,text:"Снят "+fastener.title+" "+fastener.spec+"."});
    return {ok:true,time:rule.time,cost:rule.cost,fastener};
  }
  if(action==="screw"||action==="install"){
    if(fastener.installed) return {ok:false,reason:"already_installed"};
    fastener.installed=true;
    fastener.history.unshift({time:Date.now(),action,text:"Крепёж установлен."});
    part.history.unshift({time:Date.now(),action:"fastener_"+action,text:"Установлен "+fastener.title+" "+fastener.spec+"."});
    return {ok:true,time:rule.time,cost:rule.cost,fastener};
  }
  if(action==="replace"){
    fastener.installed=true;fastener.condition=100;
    fastener.history.unshift({time:Date.now(),action,text:"Крепёж заменён новым."});
    part.history.unshift({time:Date.now(),action:"fastener_replace",text:"Крепёж заменён новым."});
    return {ok:true,time:rule.time,cost:rule.cost,fastener};
  }
  if(action==="buy"){
    fastener.installed=false;fastener.condition=100;
    fastener.history.unshift({time:Date.now(),action,text:"Крепёж приобретён и подготовлен к установке."});
    return {ok:true,time:rule.time,cost:rule.cost,fastener};
  }
  if(action==="sell"){
    if(fastener.installed) return {ok:false,reason:"remove_first"};
    const revenue=money(fastener.marketValue);
    part.history.unshift({time:Date.now(),action:"fastener_sell",text:"Крепёж продан за "+revenue+" ₽."});
    return {ok:true,time:rule.time,revenue,fastener};
  }
}

function listAssemblies(car,systemId){
  const groups=new Map();
  for(const p of car.sandbox.parts.filter(p=>!systemId||p.system===systemId)){
    if(!groups.has(p.assembly)) groups.set(p.assembly,{id:p.assembly,level:2,title:ASSEMBLY_TITLES[p.assembly]||p.assembly,
      system:p.system,parts:0,averageCondition:0,fasteners:0,missingFasteners:0});
    const g=groups.get(p.assembly);g.parts++;g.averageCondition+=p.condition;
    const fs=fastenerSummary(p);g.fasteners+=fs.total;g.missingFasteners+=fs.missing;
  }
  return Array.from(groups.values()).map(g=>{
    g.averageCondition=g.parts?Math.round(g.averageCondition/g.parts):0;return g;
  });
}

function listFasteners(car,partId){ return getPart(car,partId)?.fasteners||[]; }

const baseBuildCar=buildCar;
const baseActionPart=actionPart;

function hierarchyBuildCar(car){ return ensureHierarchy(baseBuildCar(car)); }

function hierarchyActionPart(car,action,partId){
  ensureHierarchy(car);
  const part=getPart(car,partId);
  if(!part) return {ok:false,reason:"part_missing"};
  if(action==="remove"){
    const fs=fastenerSummary(part);
    if(fs.missing>0) return {ok:false,reason:"missing_fasteners",missing:fs.missing};
  }
  if(action==="install"){
    const fs=fastenerSummary(part);
    if(!fs.ready) return {ok:false,reason:"fasteners_not_ready",missing:fs.missing,damaged:fs.damaged};
  }
  return baseActionPart(car,action,partId);
}

function hierarchyDonorExtract(donor,partId){
  const car=hierarchyBuildCar(donor);
  const result=donorExtract(car,partId);
  ensureHierarchy(car);
  return result;
}

module.exports={
  SYSTEMS,ACTIONS,buildCar:hierarchyBuildCar,getPart,actionRules,actionPart:hierarchyActionPart,
  listSystems,listParts,listAssemblies,listFasteners,getFastener,fastenerSummary,actionFastener,ensureHierarchy,
  carSandboxSummary,applyGlobalAction,compatibility,removeToWarehouse,donorExtract:hierarchyDonorExtract,
  installWarehousePart,donorCompatibility
};


/* V3 DEPENDENCY GRAPH */

const PART_DEPENDENCIES={
  head:["block"],timing:["head"],oil_pump:["block"],starter:["battery"],alternator:["battery"],
  gearbox:["clutch"],clutch:["gearbox"],driveshaft:["gearbox"],front_subframe:["shock_front_l","shock_front_r","arm_front_l","arm_front_r"],
  steering:["front_subframe"],disc_front_l:["caliper_l"],disc_front_r:["caliper_r"],
  ecu:["wiring"],battery:["wiring"],climate:["wiring"],multimedia:["wiring"],
  door_l:["fender_l"],door_r:["fender_r"],wheel_l:["disc_front_l"],wheel_r:["disc_front_r"]
};

function dependencyIds(part){
  return PART_DEPENDENCIES[part?.assembly]||[];
}

function findDependencyParts(car,part){
  return dependencyIds(part).map(id=>car.sandbox.parts.find(p=>p.assembly===id)).filter(Boolean);
}

function dependencyStatus(car,part){
  const deps=findDependencyParts(car,part);
  return {
    total:deps.length,
    installed:deps.filter(p=>p.installed).length,
    blockedBy:deps.filter(p=>p.installed).map(p=>({id:p.id,assembly:p.assembly,name:p.name}))
  };
}

function canRemovePart(car,part){
  const dependents=car.sandbox.parts.filter(p=>p.installed&&dependencyIds(p).includes(part.assembly));
  if(dependents.length) return {
    ok:false,reason:"dependent_parts_installed",
    blockedBy:dependents.map(p=>({id:p.id,assembly:p.assembly,name:p.name}))
  };
  const fs=fastenerSummary(part);
  if(fs.missing) return {ok:false,reason:"missing_fasteners",missing:fs.missing};
  return {ok:true};
}

function canInstallPart(car,part){
  const deps=dependencyStatus(car,part);
  if(deps.blockedBy.length) return {ok:false,reason:"dependencies_missing",dependencies:deps.blockedBy};
  const fs=fastenerSummary(part);
  if(!fs.ready) return {ok:false,reason:"fasteners_not_ready",missing:fs.missing,damaged:fs.damaged};
  return {ok:true};
}

function hierarchyActionPartV2(car,action,partId){
  ensureHierarchy(car);
  const part=getPart(car,partId);
  if(!part) return {ok:false,reason:"part_missing"};
  if(action==="remove"){
    const check=canRemovePart(car,part);
    if(!check.ok) return check;
  }
  if(action==="install"){
    const check=canInstallPart(car,part);
    if(!check.ok) return check;
  }
  return baseActionPart(car,action,partId);
}

function dependencyGraph(car){
  ensureHierarchy(car);
  return car.sandbox.parts.map(p=>({
    id:p.id,assembly:p.assembly,name:p.name,
    dependencies:dependencyIds(p).map(id=>car.sandbox.parts.find(x=>x.assembly===id)).filter(Boolean).map(x=>x.id)
  }));
}

module.exports.actionPart=hierarchyActionPartV2;
module.exports.INSPECTION_LEVELS=INSPECTION_LEVELS;
module.exports.inspectCar=inspectCar;
module.exports.dependencyStatus=dependencyStatus;
module.exports.dependencyGraph=dependencyGraph;
module.exports.canRemovePart=canRemovePart;
module.exports.canInstallPart=canInstallPart;
module.exports.transferWarehousePart=transferWarehousePart;
module.exports.sellWarehousePart=sellWarehousePart;
module.exports.warehouseItem=warehouseItem;







/* V3 PART MARKET: 5 SOURCES -> OFFER -> WAREHOUSE */
const PART_SOURCES=[
  {id:"store",title:"Магазин",type:"new",conditionMin:98,conditionMax:100,priceMin:1.00,priceMax:1.18,reliability:1.00},
  {id:"dismantler",title:"Разборка",type:"used",conditionMin:45,conditionMax:94,priceMin:0.32,priceMax:0.68,reliability:0.96},
  {id:"private",title:"Частник",type:"mixed",conditionMin:35,conditionMax:100,priceMin:0.38,priceMax:0.92,reliability:0.92},
  {id:"donor",title:"Донор",type:"used",conditionMin:30,conditionMax:92,priceMin:0.24,priceMax:0.58,reliability:0.94},
  {id:"china",title:"Китай",type:"new",conditionMin:92,conditionMax:100,priceMin:0.28,priceMax:0.62,reliability:0.76}
];

function marketHash(text){
  let h=0;
  for(const ch of String(text||"")) h=((h<<5)-h+ch.charCodeAt(0))|0;
  return Math.abs(h);
}
function marketNumber(seed,index,min,max){
  const n=(marketHash(String(seed)+":"+index)%10000)/10000;
  return min+(max-min)*n;
}
function partMarketOfferFromTemplate(car,row,index,source,seed){
  const [system,assembly,name,wear,purchaseValue,reliability]=row;
  const sourceIndex=PART_SOURCES.findIndex(s=>s.id===source.id);
  const condition=Math.round(marketNumber(seed,index+sourceIndex*101,source.conditionMin,source.conditionMax));
  const priceFactor=marketNumber(seed,index+sourceIndex*211,source.priceMin,source.priceMax);
  const type=source.type==="mixed"
    ? (condition>=96?"new":"used")
    : source.type;
  const qualityFactor=type==="new"?1:0.82+condition/500;
  const price=money(purchaseValue*priceFactor*qualityFactor);
  const serial="MKT-"+String(marketHash(seed+":"+source.id+":"+index)).padStart(8,"0");
  return {
    id:"offer_"+String(marketHash(String(seed)+":"+source.id+":"+row[1])).padStart(10,"0")+"_"+String(index),
    source:source.id,
    sourceTitle:source.title,
    seller:source.id==="store"?"Официальный магазин":source.id==="dismantler"?"Авторазбор":source.id==="private"?"Частное объявление":source.id==="donor"?"Донорская площадка":"Китайский поставщик",
    partTemplateId:assembly,
    system,
    assembly,
    name,
    type,
    condition,
    price,
    reliability:Math.round(source.reliability*reliability*100)/100,
    serial,
    compatibility:{system,assembly,name},
    provenance:{
      marketSource:source.id,
      seller:source.title,
      listedAt:Date.now(),
      offerId:null
    }
  };
}

function ensurePartMarket(car,seed){
  if(!car?.sandbox) buildCar(car);
  if(car.sandbox.partMarket && Array.isArray(car.sandbox.partMarket.offers)) return car.sandbox.partMarket;
  return refreshPartMarket(car,seed);
}

function refreshPartMarket(car,seed=Date.now()){
  if(!car?.sandbox) buildCar(car);
  const actualSeed=String(seed);
  const offers=[];
  const wanted=car.sandbox.parts.slice(0,Math.min(12,car.sandbox.parts.length));
  for(const source of PART_SOURCES){
    wanted.forEach((rowPart,i)=>{
      const template=PART_TEMPLATES.find(r=>r[1]===rowPart.assembly)||PART_TEMPLATES[i%PART_TEMPLATES.length];
      if(!template) return;
      const offer=partMarketOfferFromTemplate(car,template,i,source,actualSeed);
      offer.provenance.offerId=offer.id;
      offers.push(offer);
    });
  }
  car.sandbox.partMarket={version:1,seed:actualSeed,refreshedAt:Date.now(),offers};
  return car.sandbox.partMarket;
}

function listPartMarket(car,filters={}){
  const market=ensurePartMarket(car,filters.seed);
  return market.offers.filter(o=>{
    if(filters.source && o.source!==filters.source) return false;
    if(filters.system && o.system!==filters.system) return false;
    if(filters.assembly && o.assembly!==filters.assembly) return false;
    if(filters.name && o.name!==filters.name) return false;
    if(filters.type && o.type!==filters.type) return false;
    if(Number.isFinite(Number(filters.maxPrice)) && o.price>Number(filters.maxPrice)) return false;
    if(Number.isFinite(Number(filters.minCondition)) && o.condition<Number(filters.minCondition)) return false;
    return true;
  });
}

function getPartMarketOffer(car,offerId){
  return ensurePartMarket(car).offers.find(o=>o.id===offerId)||null;
}

function buyPartMarketOffer(car,offerId,funds){
  if(!car?.sandbox) buildCar(car);
  const offer=getPartMarketOffer(car,offerId);
  if(!offer) return {ok:false,reason:"offer_missing"};
  const available=Number(funds);
  if(!Number.isFinite(available) || available<offer.price){
    return {ok:false,reason:"insufficient_funds",price:offer.price,available:Number.isFinite(available)?available:0};
  }
  if(!Array.isArray(car.sandbox.warehouse)) car.sandbox.warehouse=[];
  const item={
    id:"market_"+offer.id,
    system:offer.system,
    assembly:offer.assembly,
    name:offer.name,
    level:3,
    condition:offer.condition,
    wear:100-offer.condition,
    purchaseValue:offer.price,
    marketValue:offer.price,
    repairable:true,
    reliability:offer.reliability,
    installed:false,
    hiddenDamage:offer.type==="used" && offer.condition<65,
    serial:offer.serial,
    fasteners:[],
    history:[{
      time:Date.now(),
      action:"market_purchase",
      text:"Куплена на рынке деталей: "+offer.sourceTitle+" за "+offer.price+" ₽."
    }],
    modifications:[],
    warehouseStatus:"stored",
    provenance:{
      marketSource:offer.source,
      seller:offer.seller,
      offerId:offer.id,
      sourceSerial:offer.serial,
      purchasedAt:Date.now(),
      purchasePrice:offer.price,
      conditionAtPurchase:offer.condition
    }
  };
  item.node={id:item.assembly,level:2,title:ASSEMBLY_TITLES[item.assembly]||item.assembly,system:item.system};
  item.fasteners=Array.from({length:fastenerCountForPart(item)},(_,i)=>createFastener(item,i));
  item.fastenersRequired=item.fasteners.length;
  car.sandbox.warehouse.push(item);
  car.sandbox.partMarket.offers=car.sandbox.partMarket.offers.filter(o=>o.id!==offer.id);
  record(car,"market_purchase",item,"Куплена деталь «"+item.name+"» на рынке. Источник: "+offer.sourceTitle+".");
  return {ok:true,cost:offer.price,part:item,offer};
}

function partMarketSummary(car){
  const offers=ensurePartMarket(car).offers;
  const bySource={};
  for(const source of PART_SOURCES) bySource[source.id]=offers.filter(o=>o.source===source.id).length;
  return {total:offers.length,bySource};
}
module.exports.PART_SOURCES=PART_SOURCES;
module.exports.refreshPartMarket=refreshPartMarket;
module.exports.listPartMarket=listPartMarket;
module.exports.getPartMarketOffer=getPartMarketOffer;
module.exports.buyPartMarketOffer=buyPartMarketOffer;
module.exports.partMarketSummary=partMarketSummary;
