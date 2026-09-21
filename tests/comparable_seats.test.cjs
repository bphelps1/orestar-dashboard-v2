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

function candidate(slug,extra={}){return {slug,name:slug,committee_type:'Candidate Committee',office:'State Representative',party:'Democrat',total_in:1000,election:'2026 Primary Election',...extra};}
test('Speaker and House Majority Leader only compare to each other in both directions',async()=>{
 const c=harness();c.filers=[candidate('speaker',{leadership_role:'Speaker of the House',leadership_tier:1}),candidate('majority',{leadership_role:'House Majority Leader',leadership_tier:2}),candidate('member'),candidate('assistant',{leadership_role:'House Assistant Majority Leader'}),candidate('protem',{leadership_role:'House Speaker Pro Tem'}),candidate('senator',{office:'State Senator',leadership_role:'Senate Majority Leader'})];
 vm.runInContext('filerIndex=filers;raceMarginIndex=new Map();adminTags={}',c);
 for(const slug of ['member','assistant','protem','senator']){
  const result=await c.findComparables({},c.filers.find(f=>f.slug===slug),2026);
  assert.ok(result.every(f=>!['speaker','majority'].includes(f.slug)));
 }
 let result=await c.findComparables({},c.filers[0],2026);assert.deepEqual(Array.from(result,f=>f.slug),['majority']);assert.equal(result[0].benchmarkFactor,1);
 result=await c.findComparables({},c.filers[1],2026);assert.deepEqual(Array.from(result,f=>f.slug),['speaker']);assert.equal(result[0].benchmarkFactor,0.9);
});
test('live role metadata overrides stale cached leadership and excludes assistants',()=>{
 const c=harness();vm.runInContext(`leadershipRoles={leader:{filer_name:'Example Person',role_title:'House Majority Leader'}}`,c);
 assert.equal(c.houseTopRole(candidate('current',{name:'Friends of Example Person'})),'majority-leader');
 assert.equal(c.houseTopRole(candidate('assistant',{leadership_role:'House Assistant Majority Leader'})),null);
 assert.equal(c.houseTopRole(candidate('whip',{leadership_role:'House Majority Whip'})),null);
});
test('strict seat eligibility prevents fallback from bringing a competitive seat into an unopposed pool',async()=>{
 const c=harness();c.filers=[candidate('target',{office_district:'State Representative, 54th District'}),candidate('wise',{office_district:'State Representative, 48th District'}),candidate('peer',{office_district:'State Representative, 38th District'}),candidate('unknown')];
 vm.runInContext(`filerIndex=filers;adminTags={};raceMarginIndex=new Map([
 ['State Representative|54th District',{band:'unopposed',margin_pts:100}],
 ['State Representative|48th District',{band:'competitive',margin_pts:6.16}],
 ['State Representative|38th District',{band:'unopposed',margin_pts:100}]]);`,c);
 const r=await c.findComparables({},c.filers[0],2026);assert.deepEqual(Array.from(r,f=>f.slug),['peer']);
 assert.equal(c.compatibleSeat({band:'safe',margin_pts:28.93},{band:'competitive',margin_pts:6.16}),false);
 assert.equal(c.compatibleSeat({band:'safe',margin_pts:28.93},{band:'lean',margin_pts:10}),true);
});
test('eligible comparison pool is capped at twenty',async()=>{
 const c=harness(),target=candidate('target');c.filers=Array.from({length:40},(_,i)=>candidate('peer'+i));
 vm.runInContext('filerIndex=filers;raceMarginIndex=new Map();adminTags={}',c);
 assert.equal((await c.findComparables({},target,2026)).length,20);
});
test('exclusive pair supports single-counterpart prospects and discounts benchmark, not reported gifts',()=>{
 const c=harness();
 const comps=[candidate('speaker',{comparisonKind:'house-leadership',benchmarkFactor:0.9,leadership_tier:1})];
 const profiles=[{top_donors_by_year:{2024:[{donor_id:'a',name:'Acme',total:10000}],2026:[{donor_id:'a',name:'Acme',total:10000}]}}];
 const target={top_donors_by_year:{}};
 const result=c.scoreDonors(target,comps,profiles,['2025','2026'],2026,null).prospects;
 assert.equal(result.length,1);assert.equal(result[0].target_ask,4500);assert.equal(result[0].comp_max,10000);assert.equal(result[0].comp_gifts[0].amount,10000);
 assert.ok(result[0].factors.some(f=>f.includes('10% below')));
 const repeat=c.buildRepeatDonorTargets({top_donors_by_year:{2024:[{donor_id:'a',name:'Acme',total:5000}]}},comps,profiles,['2025','2026'],2026,null).targets[0];
 assert.equal(repeat.target,6500);assert.equal(repeat.comp_max,10000);assert.equal(repeat.last_cycle_amt,5000);
});
