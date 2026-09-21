const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function harness(realMembership=false){const c=vm.createContext({window:{},document:{addEventListener(){}},console:{log(){}},setTimeout,clearTimeout});vm.runInContext(fs.readFileSync(path.join(__dirname,'../docs/recommend.js'),'utf8'),c);if(!realMembership)vm.runInContext("loadCurrentLegislators=async()=>{};isCurrentLegislator=()=>true;loadFundraisingOutliers=async()=>new Map()",c);vm.runInContext("committeeChairs=[]",c);return c;}
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
 assert.deepEqual(Array.from(r,x=>x.slug).sort(),['recent']);
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
test('Senior leaders compare across chambers and exclude ordinary candidates',async()=>{
 const c=harness();c.filers=[candidate('speaker',{leadership_role:'Speaker of the House',leadership_tier:1}),candidate('majority',{leadership_role:'House Majority Leader',leadership_tier:2}),candidate('member'),candidate('assistant',{leadership_role:'House Assistant Majority Leader'}),candidate('protem',{leadership_role:'House Speaker Pro Tem'}),candidate('senator',{office:'State Senator',leadership_role:'Senate Majority Leader'})];
 vm.runInContext('filerIndex=filers;raceMarginIndex=new Map();adminTags={}',c);
 for(const slug of ['member','assistant','protem']){
  const result=await c.findComparables({},c.filers.find(f=>f.slug===slug),2026);
  assert.ok(result.every(f=>!['speaker','majority'].includes(f.slug)));
 }
 let result=await c.findComparables({},c.filers[0],2026);assert.deepEqual(Array.from(result,f=>f.slug),['majority','senator']);assert.equal(result[0].benchmarkFactor,1);
 result=await c.findComparables({},c.filers[1],2026);assert.deepEqual(Array.from(result,f=>f.slug),['speaker','senator']);assert.equal(result[0].benchmarkFactor,0.9);
});
test('live role metadata overrides stale cached leadership and excludes assistants',()=>{
 const c=harness();vm.runInContext(`leadershipRoles={leader:{filer_name:'Example Person',role_title:'House Majority Leader'}}`,c);
 assert.equal(c.primaryLeadershipRole(candidate('current',{name:'Friends of Example Person'})),'house-majority-leader');
 assert.equal(c.primaryLeadershipRole(candidate('assistant',{leadership_role:'House Assistant Majority Leader'})),null);
 assert.equal(c.primaryLeadershipRole(candidate('whip',{leadership_role:'House Majority Whip'})),null);
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
 const comps=[candidate('speaker',{comparisonKind:'leadership-primary',benchmarkFactor:0.9,leadership_tier:1})];
 const profiles=[{top_donors_by_year:{2024:[{donor_id:'a',name:'Acme',total:10000}],2026:[{donor_id:'a',name:'Acme',total:10000}]}}];
 const target={top_donors_by_year:{}};
 const result=c.scoreDonors(target,comps,profiles,['2025','2026'],2026,null).prospects;
 assert.equal(result.length,1);assert.equal(result[0].target_ask,4500);assert.equal(result[0].comp_max,10000);assert.equal(result[0].comp_gifts[0].amount,10000);
 assert.ok(result[0].factors.some(f=>f.includes('discounted 10%')));
 const repeat=c.buildRepeatDonorTargets({top_donors_by_year:{2024:[{donor_id:'a',name:'Acme',total:5000}]}},comps,profiles,['2025','2026'],2026,null).targets[0];
 assert.equal(repeat.target,7500);assert.equal(repeat.comp_max,10000);assert.equal(repeat.last_cycle_amt,5000);
});

test('current-member filter removes Holvey and excludes Taylor from House comparisons',async()=>{
 const c=harness(true);
 c.roster=JSON.parse(fs.readFileSync(path.join(__dirname,'../docs/assets/current_legislators.json'),'utf8')).members;
 c.filers=[candidate('target',{name:'Jason for Bend',candidate_name:'Jason Kropf'}),
 candidate('holvey',{name:'Friends of Paul Holvey',candidate_name:'Paul Richard Holvey'}),
 candidate('taylor',{name:'Kathleen Taylor for Senate',candidate_name:'Kathleen Taylor',office:'State Senator'}),
 candidate('fragala',{name:'Friends of Lisa Fragala',candidate_name:'Lisa Fragala'}),
 candidate('unknown',{name:'Unknown Candidate'}),candidate('missing-office',{name:'Friends of Lisa Fragala',office:''})];
 vm.runInContext('currentLegislators=roster;filerIndex=filers;raceMarginIndex=new Map();adminTags={}',c);
 assert.equal(c.isCurrentLegislator(c.filers[1]),false);
 assert.equal(c.isCurrentLegislator(c.filers[2]),true);
 assert.deepEqual(Array.from(await c.findComparables({},c.filers[0],2026),f=>f.slug),['fragala']);
 assert.deepEqual(Array.from(await c.findComparables({},c.filers[2],2026),f=>f.slug),[]);
 assert.equal(c.isOfficeComparable('state_rep','state_senate'),false);
 assert.equal(c.isOfficeComparable('state_senate','state_rep'),false);
});
test('membership matches accents, initials, and full committee names without surname-only matches',()=>{
 const c=harness(true);vm.runInContext('currentLegislators={house:["Lesly Muñoz","Tawna D. Sanchez","Ben Bowman","Ricki Ruiz"],senate:[]}',c);
 assert.equal(c.isCurrentLegislator(candidate('munoz',{candidate_name:'Lesly Munoz'})),true);
 assert.equal(c.isCurrentLegislator(candidate('sanchez',{candidate_name:'Tawna Sanchez'})),true);
 assert.equal(c.isCurrentLegislator(candidate('bowman',{candidate_name:'Benjamin W Bowman',name:'Friends of Ben Bowman'})),true);
 assert.equal(c.isCurrentLegislator(candidate('ruiz',{candidate_name:'Ricardo Ruiz'})),true);
 assert.equal(c.isCurrentLegislator(candidate('other',{candidate_name:'Other Bowman'})),false);
});
test('roster failure stops recommendations instead of admitting former legislators',async()=>{
 const c=harness(true);c.fetch=async()=>({ok:false});
 vm.runInContext('raceMarginIndex=new Map()',c);
 await assert.rejects(c.findComparables({},candidate('target'),2026),/Could not verify current legislators/);
 c.fetch=async()=>({ok:true,json:async()=>({members:{house:[],senate:[]}})});
 await assert.rejects(c.loadCurrentLegislators(),/roster is unavailable/);
});

