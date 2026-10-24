const fs=require('fs'),vm=require('vm'),path=require('path');
const root=path.join(__dirname,'..');
const load=['util.js','config.js','news.js','geo_gz.js','geo.js','data_gz.js','data_tutorial.js','maps.js','city.js','metro.js','sim.js','economy.js','macro.js','game.js','milestones.js'];
const ctx={console,Date,JSON,Math,Set,Map,Object,Array,String,Number,setTimeout,clearTimeout,requestAnimationFrame:()=>0,
document:{createElement:()=>({style:{},setAttribute(){},appendChild(){},addEventListener(){}})}};
ctx.window=ctx;ctx.globalThis=ctx;vm.createContext(ctx);
for(const f of load)try{vm.runInContext(fs.readFileSync(path.join(root,'js',f),'utf8'),ctx,{filename:f});}catch(e){console.log('skip',f,e.message);}
const CM=ctx.CM,M=CM.Metro;
const g=CM.Game.create({name:'t',mode:'normal',seed:1});
g.econ.funds=1e9; if('capex' in g.econ) g.econ.capex=1e9;
g.city.regionOpen=g.city.regionOpen.map(()=>true);
const A=g.planNew('station'); A.name='new station';
const ids=[];
for(let i=0;i<10;i++) g.edit(function(net){ids.push(M.addStation(net,20+i*6,50,{size:'M',type:'underground'},g.city));},{tag:g.planActive,own:true});
const B=g.planNew('line'); B.name='new line';
const seven=ids.slice(0,7);
g.edit(function(net){
  const lid=M.newLine(net);
  for(let i=0;i+1<seven.length;i++) M.addSegment(net,lid,seven[i],seven[i+1],[],'underground');
  return {line:lid};
},{tag:g.planActive,own:true});
console.log('A cover',Object.keys(g.planOverlay(A.id).stations).length,'B cover segs',Object.keys(g.planOverlay(B.id).segs).length);
const canB=g.confirmDraft(B.id);
console.log('confirm B:',JSON.stringify({ok:canB.ok,error:canB.error&&canB.error.slice(0,60)}));
console.log('after: official stations=',Object.keys(g.net.stations).length,'lines=',Object.keys(g.net.lines).length);
const ovA=g.planOverlay(A.id);
console.log('A now owns',Object.keys(ovA.stations).length,'stations ->',Object.keys(ovA.stations).map(k=>g.draft.net.stations[k].name).join(','));
console.log('plans left',g.plans.map(p=>p.name), 'draft?',!!g.draft);
const ovA2=g.planOverlay(A.id);
const own=Object.keys(ovA2.stations);
console.log('A still owns',own.length,'->',own.map(k=>k+(g.net.stations[k]?'(已建成!)':'')).join(','));
console.log('A total',Math.round(ovA2.val.total),'items',ovA2.val.items.length,'conflicts',ovA2.val.conflicts.length);
console.log('draft stations left',Object.keys(g.draft.net.stations).length,'segs',Object.keys(g.draft.net.segments).length);
console.log('official stations',Object.keys(g.net.stations).map(k=>g.net.stations[k].name).join(','));
const oA=g.planOverlay(A.id);
console.log('A items:',oA.val.items.map(i=>i.kind+':'+i.label+'='+Math.round(i.amount)).join(' | '));
console.log('A total',Math.round(oA.val.total));
