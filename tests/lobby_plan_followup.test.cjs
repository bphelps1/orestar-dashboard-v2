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
