const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function harness(){const c=vm.createContext({window:{},document:{addEventListener(){},getElementById:()=>({value:'',checked:true})},console,setTimeout,clearTimeout});vm.runInContext(fs.readFileSync(path.join(__dirname,'../docs/lib/lobbyists.js'),'utf8'),c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../docs/recommend.js'),'utf8'),c);return c;}
const filer={name:'Test Member',slug:'test',filer_id:'2',office:'State Representative'};
const flag={slug:'test',filer_ids:['2'],year:2024,start:'2023-01-01',through:'2024-05-21',resume:'2024-05-22'};
const gift=total=>({donor_id:'a',name:'Acme PAC',total});
function flags(c,rows=[flag]){c.flags=rows;vm.runInContext('primaryCampaigns=flags',c);}
test('recurring contested primary removes only its window and preserves ordinary earlier cycles and actual credits',async()=>{
 const c=harness();flags(c);const p={top_donors_by_year:{2022:[gift(500)],2023:[gift(10000)],2024:[gift(40000)],2026:[gift(750)]}};
 c.DL={getDonors:async q=>{assert.equal(q.start,'2024-05-22');assert.equal(q.end,'2024-12-31');return {by_year:{2024:[gift(1000)]}}}};
 await c.loadIncumbentBaselines([p],[filer],2026);
 assert.equal(c.askDonorsByYear(p)[2022][0].total,500);assert.equal(c.askDonorsByYear(p)[2023],undefined);assert.equal(c.askDonorsByYear(p)[2024][0].total,1000);
 assert.equal(c.completedHistoryCycles(p,2026),1);
 const row=c.buildRepeatDonorTargets(p,[],[],[],2026,null).targets[0];
 assert.equal(row.last_cycle_amt,50000);assert.equal(row.baseline_cycle_amt,1000);assert.equal(row.target,1250);assert.equal(row.remaining,500);
 // Giving inside the flagged primary window does not set the floor either.
 assert.equal(row.last_cycle_eligible,1000);
 assert.match(row.factors.join(' '),/unusually large contested primary/);
 await c.loadIncumbentBaselines([p],[filer],2022);assert.equal(p._askDonorsByYear,undefined);
});
test('candidate and comparable paths share the same filtered history, including first-gift proxy and prospect asks',async()=>{
 const c=harness();flags(c);const p={top_donors_by_year:{2023:[gift(50000)],2024:[gift(10000)]}};
 c.DL={getDonors:async()=>({by_year:{2024:[gift(1000)]}})};
 await c.loadIncumbentBaselines([p],[filer],2026);
 const comp={...filer,comparisonKind:'leadership-primary'};
 assert.equal(c.firstGivingBenchmark('a',[p],[comp],2026,null).amount,1000);
 const row=c.buildRepeatDonorTargets({top_donors_by_year:{2024:[gift(500)]}},[comp],[p],[],2026,null).targets[0];assert.equal(row.comp_max,1000);
 const prospect=c.scoreDonors({top_donors_by_year:{}},[comp],[p],['2024'],2026,null).prospects[0];assert.equal(prospect.target_ask,500);
 assert.equal(c.buildCompCycleIndex([comp],[p]).get('a').get(comp.name)[2024],60000);
});
test('exact first gifts honor both inclusive exclusion boundaries, keep earlier normal and next-day gifts',async()=>{
 const c=harness();const dates=['2022-12-31','2023-01-01','2024-05-21','2024-05-22'];
 const p={_primaryExclusions:[flag],top_donors_by_year:{2026:dates.map((_,i)=>({...gift(2000),donor_id:String(i)}))}};
 const comp={...filer,comparisonKind:'leadership-primary'};
 c.getSupabase=async()=>({rpc:()=>dates.map((d,i)=>({donor_id:String(i),filer_id:'2',first_date:d,amount:1000}))});vm.runInContext('LOB.fetchAll=async build=>build()',c);
 await c.loadFirstGifts([{top_donors_by_year:{}},p],[comp],[p],2026);
 assert.deepEqual([...c.window._firstGifts.keys()],['0','3']);
});
test('lobbyist floor excludes exceptional primary even without an entry-primary cutoff',async()=>{
 const c=harness();flags(c);const p={top_donors_by_year:{2024:[gift(50000)]}};c.DL={getDonors:async()=>({by_year:{2024:[gift(1000)]}})};
 await c.loadIncumbentBaselines([p],[filer],2026);c.window._targetProfile=p;c.window._cycle=2026;c.window._repeatTargets=[];c.window._recommendations=[];
 vm.runInContext(`lobbyistsById=new Map([[1,{lobbyist_id:1,name:'Contact',kind:'person'}]]);window._lobbyAttr=new Map([['a',[{lobbyist:lobbyistsById.get(1),is_primary:true}]]]);`,c);
 const g=c.planGroups()[0];assert.equal(g.last_cycle,50000);assert.equal(g.target,1000);assert.match(g.target_reason,/unusually large contested primary/);
});
test('entry and exceptional primary overlap queries once; errors fail closed',async()=>{
 const c=harness();flags(c);c.firstLegislativeBaseline=()=>({year:2024,primaryDate:'2024-05-21',start:'2024-05-22'});let calls=0;
 c.DL={getDonors:async()=>{calls++;return {by_year:{2024:[]}}}};
 await c.loadIncumbentBaselines([{top_donors_by_year:{2022:[gift(500)]}}],[filer],2026);assert.equal(calls,1);
 c.DL.getDonors=async()=>{throw Error('failed dated query')};await assert.rejects(c.loadIncumbentBaselines([{}],[filer],2026),/failed dated query/);
});
test('flagged cycle cannot establish outlier status but earlier normal cycle can',()=>{
 const c=harness();flags(c);const peers=Array.from({length:8},(_,i)=>({...filer,slug:'peer'+i,filer_id:String(i+10)}));const filers=[filer,...peers];
 const rows=filers.map((f,i)=>({slug:f.slug,timeline:[{month:'2024-03',contributions:i?10000+i*1000:9999999}]}));
 assert.equal(c.fundraisingOutliers(filers,rows,2026).has('test'),false);
 rows[0].timeline.push({month:'2022-09',contributions:100000});assert.equal(c.fundraisingOutliers(filers,rows,2026).has('test'),true);
});
test('exclusion asset failure stops recommendation inputs instead of silently using inflated history',async()=>{
 const c=harness();c.fetch=async()=>({ok:false});await assert.rejects(c.loadPrimaryCampaigns(),/Could not verify/);
 c.fetch=async()=>({ok:true,json:async()=>({version:1,exclusions:[{}]})});await assert.rejects(c.loadPrimaryCampaigns(),/invalid/);
});
test('a primary-only latest cycle falls back to earlier normal donor history',async()=>{
 const c=harness();flags(c);const p={top_donors_by_year:{2022:[gift(2000)],2024:[gift(50000)]}};
 c.DL={getDonors:async()=>({by_year:{2024:[]}})};await c.loadIncumbentBaselines([p],[filer],2026);
 const row=c.buildRepeatDonorTargets(p,[],[],[],2026,null).targets[0];
 assert.equal(row.last_cycle_amt,50000);assert.equal(row.baseline_cycle_amt,2000);assert.equal(row.baseline_cycle,2022);assert.equal(row.target,2000);
});
test('reviewed snapshot catches all three 2026 examples without flagging Fahey as opposed',()=>{
 const data=JSON.parse(fs.readFileSync(path.join(__dirname,'../docs/assets/primary_campaign_exclusions.json')));
 for(const id of ['16812','17890','19463'])assert.ok(data.exclusions.some(p=>p.year===2026&&p.filer_ids.includes(id)));
 assert.ok(!data.exclusions.some(p=>p.filer_ids.includes('17469')));
});
