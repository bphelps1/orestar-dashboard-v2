const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function harness(){const c=vm.createContext({window:{},document:{addEventListener(){}},console:{log(){}},setTimeout,clearTimeout});vm.runInContext(fs.readFileSync(path.join(__dirname,'../docs/recommend.js'),'utf8'),c);vm.runInContext('currentLegislators={};committeeChairs=[];loadCurrentLegislators=async()=>{};isCurrentLegislator=()=>true;loadFundraisingOutliers=async()=>new Map();raceMarginIndex=new Map();adminTags={}',c);return c;}
function filer(name,extra={}){return {name,candidate_name:name,slug:name,office:'State Representative',party:'Democrat',committee_type:'Candidate Committee',election:'2026 General',total_in:1000,...extra};}
const gift=total=>({donor_id:'a',name:'Acme PAC',total});
test('other leaders and verified chairs compare within chamber, excluding senior leaders, rank-and-file and vice chairs',async()=>{
 const c=harness();c.filers=[filer('Floor Manager',{leadership_role:'House Majority Floor Manager'}),filer('Jane Chair'),filer('Assistant',{leadership_role:'House Assistant Majority Leader'}),filer('Other Member'),filer('Speaker',{leadership_role:'Speaker of the House'}),filer('Senate Chair',{office:'State Senator'}),filer('Vice',{leadership_role:'Education Committee Vice-Chair'})];
 vm.runInContext('filerIndex=filers;committeeChairs=[{name:"Jane Chair",chamber:"house",committees:["Education"]},{name:"Senate Chair",chamber:"senate",committees:["Education"]}]',c);
 const peers=await c.findComparables({},c.filers[0],2026);
 assert.deepEqual(Array.from(peers,x=>x.name).sort(),['Assistant','Jane Chair']);
 assert.ok(peers.every(x=>x.comparisonKind==='leadership-chair'&&x.leadership_tier===3));
 assert.equal(c.otherLeadershipOrChair(c.filers[6]),false);
 const ordinary=await c.findComparables({},c.filers[3],2026);assert.ok(ordinary.every(x=>!['Floor Manager','Jane Chair','Assistant','Speaker'].includes(x.name)));
});
test('current Ways and Means full committee co-chairs remain in senior pool, not subcommittee chairs',()=>{
 const c=harness();vm.runInContext('committeeChairs=[{name:"Jane Chair",chamber:"house",committees:["Ways and Means"]},{name:"Other Chair",chamber:"house",committees:["Ways and Means Subcommittee On Education"]}]',c);
 assert.equal(c.primaryLeadershipRole(filer('Jane Chair')),'ways-means');assert.equal(c.otherLeadershipOrChair(filer('Jane Chair')),false);
 assert.equal(c.primaryLeadershipRole(filer('Other Chair')),null);assert.equal(c.otherLeadershipOrChair(filer('Other Chair')),true);
});
test('history weights count complete eligible cycles, not primary or current cycles',()=>{
 const c=harness(),p={top_donors_by_year:{2022:[gift(100000)],2024:[gift(1000)],2026:[gift(100)]},_entryBaseline:{year:2024},_askDonorsByYear:{2024:[gift(1000)],2026:[gift(100)]}};
 assert.equal(c.limitedHistoryWeight(p,2026),0.75);assert.equal(c.limitedHistoryWeight(p,2028),0.60);
 p._askDonorsByYear[2028]=[gift(10)];assert.equal(c.limitedHistoryWeight(p,2030),null);
 assert.equal(c.limitedHistoryWeight({...p,_recommendationOffice:'governor'},2026),null);
});
test('limited-history repeat targets move toward peer giving in either direction and preserve actual history',()=>{
 const c=harness(),comps=[filer('Peer')],profiles=[{top_donors_by_year:{2024:[gift(10000)]}}];
 function calculate(amount,entry){const p={top_donors_by_year:{2024:[gift(amount)]},...(entry?{_entryBaseline:{year:2024,primaryDate:'2024-05-21'},_askDonorsByYear:{2024:[gift(amount)]}}:{})};return c.buildRepeatDonorTargets(p,comps,profiles,[],2026,null).targets[0];}
 const zero=calculate(1000,true);assert.equal(zero.target,7750);assert.equal(zero.comparable_weight,0.75);assert.equal(zero.last_cycle_amt,1000);
 const one=calculate(1000,false);assert.equal(one.target,6500);assert.equal(one.comparable_weight,0.60);
 const high=calculate(20000,true);assert.equal(high.target,10000);assert.equal(high.last_cycle_amt,20000);
});
test('two completed cycles retain history-led weighting; absence of a peer does not invent an ask',()=>{
 const c=harness(),p={top_donors_by_year:{2022:[gift(1000)],2024:[gift(1000)]}};
 const row=c.buildRepeatDonorTargets(p,[filer('Peer')],[{top_donors_by_year:{2024:[gift(10000)]}}],[],2026,null).targets[0];
 assert.equal(row.history_cycles,2);assert.equal(row.comparable_weight,0.10);assert.equal(row.target,2000);
 const limited={top_donors_by_year:{2024:[gift(1000)],2026:[gift(100)]}};
 const own=c.buildRepeatDonorTargets(limited,[],[],[],2026,null).targets[0];assert.equal(own.target,1000);assert.equal(own.comparable_weight,0);
});
test('limited-history reference uses the median of latest funded prior cycles, excluding lifetime and current peaks',()=>{
 const c=harness(),p={top_donors_by_year:{2024:[gift(1000)]},_entryBaseline:{year:2024}};
 const comps=['A','B','C'].map(n=>filer(n));
 const profiles=[{top_donors_by_year:{2020:[gift(999999)],2022:[gift(25000)],2024:[gift(1000)],2026:[gift(888888)],2028:[gift(777777)]}},
  {top_donors_by_year:{2022:[gift(2000)]}},{top_donors_by_year:{2024:[gift(20000)]}}];
 const row=c.buildRepeatDonorTargets(p,comps,profiles,[],2026,null).targets[0];
 assert.equal(row.peer_benchmark,2000);assert.equal(row.target,1750);assert.equal(row.comp_max,2000);
 assert.deepEqual(Array.from(row.comp_max_filers),['B']);
 assert.equal(row.comp_gifts.find(g=>g.filer==='A').amount,1000);
 assert.equal(row.comp_gifts.find(g=>g.filer==='B').referenceCycle,2022);
 assert.match(row.factors.join(' '),/latest funded eligible cycle in 2021–2024/);
});
test('no recent peer evidence does not substitute current-cycle giving or erase own eligible history',()=>{
 const c=harness(),p={top_donors_by_year:{2024:[gift(1000)]}};
 const row=c.buildRepeatDonorTargets(p,[filer('Peer')],[{top_donors_by_year:{2020:[gift(100000)],2026:[gift(100000)]}}],[],2026,null).targets[0];
 assert.equal(row.target,1000);assert.equal(row.peer_benchmark,0);assert.equal(row.comparable_weight,0);
});
test('Excel donor asks match the reduced calculation and preserve actual contribution history',()=>{
 const c=harness();c.document.getElementById=()=>({value:'',checked:true});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../docs/lib/lobbyists.js'),'utf8'),c);
 const p={name:'New Incumbent',top_donors_by_year:{2024:[gift(20000)]},_entryBaseline:{year:2024},_askDonorsByYear:{2024:[gift(1000)]}};
 const comps=['A','B','C'].map(n=>filer(n)),profiles=[1000,2000,20000].map(n=>({top_donors_by_year:{2024:[gift(n)]}}));
 const targets=c.buildRepeatDonorTargets(p,comps,profiles,[],2026,null).targets;
 c.window._targetProfile=p;c.window._cycle=2026;c.window._repeatTargets=targets;c.window._recommendations=[];
 c.window._compCycles=c.buildCompCycleIndex(comps,profiles);
 vm.runInContext(`lobbyistsById=new Map([[1,{lobbyist_id:1,name:'Contact',kind:'person'}]]);window._lobbyAttr=new Map([['a',[{lobbyist:lobbyistsById.get(1),is_primary:true}]]]);`,c);
 const groups=c.planGroups();assert.equal(groups[0].target,1750);assert.equal(groups[0].last_cycle,20000);
 const sheet=c.planSheetAoa(groups,2026),row=sheet.rows[sheet.roles.indexOf('donor')];
 assert.equal(row[9],1750);assert.equal(row[12],20000); // Ask and prior-cycle actual.
 assert.equal(sheet.rows[sheet.roles.indexOf('total')][9],1750);
});
