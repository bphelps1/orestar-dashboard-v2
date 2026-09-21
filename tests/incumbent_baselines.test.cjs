const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function harness(){const c=vm.createContext({window:{},document:{addEventListener(){},getElementById:()=>({value:'',checked:true})},console,setTimeout,clearTimeout});vm.runInContext(fs.readFileSync(path.join(__dirname,'../docs/lib/lobbyists.js'),'utf8'),c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../docs/recommend.js'),'utf8'),c);return c;}
const filer={name:'Friends of Lisa Fragala',candidate_name:'Lisa Fragala',office:'State Representative',filer_id:'19751'};
const wins=[{year:2012,office_normalized:'State Representative',district:'8th District',candidate:'Holvey Paul R'}, {year:2022,office_normalized:'State Representative',district:'8th District',candidate:'Holvey Paul R'},{year:2024,office_normalized:'State Representative',district:'8th District',candidate:'Fragala Lisa'}];
function history(c,rows=wins){c.wins=rows;vm.runInContext('legislativeWinners=wins',c);}
const gift=(total)=>({donor_id:'a',name:'Acme PAC',total});
test('Fragala gets verified 2024 post-primary cutoff, not a deduction from missing older data',()=>{
 const c=harness();history(c);assert.equal(c.firstLegislativeBaseline(filer,2026).start,'2024-05-22');assert.equal(c.firstLegislativeBaseline(filer,2024),null);
 assert.equal(c.firstLegislativeBaseline({name:'Paul Holvey',office:'State Representative'},2026),null);
 assert.equal(c.firstLegislativeBaseline({...filer,candidate_name:'Unknown Person',name:'Unknown Person'},2026),null);
});
test('House-to-Senate move keeps first House election cutoff rather than treating Senate primary as entry',()=>{
 const c=harness();history(c,[...wins,{year:2016,office_normalized:'State Representative',district:'8th District',candidate:'Example Jane'}, {year:2020,office_normalized:'State Senator',district:'1st District',candidate:'Jane Example'}]);
 const entry=c.firstLegislativeBaseline({name:'Jane Example',office:'State Senator'},2026);assert.equal(entry.year,2016);assert.equal(entry.start,'2016-05-18');
});
test('dated baseline loading preserves full historical totals and removes entry-primary money only from asks',async()=>{
 const c=harness();history(c);const profile={top_donors_by_year:{2023:[gift(10000)],2024:[gift(15000)],2026:[gift(500)]}};
 c.DL={getDonors:async p=>{assert.equal(p.start,'2024-05-22');assert.equal(p.end,'2024-12-31');return {by_year:{2024:[gift(1000)]}};}};
 await c.loadIncumbentBaselines([profile],[filer],2026);
 assert.equal(profile.top_donors_by_year[2024][0].total,15000);assert.equal(c.askDonorsByYear(profile)[2023],undefined);assert.equal(c.askDonorsByYear(profile)[2024][0].total,1000);
 const target=c.buildRepeatDonorTargets(profile,[],[],[],2026,null).targets[0];assert.equal(target.last_cycle_amt,25000);assert.equal(target.baseline_cycle_amt,1000);assert.equal(target.target,1000);assert.equal(target.remaining,500);
 assert.match(target.factors.join(' '),/2024-05-21/);
 await c.loadIncumbentBaselines([profile],[filer],2024);assert.equal(profile._entryBaseline,undefined);assert.equal(c.askDonorsByYear(profile)[2024][0].total,15000);
});
test('comparable max and annual first-gift proxy cannot reintroduce primary-only amounts',()=>{
 const c=harness();const comp={name:'Peer',slug:'peer',comparisonKind:'leadership-primary'};
 const profile={top_donors_by_year:{2024:[gift(50000)]},_askDonorsByYear:{2024:[gift(1000)]},_entryBaseline:{start:'2024-05-22'}};
 assert.equal(c.firstGivingBenchmark('a',[profile],[comp],2026,null).amount,1000);
 const target={top_donors_by_year:{2024:[gift(500)],2026:[gift(100)]}};
 assert.equal(c.buildRepeatDonorTargets(target,[comp],[profile],[],2026,null).targets[0].comp_max,1000);
 const prospect=c.scoreDonors({top_donors_by_year:{}},[comp],[profile],['2024'],2026,null).prospects[0];assert.equal(prospect.target_ask,500);
});
test('lobbyist minimum uses adjusted baseline while Last Cycle remains full actual giving',()=>{
 const c=harness();c.window._targetProfile={top_donors_by_year:{2024:[gift(25000)]},_askDonorsByYear:{2024:[gift(1000)]},_entryBaseline:{primaryDate:'2024-05-21'}};
 c.window._cycle=2026;c.window._repeatTargets=[];c.window._recommendations=[];
 vm.runInContext(`lobbyistsById=new Map([[1,{lobbyist_id:1,name:'Contact',kind:'person'}]]);window._lobbyAttr=new Map([['a',[{lobbyist:lobbyistsById.get(1),is_primary:true}]]]);`,c);
 const group=c.planGroups()[0];assert.equal(group.last_cycle,25000);assert.equal(group.baseline_last_cycle,1000);assert.equal(group.target,1000);assert.match(group.target_reason,/excluded/);
});
test('exact first-gift lookup discards primary-period gifts without calling later gifts first',async()=>{
 const c=harness();const comp={name:'Peer',slug:'peer',filer_id:'2',comparisonKind:'leadership-primary'};
 const profile={_entryBaseline:{start:'2024-05-22'},top_donors_by_year:{2026:[gift(2000),{donor_id:'b',name:'Other PAC',total:2000}]}};
 c.getSupabase=async()=>({rpc:()=>[{donor_id:'a',filer_id:'2',first_date:'2024-05-21',amount:10000},{donor_id:'b',filer_id:'2',first_date:'2024-05-22',amount:1000}]});
 vm.runInContext('LOB.fetchAll=async build=>build()',c);
 await c.loadFirstGifts([{top_donors_by_year:{}},profile],[comp],[profile],2026);
 assert.equal(c.window._firstGifts.has('a'),false);assert.equal(c.window._firstGifts.get('b')[0].amount,1000);
});
test('failure to load a verified dated baseline stops calculation rather than restoring full-cycle amounts',async()=>{
 const c=harness();history(c);c.DL={getDonors:async()=>{throw Error('lookup failed')}};
 await assert.rejects(c.loadIncumbentBaselines([{top_donors_by_year:{2024:[gift(20000)]}}],[filer],2026),/lookup failed/);
});
test('entry-cycle primary receipts do not establish automatic outlier status',()=>{
 const c=harness();history(c);const filers=[{...filer,slug:'fragala'},...Array.from({length:8},(_,i)=>({slug:'peer'+i,name:'Other'+i,office:'State Representative'}))];
 const rows=filers.map((f,i)=>({slug:f.slug,timeline:[{month:'2024-03',contributions:i?10000+i*1000:9999999}]}));
 assert.equal(c.fundraisingOutliers(filers,rows,2026).has('fragala'),false);
});
test('primary-only repeat donor gets history-weighted peer ask instead of their large entry-primary gift',()=>{
 const c=harness();const target={top_donors_by_year:{2024:[gift(50000)]},_askDonorsByYear:{2024:[]},_entryBaseline:{primaryDate:'2024-05-21'}};
 const comp={name:'Peer',slug:'peer'},profile={top_donors_by_year:{2024:[gift(10000)]}};
 const row=c.buildRepeatDonorTargets(target,[comp],[profile],[],2026,null).targets[0];
 assert.equal(row.last_cycle_amt,50000);assert.equal(row.baseline_cycle_amt,0);assert.equal(row.target,7500);
 assert.ok(row.factors.some(f=>f.includes('75% comparable benchmark')));
});
