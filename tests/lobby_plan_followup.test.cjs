'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
function harness(){
 const els=new Map(); const get=id=>{if(!els.has(id))els.set(id,{value:'',checked:true,innerHTML:'',querySelectorAll:()=>[]});return els.get(id)};
 const c=vm.createContext({window:{},document:{addEventListener(){},getElementById:get,querySelectorAll:()=>[]},console,setTimeout,clearTimeout});
 for(const f of ['docs/lib/donor-names.js','docs/lib/lobbyists.js','docs/recommend.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),c);
 return {c,get};
}
test('same-name organizations combine before asks/history; same-name people stay separate',async()=>{
 const {c}=harness();
 vm.runInContext(`LOB.fetchIn=async()=>[
 {donor_id:'a',display_name:'State   Farm Federal PAC',book_type:'Political Committee'},
 {donor_id:'b',display_name:'State Farm Federal PAC',book_type:'Political Committee'},
 {donor_id:'p1',display_name:'Sam Jones',book_type:'Individual'},
 {donor_id:'p2',display_name:'Sam Jones',book_type:'Individual'}];`,c);
 const profile={top_donors_by_year:{2024:[{donor_id:'a',name:'State   Farm Federal PAC',total:1000},{donor_id:'b',name:'State Farm Federal PAC',total:2000},{donor_id:'p1',name:'Sam Jones',total:20},{donor_id:'p2',name:'Sam Jones',total:30}]}};
 profile.top_donors_by_year[2022]=[{donor_id:'a',name:'State Farm Federal PAC',total:500}];
 await c.loadPlanningKeys([profile]);
 const rows=c.mergeDonorsByYear(profile.top_donors_by_year,['2024']);
 assert.equal(rows.length,3); assert.equal(rows[0].total,3000);
 const result=c.buildRepeatDonorTargets(profile,[],[],['2025','2026'],2026,null);
 assert.equal(result.targets.filter(r=>r.donor.startsWith('State')).length,1);
 assert.equal(result.targets[0].last_cycle_amt,3000);
 c.window._repeatTargets=result.targets;c.window._recommendations=[];c.window._lobbyAttr=new Map();c.window._cycle=2026;c.window._targetProfile={name:'Jason for Bend'};
 const sheet=c.planSheetAoa(c.planGroups(),2026);
 assert.equal(sheet.rows.filter((r,i)=>sheet.roles[i]==='donor'&&r[2]==='State Farm Federal PAC').length,1);
});
test('firm member donor rolls under firm lead and Last Cycle sums include explicit zero',()=>{
 const {c,get}=harness();
 vm.runInContext(`lobbyistsById=new Map([[1,{lobbyist_id:1,name:'Member',kind:'person'}],[2,{lobbyist_id:2,name:'Lead',kind:'person'}],[3,{lobbyist_id:3,name:'Firm',kind:'firm',firm_primary_id:2,firm_member_ids:[1,2]}]]);
 window._lobbyAttr=new Map([['a',[{lobbyist:lobbyistsById.get(1),status:'confirmed',is_primary:true,methods:[],client_names:[]}]]]);`,c);
 c.window._cycle=2026;c.window._recommendations=[];
 c.window._repeatTargets=[{donor:'Acme',donor_key:'a',target:2000,current_cycle_amt:0,remaining:2000,cycles:{2024:1500},last_cycle_amt:1500,comp_max:4000,comp_max_filers:['Comparable'],comp_gifts:[]}];
 const groups=c.planGroups();assert.equal(groups[0].lobbyist.lobbyist_id,3);assert.equal(groups[0].last_cycle,1500);assert.equal(c.planContact(groups[0].lobbyist).name,'Lead');
 c.renderLobbyistPlan();assert.match(get('plan-tbody').innerHTML,/aria-expanded="true"/);assert.doesNotMatch(get('plan-tbody').innerHTML,/data-group="0" hidden/);assert.match(get('plan-tbody').innerHTML,/\$1,500/);assert.match(get('plan-tbody').innerHTML,/Comparable/);
 c.window._rejectedFirmIds=new Map([['a',new Set([3])]]);
 assert.equal(c.planGroups()[0].lobbyist.lobbyist_id,1);
 c.window._repeatTargets[0].cycles={};c.window._repeatTargets[0].last_cycle_amt=0;
 assert.equal(c.planGroups()[0].last_cycle,0);
});
test('ambiguous firm membership does not arbitrarily select a firm',()=>{
 const {c}=harness();vm.runInContext(`this.firm=LOB.owningFirm({lobbyist_id:1,kind:'person'},new Map([[2,{kind:'firm',firm_member_ids:[1]}],[3,{kind:'firm',firm_member_ids:[1]}]]));`,c);assert.equal(c.firm.lobbyist_id,1);
});
test('adopted spelling is shared across caches and lookup, including AT&T',async()=>{
 const {c}=harness();c.getSupabase=async()=>({from:()=>({select(){return this},order(){return this},range:async()=>({data:[{alias:'old brand',display_name:'eBay PAC'}]})})});
 await vm.runInContext('DN.load()',c);
 assert.equal(c.donorDisplayName('At&T'),'AT&T');assert.equal(c.donorDisplayName('AT&T'),'AT&T');assert.equal(c.donorDisplayName('old brand'),'eBay PAC');
 assert.equal(vm.runInContext(`DN.tree({top_donors:[{name:'old brand',total:5}],display_name:'at&t'}).top_donors[0].name`,c),'eBay PAC');
 assert.equal(vm.runInContext(`DN.tree({display_name:'at&t'}).display_name`,c),'AT&T');
});
test('Comparable Max names the actual discounted benchmark filer, not the outlier',()=>{
 const {c}=harness();const p={top_donors_by_year:{2024:[{name:'Acme',donor_id:'a',total:1000}]}};
 const profiles=[10000,4000].map(total=>({top_donors_by_year:{2024:[{name:'Acme',donor_id:'a',total}]}}));
 const r=c.buildRepeatDonorTargets(p,[{name:'Outlier'},{name:'Benchmark'}],profiles,['2025','2026'],2026,null).targets[0];
 assert.equal(r.comp_max,4000);assert.deepEqual(Array.from(r.comp_max_filers),['Benchmark']);
});

test('repeat asks round before computing remaining amounts and export uses that target',()=>{
 const {c}=harness();
 const profile={top_donors_by_year:{2022:[{donor_id:'a',name:'Acme',total:1000}],2024:[{donor_id:'a',name:'Acme',total:5000}],2026:[{donor_id:'a',name:'Acme',total:123}]}};
 const r=c.buildRepeatDonorTargets(profile,[],[],['2025','2026'],2026,null).targets[0];
 assert.equal(r.target,5250);assert.equal(r.remaining,5127);
 c.window._repeatTargets=[r];c.window._recommendations=[];c.window._lobbyAttr=new Map();c.window._cycle=2026;c.window._targetProfile={name:'Candidate'};
 const sheet=c.planSheetAoa(c.planGroups(),2026);
 const donor=sheet.rows.find((row,i)=>sheet.roles[i]==='donor');
 assert.equal(donor[sheet.moneyFrom+1],5250);
});

test('lobbyist target keeps last-cycle client floor, including omitted clients, without inflating donor asks',()=>{
 const {c,get}=harness();
 vm.runInContext(`lobbyistsById=new Map([[1,{lobbyist_id:1,name:'Lobbyist',kind:'person'}]]);
 window._lobbyAttr=new Map(['a','b','c'].map(key=>[key,[{lobbyist:lobbyistsById.get(1),status:'confirmed',is_primary:true,methods:[],client_names:[]}]]));`,c);
 c.window._cycle=2026;c.window._recommendations=[];
 c.window._targetProfile={name:'Jason for Bend',top_donors_by_year:{2024:[{donor_id:'a',name:'Client A',total:2000},{donor_id:'b',name:'Client B',total:3000}],2026:[{donor_id:'c',name:'Client C',total:1200}]}};
 c.window._repeatTargets=[{donor:'Client A',donor_id:'a',donor_key:'a',target:2000,current_cycle_amt:0,remaining:2000,cycles:{2024:2000}}];
 let groups=c.planGroups(),g=groups[0];
 assert.equal(g.last_cycle,5000);assert.equal(g.target,5000);assert.equal(g.additional_ask,3000);assert.equal(g.given,1200);assert.equal(g.remaining,3800);
 assert.equal(c.window._repeatTargets[0].target,2000);assert.equal(g.rows.find(r=>r.donor_key==='b').target,0);
 c.renderLobbyistPlan();assert.match(get('plan-tbody').innerHTML,/client allocation remains open/);
 const sheet=c.planSheetAoa(groups,2026),askColumn=sheet.rows[6].indexOf('Ask');
 assert.equal(sheet.rows.find(r=>r[1]==='Everyone')[askColumn],5000);
 assert.equal(sheet.rows.find(r=>r[1]==='Lobbyist')[askColumn],5000);
 assert.equal(sheet.rows.find(r=>String(r[2]).startsWith('Additional lobbyist ask'))[askColumn],3000);
 const flat=c.lobbyistPlanExportRows();assert.equal(flat.reduce((s,r)=>s+r.Target,0),5000);assert.equal(flat[0]['Lobbyist Remaining'],3800);
 assert.equal(c.lobbyistSheetRows(groups,2026)[0]['Suggested ask'],5000);
 get('plan-search').value='Client A';assert.equal(c.planGroups()[0].target,5000);assert.equal(c.planGroups()[0].rows.length,3);
});

test('lobbyist floor rounds upward, keeps higher asks, and credits excess current giving across clients',()=>{
 const {c}=harness();vm.runInContext(`lobbyistsById=new Map([[1,{lobbyist_id:1,name:'Lead',kind:'person'}]]);window._lobbyAttr=new Map([['a',[{lobbyist:lobbyistsById.get(1),status:'confirmed',methods:[]}]]]);`,c);
 c.window._cycle=2026;c.window._recommendations=[];
 c.window._repeatTargets=[{donor:'Client',donor_key:'a',target:2000,current_cycle_amt:6000,remaining:0,cycles:{2024:5100}}];
 let g=c.planGroups()[0];assert.equal(g.target,5250);assert.equal(g.remaining,0);
 c.window._repeatTargets[0].target=7500;g=c.planGroups()[0];assert.equal(g.target,7500);assert.equal(g.additional_ask,0);assert.equal(g.remaining,1500);
 c.window._lobbyAttr=new Map();g=c.planGroups()[0];assert.equal(g.target,7500);assert.equal(g.additional_ask,0);
});
test('lobbyist exports wait for attribution, and say so when it failed',async()=>{
 const {c,get}=harness();let built=null,confirmed=0;
 c.XLSX={utils:{book_new:()=>({})}};c.confirm=()=>{confirmed++;return false;};
 c.exportLobbyistWorkbook=async groups=>{built=groups;};
 vm.runInContext(`lobbyistsById=new Map([[1,{lobbyist_id:1,name:'Pat',kind:'person'}]]);`,c);
 c.window._cycle=2026;c.window._recommendations=[];c.window._targetProfile={name:'Friends of Test',slug:'friends_of_test'};
 c.window._repeatTargets=[{donor:'Acme',donor_key:'a',target:2000,current_cycle_amt:0,remaining:2000,cycles:{2024:1500},last_cycle_amt:1500,comp_max:0,comp_max_filers:[],comp_gifts:[],factors:[],history:[]}];
 // Still loading: nothing is built yet, and the plan says why.
 let finish;c.window._lobbyAttr=null;c.window._lobbyPlanLoad=new Promise(r=>{finish=r;});
 c.exportData('xlsx','lobbyist');
 assert.equal(built,null);assert.match(get('plan-status').textContent,/Waiting for lobbyist attribution/);
 vm.runInContext(`window._lobbyAttr=new Map([['a',[{lobbyist:lobbyistsById.get(1),status:'confirmed',is_primary:true,methods:[],client_names:[]}]]]);`,c);
 finish();await c.window._lobbyPlanLoad;await null;await null;
 assert.ok(built,'built once attribution arrived');assert.equal(built[0].lobbyist.name,'Pat');
 // Attribution failed: ask first, and export nothing if the answer is no.
 built=null;c.window._lobbyAttrError='timeout';
 c.exportData('xlsx','lobbyist');
 assert.equal(confirmed,1);assert.equal(built,null);
 c.confirm=()=>true;c.exportData('xlsx','lobbyist');await null;
 assert.ok(built,'exported after confirming');
});
