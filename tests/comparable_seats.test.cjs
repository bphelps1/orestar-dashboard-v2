const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function harness(){const c=vm.createContext({window:{},document:{addEventListener(){}},console:{log(){}},setTimeout,clearTimeout});vm.runInContext(fs.readFileSync(path.join(__dirname,'../docs/recommend.js'),'utf8'),c);return c;}
const unopposed={band:'unopposed',margin_pts:100,year:2024,label:'unopposed last cycle'};
test('unopposed is categorical and never participates in numeric margin windows',()=>{
 const c=harness(),gifts=[1,2,3].map(i=>({filer:`U${i}`,seatBand:'unopposed',marginPts:100,amount:1000}));
 gifts.push(...[1,2,3].map(i=>({filer:`C${i}`,seatBand:'safe',marginPts:96,amount:500})));
 assert.equal(c.peerMarginGifts(gifts,unopposed).kind,'unopposed');
 assert.equal(c.peerMarginGifts(gifts,unopposed).gifts.length,3);
 assert.ok(c.peerMarginGifts(gifts,{band:'safe',margin_pts:96}).gifts.every(g=>g.filer.startsWith('C')));
 assert.equal(c.peerMarginGifts(gifts.slice(1,3),unopposed),null);
 assert.match(c.peerGiftLabel(gifts[0]),/unopposed/);assert.doesNotMatch(c.peerGiftLabel(gifts[0]),/100/);
});
test('comparison pool excludes stale, unknown, future, closed and noncandidate committees',async()=>{
 const c=harness();vm.runInContext(`raceMarginIndex=new Map();adminTags={};`,c);
 const candidate={name:'Candidate',slug:'target',committee_type:'Candidate Committee',office:'State Representative',party:'Democrat',total_in:1000,election:'2026 Primary Election'};
 c.target=candidate;c.filers=[{...candidate,slug:'recent',election:'2024 General Election'}, {...candidate,slug:'old',election:'2014 General Election'}, {...candidate,slug:'missing',election:''}, {...candidate,slug:'future',election:'2028 Primary Election'}, {...candidate,slug:'closed',closed:true}, {...candidate,slug:'pac',committee_type:'Political Committee'}, {...candidate,slug:'senator',office:'State Senator',election:'2022 General Election'}, {...candidate,slug:'old-senator',office:'State Senator',election:'2020 General Election'}];
 const r=await vm.runInContext('filerIndex=filers;findComparables({},target,2026)',c);
 assert.deepEqual(Array.from(r,x=>x.slug).sort(),['recent','senator']);
});
test('seat summary and spreadsheet describe unopposed peers without a synthetic margin',()=>{
 const c=harness(),comps=[1,2,3].map(i=>({name:`Peer${i}`,seat:unopposed}));
 const ctx=c.seatPeerContext(comps,comps.map(()=>({timeline:[{month:'2026-01',contributions:2000}]})),2026,unopposed,{});
 assert.equal(ctx.kind,'unopposed');assert.equal(ctx.median,2000);
 assert.match(c.seatBenchmarkCard(unopposed,ctx,1000),/Unopposed-seat peers/);
 assert.doesNotMatch(c.seatBenchmarkCard(unopposed,ctx,1000),/100\.0|null pts/);
 c.window._targetSeat=unopposed;c.window._seatContext=ctx;c.window._targetProfile={name:'Target'};
 const rows=c.methodSheetRows([],2026);assert.match(JSON.stringify(rows),/Unopposed-seat peers/);assert.doesNotMatch(JSON.stringify(rows),/100\.0 pt|null pts/);
});
