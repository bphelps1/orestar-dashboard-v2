'use strict';
// Run with: node --test tests/candidate_plan_floors.test.cjs
//
// The "For a candidate" plan's floors: anyone who gave last cycle is asked for
// more than that, the cycle's target is never below last cycle's eligible
// total, people who have given are listed apart from the lobbyist call list,
// and donors with no lobbyist stay at the bottom of it.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..');
function harness(){
 const els=new Map(); const get=id=>{if(!els.has(id))els.set(id,{value:'',checked:true,innerHTML:'',querySelectorAll:()=>[]});return els.get(id)};
 const c=vm.createContext({window:{},document:{addEventListener(){},getElementById:get,querySelectorAll:()=>[]},console:{log(){},warn(){}},setTimeout,clearTimeout});
 for(const f of ['docs/lib/donor-names.js','docs/lib/lobbyists.js','docs/recommend.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),c);
 vm.runInContext('currentLegislators={};committeeChairs=[];loadCurrentLegislators=async()=>{};isCurrentLegislator=()=>true;loadFundraisingOutliers=async()=>new Map();raceMarginIndex=new Map();adminTags={}',c);
 return {c,get};
}
const gift=(total,name='Acme PAC',donor_id='a')=>({donor_id,name,total});
const peer=name=>({name,candidate_name:name,slug:name,office:'State Representative',party:'Democrat',committee_type:'Candidate Committee',election:'2026 General',total_in:1000});

test('the floor is last cycle plus 5%, rounded up to $250, and always more than last cycle',()=>{
 const {c}=harness();
 assert.equal(c.aboveLastCycle(1000),1250);   // nearest-$250 used to give $1,000
 assert.equal(c.aboveLastCycle(2000),2250);
 assert.equal(c.aboveLastCycle(5000),5250);   // lands on a step: not pushed to $5,500
 assert.equal(c.aboveLastCycle(10000),10500);
 assert.equal(c.aboveLastCycle(450),500);
 assert.equal(c.aboveLastCycle(0),0);
 for(const amount of [1,249,250,999,1000,1001,2380,4761.9,123456]) assert.ok(c.aboveLastCycle(amount)>amount,`${amount}`);
});

test('a donor who gave last cycle is asked for more, and the row says why',()=>{
 const {c}=harness();
 const profile={top_donors_by_year:{2022:[gift(1000)],2024:[gift(1000)]}};
 const row=c.buildRepeatDonorTargets(profile,[],[],['2025','2026'],2026,null).targets[0];
 assert.equal(row.evidence_target,1000,'+5% rounds back down to $1,000 on the evidence alone');
 assert.equal(row.target,1250);assert.equal(row.remaining,1250);
 assert.match(row.factors.join(' '),/More than last cycle: \$1,000 eligible giving in 2023–2024 \+ 5%, rounded up to \$250 → \$1,250/);
 assert.match(row.factors.join(' '),/→ target: \$1,000/,'the evidence line still quotes the evidence');
});

test('an ask the evidence already puts above the floor is left alone',()=>{
 const {c}=harness();
 const row=c.buildRepeatDonorTargets({top_donors_by_year:{2022:[gift(4000)],2024:[gift(4000)]}},[],[],['2025','2026'],2026,null).targets[0];
 assert.equal(row.target,4250);assert.equal(row.ask_floor,4250);
 assert.doesNotMatch(row.factors.join(' '),/More than last cycle/);
});

test('everyone who gave last cycle is asked for more, however small or new the gift',()=>{
 const {c}=harness();
 // $300 a cycle: the evidence alone asks $250, under the $500 cut; the floor asks $500.
 const small=c.buildRepeatDonorTargets({top_donors_by_year:{2022:[gift(300)],2024:[gift(300)]}},[],[],['2025','2026'],2026,null).targets[0];
 assert.equal(small.evidence_target,250);assert.equal(small.target,500);
 // One cycle only, and never seen at a comparable: still asked, because that cycle was the last one.
 const once=c.buildRepeatDonorTargets({top_donors_by_year:{2024:[gift(2500)]}},[],[],['2025','2026'],2026,null).targets[0];
 assert.equal(once.target,2750);
 // A newer incumbent whose peers got $300 from a donor that gave this candidate $600.
 const capped={top_donors_by_year:{2024:[gift(600)]},_entryBaseline:{year:2024,primaryDate:'2024-05-21'},_askDonorsByYear:{2024:[gift(600)]}};
 const row=c.buildRepeatDonorTargets(capped,[peer('Peer')],[{top_donors_by_year:{2024:[gift(300)]}}],[],2026,null).targets[0];
 assert.equal(row.evidence_target,250);assert.equal(row.target,750);
});

test('no last-cycle giving means no floor: lapsed donors and older one-cycle donors are not added',()=>{
 const {c}=harness();
 const lapsed=c.buildRepeatDonorTargets({top_donors_by_year:{2020:[gift(5000)],2022:[gift(5000)]}},[],[],['2025','2026'],2026,null);
 assert.equal(lapsed.targets.length,0);assert.equal(lapsed.notRecommended.length,1);
 const old=c.buildRepeatDonorTargets({top_donors_by_year:{2022:[gift(3000)]}},[],[],['2025','2026'],2026,null);
 assert.equal(old.targets.length,0);
});

test("ORESTAR's pooled small-gift line is never a donor, however it is spelled",()=>{
 const {c}=harness();
 for(const name of ['Miscellaneous Contributions $100 and under','Miscellaneous Cash Contributions $100 and under',
                    'Misc. Contributions Under $100','MISCELLANEOUS-NOT OVER $100','Miscellaneous','Aggregate contributions $100 or less'])
  assert.equal(c.isDonorExcluded(name),true,name);
 for(const name of ['Aggregate Resource Industries, Inc.','Oregon Nurses PAC','Mission Foods'])
  assert.equal(c.isDonorExcluded(name),false,name);
 const profile={top_donors_by_year:{2024:[gift(10977,'Miscellaneous Contributions $100 and under','misc'),gift(1000)]}};
 const {targets}=c.buildRepeatDonorTargets(profile,[],[],['2025','2026'],2026,null);
 assert.deepEqual(Array.from(targets,t=>t.donor),['Acme PAC']);
});

test('last cycle is the monthly total less exceptional-primary giving, and the target clears it',()=>{
 const {c}=harness();
 const profile={
  timeline:[{month:'2022-12',contributions:99999},{month:'2023-03',contributions:40000},{month:'2024-06',contributions:60000},{month:'2025-02',contributions:5000}],
  top_donors_by_year:{2023:[gift(30000)],2024:[gift(50000)]},
  _askDonorsByYear:{2024:[gift(38000)]},           // 2023 and part of 2024 inside the primary window
 };
 const last=c.lastCycleContributions(profile,2026);
 assert.equal(last.cycle,2024);assert.equal(last.raised,100000);
 assert.equal(last.excluded,42000);assert.equal(last.eligible,58000);
 const short=c.fundraisingTarget(50000,last);
 assert.equal(short.floor,61000);assert.equal(short.target,61000);assert.equal(short.gap,11000);
 const covered=c.fundraisingTarget(75000,last);
 assert.equal(covered.target,75000);assert.equal(covered.gap,0);
 // No reviewed exclusions: last cycle is simply what was raised.
 assert.equal(c.lastCycleContributions({timeline:profile.timeline,top_donors_by_year:profile.top_donors_by_year},2026).eligible,100000);
});

function planFixture(c){
 vm.runInContext(`lobbyistsById=new Map([[1,{lobbyist_id:1,name:'Pat Lobbyist',kind:'person'}]]);
 window._lobbyAttr=new Map([['org-a',[{lobbyist:lobbyistsById.get(1),status:'confirmed',is_primary:true,methods:[],client_names:[]}]]]);`,c);
 c.window._cycle=2026;c.window._recommendations=[];
 c.window._targetProfile={name:'Friends of Test',top_donors_by_year:{2024:[gift(2000,'Org A','org-a'),gift(1000,'Org B','org-b'),gift(1000,'Jane Doe','p1'),gift(100,'John Roe','p2')]}};
 const row=(donor,key,target,last)=>({donor,donor_key:key,donor_id:key,target,current_cycle_amt:0,remaining:target,cycles:{2024:last},last_cycle_amt:last,comp_max:0,comp_max_filers:[],comp_gifts:[],factors:[`Ask baseline (2023–2024): $${last}`]});
 c.window._repeatTargets=[row('Org A','org-a',2250,2000),row('Org B','org-b',1250,1000),row('Jane Doe','p1',1250,1000)];
 c.window._donorTypes=new Map([['org-a','Political Committee'],['org-b','Business Entity'],['p1','Individual'],['p2','Individual']]);
}

test('people who have given are listed apart from the call list; unattributed organizations stay at its bottom',()=>{
 const {c,get}=harness();planFixture(c);
 const groups=c.planGroups();
 assert.equal(groups.length,2);
 assert.equal(groups[0].lobbyist.name,'Pat Lobbyist');
 assert.equal(groups[1].lobbyist,null,'no-lobbyist organizations are the last group');
 assert.deepEqual(Array.from(groups[1].rows,r=>r.donor),['Org B']);
 assert.ok(groups.every(g=>g.rows.every(r=>!['Jane Doe','John Roe'].includes(r.donor))),'people are not on the call list');
 const people=c.planIndividuals();
 assert.deepEqual(Array.from(people,r=>r.donor),['Jane Doe','John Roe']);
 assert.equal(people[0].target,1250);assert.equal(people[1].target,0,'history only: too small for an ask');
 c.renderLobbyistPlan();
 const html=get('plan-tbody').innerHTML;
 assert.ok(html.indexOf('No lobbyist on file')<html.indexOf('Individual donors'),'the people come after the whole call list');
 assert.match(html,/data-group="individuals" aria-expanded="false">▸ 2 people/);
 assert.match(html,/data-group="individuals" hidden/);
});

test('exports carry the people: marked in the flat rows, and on their own sheet',()=>{
 const {c}=harness();planFixture(c);
 const flat=c.lobbyistPlanExportRows();
 const people=flat.filter(r=>r.Lobbyist==='(individual — ask directly)');
 assert.deepEqual(Array.from(people,r=>r.Donor),['Jane Doe','John Roe']);
 assert.equal(flat.indexOf(people[0]),flat.length-2,'after every lobbyist row');
 const sheet=c.individualSheetRows(2026);
 assert.equal(sheet.length,2);
 assert.equal(sheet[0].Ask,1250);assert.equal(sheet[0]['Given 2023–2024'],1000);
 assert.equal(sheet[1].Ask,'');assert.match(sheet[1]['How the ask was set'],/No ask/);
});

test('with a search, the people section filters too, and no match anywhere says so',()=>{
 const {c,get}=harness();planFixture(c);
 get('plan-search').value='jane';
 assert.deepEqual(Array.from(c.planIndividuals(),r=>r.donor),['Jane Doe']);
 get('plan-search').value='nobody';
 c.renderLobbyistPlan();assert.match(get('plan-tbody').innerHTML,/No donors match/);
});
