const startedAt=Date.now();
const counters=new Map();
const timings=new Map();

function inc(name,value=1){
  const key=String(name);
  counters.set(key,(counters.get(key)||0)+Number(value||0));
}
function observe(name,ms){
  const key=String(name);
  const n=(timings.get(key)||{count:0,total:0,max:0});
  const value=Math.max(0,Number(ms)||0);
  n.count++; n.total+=value; n.max=Math.max(n.max,value);
  timings.set(key,n);
}
function snapshot(){
  const timing={};
  for(const [k,v] of timings) timing[k]={
    count:v.count,
    avg_ms:v.count?Math.round(v.total/v.count):0,
    max_ms:v.max
  };
  return {
    uptime_ms:Date.now()-startedAt,
    counters:Object.fromEntries(counters),
    timings:timing
  };
}
function timed(name,fn){
  const t=Date.now();
  try{
    const result=fn();
    if(result && typeof result.then==="function"){
      return result.finally(()=>observe(name,Date.now()-t));
    }
    observe(name,Date.now()-t);
    return result;
  }catch(e){
    observe(name,Date.now()-t);
    throw e;
  }
}
module.exports={inc,observe,snapshot,timed};