test('leadership primary roles outrank automatic secondary outliers, with no ordinary or former peers',async()=>{
 const c=harness();c.filers=[candidate('speaker',{leadership_role:'Speaker of the House'}),
 candidate('president',{office:'State Senator',leadership_role:'Senate President'}),
 candidate('senate-majority',{office:'State Senator',leadership_role:'Senate Majority Leader'}),
 candidate('ways',{leadership_role:'Ways & Means Co-Chair'}),
 candidate('subcommittee',{leadership_role:'Ways and Means Education Subcommittee Co-Chair'}),
 candidate('ordinary'),candidate('outlier',{office:'State Senator',total_in:1000000}),
 candidate('former',{leadership_role:'Senate President',office:'State Senator'}),
 candidate('excluded',{leadership_role:'Ways and Means Co-Chair'})];
 vm.runInContext('filerIndex=filers;raceMarginIndex=new Map();adminTags={outlier:[{tag:"prolific"}],excluded:[{tag:"exclude"}]};isCurrentLegislator=f=>f.slug!=="former";loadFundraisingOutliers=async()=>new Map([["outlier",{amount:1000000,threshold:500000}]])',c);
 const result=await c.findComparables({},c.filers[0],2026);
 assert.deepEqual(Array.from(result,f=>f.slug).sort(),['outlier','president','senate-majority','ways']);
 assert.equal(result.at(-1).slug,'outlier');
 assert.equal(result.at(-1).comparisonKind,'leadership-secondary');
 assert.equal(c.primaryLeadershipRole(c.filers[4]),null);
});
test('primary leadership giving sets repeat and first-time targets even with huge secondary gifts',()=>{
 const c=harness(),comps=[candidate('primary',{comparisonKind:'leadership-primary'}),candidate('outlier',{comparisonKind:'leadership-secondary'})];
 const profiles=[{top_donors_by_year:{2024:[{donor_id:'a',name:'Acme',total:10000}]}},{top_donors_by_year:{2024:[{donor_id:'a',name:'Acme',total:1000000}]}}];
 const first=c.scoreDonors({top_donors_by_year:{}},comps,profiles,['2024'],2026,null).prospects[0];
 assert.equal(first.target_ask,5000);
 assert.ok(first.factors.some(f=>f.includes('primary leadership references')));
 const repeat=c.buildRepeatDonorTargets({top_donors_by_year:{2024:[{donor_id:'a',name:'Acme',total:5000}]}},comps,profiles,[],2026,null).targets[0];
 const baseline=c.buildRepeatDonorTargets({top_donors_by_year:{2024:[{donor_id:'a',name:'Acme',total:5000}]}},comps.slice(0,1),profiles.slice(0,1),[],2026,null).targets[0];
 assert.equal(repeat.target,baseline.target);
 assert.equal(c.firstGivingBenchmark('a',profiles,comps,2026,null).amount,10000);
 const ref=c.leadershipReference([{filer:'outlier',amount:2000}],comps);
 assert.equal(ref.gifts.length,1);assert.match(ref.label,/secondary/);
});

test('automatic outliers use completed-cycle receipts, exclude closed profiles, and require eight observations',()=>{
 const c=harness(),filers=Array.from({length:10},(_,i)=>candidate('peer'+i));
 const rows=filers.map((f,i)=>({slug:f.slug,timeline:[{month:'2024-06',contributions:10000+i*1000},{month:'2026-06',contributions:99999999}]}));
 rows[9].timeline.push({month:'2022-06',contributions:100000});
 let outliers=c.fundraisingOutliers(filers,rows,2026);
 assert.deepEqual(Array.from(outliers.keys()),['peer9']);assert.equal(outliers.get('peer9').amount,100000);
 rows[9].closed=true;assert.equal(c.fundraisingOutliers(filers,rows,2026).size,0);
 assert.equal(c.fundraisingOutliers(filers.slice(0,7),rows,2026).size,0);
});

test('observed first gifts prefer primary leaders, while secondary-only prospects still need breadth',()=>{
 const c=harness(),comps=[candidate('primary',{comparisonKind:'leadership-primary'}),candidate('outlier',{comparisonKind:'leadership-secondary'})];
 c.window._firstGifts=new Map([['a',[{filer:'primary',amount:1000},{filer:'outlier',amount:100000}]]]);
 assert.equal(c.firstGivingBenchmark('a',[],comps,2026,null).amount,1000);
 const profiles=[{top_donors_by_year:{}},{top_donors_by_year:{2024:[{donor_id:'a',name:'Acme',total:10000}]}}];
 const result=c.scoreDonors({top_donors_by_year:{}},comps,profiles,['2024'],2026,null);
 assert.equal(result.prospects.length,0);
 assert.ok(result.notRecommended.some(r=>r.whyNotIncluded.includes('one comparable')));
});
