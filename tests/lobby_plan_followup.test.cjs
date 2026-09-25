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
 const sheet=c.planSheetAoa(groups,2026),askColumn=sheet.rows[2].indexOf('Ask');
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
test('the Google Sheets button asks Google inside the click, then uploads the same workbook as a Sheet',async()=>{
 const {c,get}=harness();let requested=0,granted=true,sent=null,built=null;
 c.window.google={accounts:{oauth2:{
  initTokenClient:cfg=>({requestAccessToken(){requested++;cfg.callback({access_token:'tok',expires_in:3600});}}),
  hasGrantedAllScopes:()=>granted}}};
 // Fakes that record what was appended, so the test runs without a DOM.
 c.FormData=class{constructor(){this.parts=[];}append(k,v){this.parts.push([k,v]);}};
 c.Blob=class{constructor(parts,opts){this.parts=parts;this.type=opts&&opts.type;}};
 // The consent window opens before anything is awaited: browsers block popups after a wait.
 c.exportData=(...args)=>{built=args;};
 c.saveLobbyistPlanToDrive();
 assert.equal(requested,1,'token requested synchronously');
 assert.equal(built[0],'xlsx');assert.equal(built[1],'lobbyist');assert.equal(await built[2].drive,'tok');
 // Remembered for the hour: a second save does not reopen Google's window.
 assert.equal(await c.requestDriveToken(),'tok');assert.equal(requested,1);
 c.fetch=async(url,opts)=>{sent={url,opts};return {ok:true,status:200,json:async()=>({id:'abc',name:'Plan <1>',webViewLink:'https://docs.google.com/spreadsheets/d/abc/edit'})};};
 const file={kind:'xlsx'};
 const link=await c.saveWorkbookToDrive(file,'Plan <1>',Promise.resolve('tok'));
 assert.equal(link,'https://docs.google.com/spreadsheets/d/abc/edit');
 assert.match(sent.url,/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=multipart/);
 assert.equal(sent.opts.method,'POST');assert.equal(sent.opts.headers.Authorization,'Bearer tok');
 const [meta,body]=sent.opts.body.parts;
 assert.equal(meta[0],'metadata');assert.equal(meta[1].type,'application/json');
 assert.deepEqual(JSON.parse(meta[1].parts[0]),{name:'Plan <1>',mimeType:'application/vnd.google-apps.spreadsheet'});
 // Tagged, when asked, so Update can find the sheet again.
 await c.saveWorkbookToDrive(file,'Plan',Promise.resolve('tok'),{orestarFiler:'friends_of_test',orestarCycle:'2026'});
 assert.deepEqual(JSON.parse(sent.opts.body.parts[0][1].parts[0]).appProperties,{orestarFiler:'friends_of_test',orestarCycle:'2026'});
 assert.equal(body[0],'file');assert.equal(body[1],file);
 assert.match(get('export-status').innerHTML,/href="https:\/\/docs\.google\.com\/spreadsheets\/d\/abc\/edit"/);
 assert.match(get('export-status').innerHTML,/Plan &lt;1&gt;/);
 // An expired token is forgotten, so the next click asks again.
 c.fetch=async()=>({ok:false,status:401,json:async()=>({error:{message:'Invalid Credentials'}})});
 await assert.rejects(c.saveWorkbookToDrive(file,'Plan',Promise.resolve('tok')),/401: Invalid Credentials/);
 await c.requestDriveToken();assert.equal(requested,2);
 // Unticking the Drive box on Google's screen is a refusal, not a token.
 vm.runInContext('driveToken=null',c);granted=false;
 await assert.rejects(c.requestDriveToken(),/not allowed/);
});
test('a Drive save carries its token through the attribution wait to the workbook, under a readable name',async()=>{
 const {c}=harness();let opts=null;
 c.XLSX={utils:{book_new:()=>({})}};
 c.exportLobbyistWorkbook=async(groups,cycle,filename,o)=>{opts={filename,...o};};
 vm.runInContext(`lobbyistsById=new Map([[1,{lobbyist_id:1,name:'Pat',kind:'person'}]]);`,c);
 c.window._cycle=2026;c.window._recommendations=[];c.window._targetProfile={name:'Friends of Test',slug:'friends_of_test'};
 c.window._repeatTargets=[{donor:'Acme',donor_key:'a',target:2000,current_cycle_amt:0,remaining:2000,cycles:{2024:1500},last_cycle_amt:1500,comp_max:0,comp_max_filers:[],comp_gifts:[],factors:[],history:[]}];
 let finish;c.window._lobbyAttr=null;c.window._lobbyPlanLoad=new Promise(r=>{finish=r;});
 const token=Promise.resolve('tok');
 c.exportData('xlsx','lobbyist',{drive:token});assert.equal(opts,null);
 vm.runInContext(`window._lobbyAttr=new Map([['a',[{lobbyist:lobbyistsById.get(1),status:'confirmed',is_primary:true,methods:[],client_names:[]}]]]);`,c);
 finish();await c.window._lobbyPlanLoad;await null;await null;
 assert.ok(opts,'built once attribution arrived');
 assert.equal(opts.drive.token,token);assert.equal(opts.filename,'lobbyist_plan_friends_of_test_2026.xlsx');
 assert.match(opts.drive.title,/^Friends of Test — Lobbyist Plan 2025–2026 \(\w{3} \d{1,2}, \d{4}\)$/);
 assert.equal(JSON.stringify(opts.drive.appProperties),JSON.stringify({orestarPlan:'lobbyist',orestarFiler:'friends_of_test',orestarCycle:'2026'}));
 assert.equal(opts.full,false,'the call list alone unless all tabs are asked for');
 // The Excel button is unchanged: no drive option, so the file downloads.
 opts=null;c.exportData('xlsx','lobbyist');await null;assert.equal(opts.drive,null);
 // All tabs: its own file name, and a Drive title that says so.
 opts=null;c.exportData('xlsx','lobbyist',{full:true});await null;
 assert.equal(opts.full,true);assert.equal(opts.filename,'lobbyist_plan_all_tabs_friends_of_test_2026.xlsx');
 opts=null;c.exportData('xlsx','lobbyist',{full:true,drive:token});await null;assert.match(opts.drive.title,/— Lobbyist Plan, all tabs 2025–2026/);
});
// A plan with two lobbyists, and the Google Sheet it was saved as: values as
// the Sheets API reads them, and the formulas the export writes.
function updateFixture(){
 const {c,get}=harness();
 vm.runInContext(`lobbyistsById=new Map([[1,{lobbyist_id:1,name:'Pat',kind:'person'}],[2,{lobbyist_id:2,name:'Quinn',kind:'person'}]]);
 const link=id=>[{lobbyist:lobbyistsById.get(id),status:'confirmed',is_primary:true,methods:[],client_names:[]}];
 window._lobbyAttr=new Map([['a',link(1)],['b',link(1)],['q',link(2)],['n',link(2)]]);`,c);
 c.window._cycle=2026;c.window._recommendations=[];c.window._targetProfile={name:'Friends of Test',slug:'friends_of_test'};
 const donor=(donor,key,target,given,last)=>({donor,donor_key:key,target,current_cycle_amt:given,remaining:Math.max(0,target-given),
  cycles:last?{2024:last}:{},last_cycle_amt:last,comp_max:0,comp_max_filers:[],comp_gifts:[],factors:[],history:[]});
 c.window._repeatTargets=[donor('Acme PAC','a',2000,500,1500),donor('Beta PAC','b',1000,0,900),donor('Quill PAC','q',3000,0,2500)];
 const saved=c.planSheetAoa(c.planGroups(),2026);
 const values=saved.rows.map(r=>Array.from(r)),formulas=values.map(r=>r.slice());
 const kinds=values[2],money=kinds.flatMap((k,i)=>k&&k!=='Remaining'&&!String(k).startsWith('Δ')?[i]:[]);
 const L=i=>vm.runInContext(`colLetter(${i+1})`,c);
 saved.roles.forEach((role,i)=>{
  if(role!=='lobbyist')return;
  let end=i+1;while(saved.roles[end]==='donor'||saved.roles[end]==='nontarget')end++;
  for(const m of money)formulas[i][m]=`=SUM(${L(m)}${i+2}:${L(m)}${end})`;
 });
 const col=k=>kinds.indexOf(k),rowOf=name=>values.findIndex(r=>r[2]===name);
 return {c,get,values,formulas,col,rowOf,saved,donor};
}
test('Update refreshes ORESTAR figures, keeps what the team typed, adds new donors and flags arrived pledges',()=>{
 const {c,values,formulas,col,rowOf,donor}=updateFixture();
 const given=col('Given'),ask=col('Ask'),committed=col('Committed'),remaining=col('Remaining'),delta=col('Δ vs 2023–2024'),last=col('This candidate');
 const quill=rowOf('Quill PAC'),acme=rowOf('Acme PAC'),beta=rowOf('Beta PAC');
 assert.deepEqual([quill,acme,beta],[5,7,8],'Quinn: Quill alone; Pat: Acme and Beta');
 // The team's edits: a pledge from Acme, a new ask for Beta, and Quill's Given as a formula of their own.
 values[acme][committed]=formulas[acme][committed]=1000;
 values[beta][ask]=formulas[beta][ask]=1200;
 values[quill][given]=2500;formulas[quill][given]='=2000+500';
 // Since then: Acme's cheque arrived, Beta gave with nothing pledged, and
 // three organizations gave for the first time.
 c.window._repeatTargets[0].current_cycle_amt=1500;c.window._repeatTargets[1].current_cycle_amt=300;
 vm.runInContext(`window._lobbyAttr.set('x',window._lobbyAttr.get('a'))`,c);
 c.window._repeatTargets.push(donor('Newco PAC','n',0,750,0),donor('Pax PAC','x',0,400,0),donor('Zed PAC','z',0,400,0));
 const fresh=c.planSheetAoa(c.planGroups(),2026);
 const plan=c.planCallListUpdate({title:'Call list',values,formulas},fresh,{cycle:2026,today:'Sep 25, 2026'});
 const at=(list,r,cc)=>list.filter(w=>w.row===r&&w.col===cc);
 // Newco goes below Quill, Quinn's only donor; Pax inside Pat's group, above
 // its last row. Everything below each moves down.
 assert.equal(JSON.stringify(plan.inserts),JSON.stringify([{row:6,donor:'Newco PAC'},{row:9,donor:'Pax PAC'}]));
 const moved=r=>r+(r>=6?1:0)+(r>=8?1:0);
 assert.deepEqual(Array.from(at(plan.writes,moved(acme),given),w=>w.value),[1500],'Given refreshed');
 assert.deepEqual(Array.from(at(plan.writes,moved(beta),given),w=>w.value),[300]);
 const added=new Set([6,9]);
 assert.equal(plan.writes.filter(w=>!added.has(w.row)&&[ask,committed,remaining,delta].includes(w.col)).length,0,'Ask, Committed and the formula columns are never written');
 assert.equal(at(plan.writes,moved(quill),given).length,0,"the team's own formula stays");
 // Acme's Given rose while a pledge was typed in: the pledge may have arrived. Beta's had none.
 assert.equal(plan.flags.length,1);assert.equal(plan.flags[0].row,moved(acme));assert.equal(plan.flags[0].col,committed);
 assert.match(plan.flags[0].note,/\$1,500 given as of Sep 25, 2026, up \$1,000/);
 // The new rows: who, what they gave, the key, and each row's own formulas.
 const Lt=i=>vm.runInContext(`colLetter(${i+1})`,c);
 const cellAt=(r,cc)=>at(plan.writes,r,cc).map(w=>w.value)[0];
 assert.equal(cellAt(6,2),'Newco PAC');assert.equal(cellAt(6,0),'Quinn');assert.equal(cellAt(6,given),750);assert.equal(cellAt(6,values[0].length-1),'donor:n');
 assert.equal(cellAt(9,2),'Pax PAC');assert.equal(cellAt(9,0),'Pat');assert.equal(cellAt(9,given),400);
 for(const r of [6,9]){
  const N=r+1;
  assert.equal(at(plan.formulaWrites,r,remaining)[0].value,`=IF(N(${Lt(ask)}${N})>0,MAX(0,${Lt(ask)}${N}-N(${Lt(given)}${N})-N(${Lt(committed)}${N})),"")`);
  assert.equal(at(plan.formulaWrites,r,delta)[0].value,`=N(${Lt(given)}${N})+N(${Lt(committed)}${N})-N(${Lt(last)}${N})`);
 }
 // Each lobbyist's sums widen over their new rows: Quinn's (row 5) over 6–7, Pat's (now row 8) over 9–11.
 assert.equal(at(plan.formulaWrites,4,given)[0].value,`=SUM(${Lt(given)}6:${Lt(given)}7)`);
 assert.equal(at(plan.formulaWrites,7,ask)[0].value,`=SUM(${Lt(ask)}9:${Lt(ask)}11)`);
 assert.equal(JSON.stringify(plan.groupRanges),JSON.stringify([{first:5,last:6},{first:8,last:10}]));
 // Zed has no lobbyist and the sheet has no group for that: reported, not guessed.
 assert.deepEqual(Array.from(plan.summary.unplaced),['Zed PAC']);
 assert.equal(plan.summary.changedDonors,2);assert.equal(plan.summary.givenChange,1300);assert.equal(plan.summary.flagged,1);
 assert.ok(plan.notes.some(x=>x.row===3&&/updated Sep 25, 2026/.test(x.note)),'Everyone says when');
});
test('Update finds rows by name and columns by header in a sheet saved before row keys, with columns moved',()=>{
 const {c,values,formulas,col,rowOf}=updateFixture();
 // An older sheet: no Row key column, and the team swapped Tier and Email.
 const keyAt=values[0].length-1;
 for(const rows of [values,formulas])for(const r of rows){r.splice(keyAt,1);[r[3],r[4]]=[r[4],r[3]];}
 c.window._repeatTargets[0].current_cycle_amt=900;
 c.window._repeatTargets.push({donor:'Newco PAC',donor_key:'n',target:0,current_cycle_amt:750,remaining:0,cycles:{},last_cycle_amt:0,comp_max:0,comp_max_filers:[],comp_gifts:[],factors:[],history:[]});
 const plan=c.planCallListUpdate({title:'Call list',values,formulas},c.planSheetAoa(c.planGroups(),2026),{cycle:2026,today:'Sep 25, 2026'});
 const quill=rowOf('Quill PAC'),acme=rowOf('Acme PAC'),moved=r=>r>quill?r+1:r;
 assert.deepEqual(Array.from(plan.writes.filter(w=>w.row===moved(acme)&&w.col===col('Given')),w=>w.value),[900]);
 const added=plan.writes.filter(w=>w.row===quill+1);
 // The tier lands in the moved Tier column, and nothing in the old one.
 assert.equal(added.find(w=>w.col===4).value,c.planSheetAoa(c.planGroups(),2026).rows.find(r=>r[2]==='Newco PAC')[3]);
 assert.ok(!added.some(w=>w.col===3),'Email is blank for a donor with none on file');
 assert.ok(!added.some(w=>w.col===keyAt),'no key column to write to');
 // A sheet without a call list's headers is refused, not scribbled on.
 assert.throws(()=>c.planCallListUpdate({title:'Notes',values:[['hello']],formulas:[['hello']]},c.planSheetAoa(c.planGroups(),2026),{cycle:2026}),/does not look like a call list/);
});
test('Update matches a renamed donor by its row key, and a name listed twice by its lobbyist',()=>{
 const {c,values,formulas,col,rowOf}=updateFixture();
 const given=col('Given'),acme=rowOf('Acme PAC'),beta=rowOf('Beta PAC'),quill=rowOf('Quill PAC');
 // Renamed since the save (a merge, a tidier name): the row key still finds it.
 c.window._repeatTargets[0].donor='Acme Corporation PAC';c.window._repeatTargets[0].current_cycle_amt=900;
 let plan=c.planCallListUpdate({title:'Call list',values,formulas},c.planSheetAoa(c.planGroups(),2026),{cycle:2026});
 assert.equal(plan.inserts.length,0,'not added again as someone new');
 assert.deepEqual(Array.from(plan.writes.filter(w=>w.row===acme&&w.col===given),w=>w.value),[900]);
 // The team copied Beta's row under Quinn too, in a sheet with no row keys:
 // Beta's figures go to the row under its own lobbyist.
 const keyAt=values[0].length-1;
 for(const rows of [values,formulas]){for(const r of rows)r.splice(keyAt,1);const copy=rows[beta].slice();copy[0]='Quinn';rows.splice(quill+1,0,copy);}
 c.window._repeatTargets[0].donor='Acme PAC';c.window._repeatTargets[1].current_cycle_amt=300;
 plan=c.planCallListUpdate({title:'Call list',values,formulas},c.planSheetAoa(c.planGroups(),2026),{cycle:2026});
 assert.equal(plan.inserts.length,0);
 assert.deepEqual(Array.from(plan.writes.filter(w=>w.col===given&&w.value===300),w=>w.row),[beta+1],"Pat's Beta, one row lower for the copy above it");
});
test('Update talks to Drive and Sheets in order: find and tag the sheet, insert, write, regroup, annotate',async()=>{
 const {c,get,values,formulas,rowOf,donor}=updateFixture();
 c.loadNonTargetClients=async()=>[];
 c.window._repeatTargets.push(donor('Newco PAC','n',0,750,0));
 const quill=rowOf('Quill PAC'),calls=[];
 const reply=body=>({ok:true,status:200,json:async()=>body});
 c.fetch=async(url,opts={})=>{
  const body=opts.body?JSON.parse(opts.body):null;calls.push({url,method:opts.method||'GET',body,auth:opts.headers.Authorization});
  if(url.startsWith('https://www.googleapis.com/drive/v3/files?'))return reply({files:decodeURIComponent(url).includes('appProperties has')?[]:
    [{id:'S1',name:'Friends of Test — Lobbyist Plan 2025–2026 (Sep 25, 2026)',webViewLink:'https://docs.google.com/spreadsheets/d/S1/edit'}]});
  if(url.startsWith('https://www.googleapis.com/drive/v3/files/S1'))return reply({});
  if(url.includes('fields=sheets(properties(sheetId,title))'))return reply({sheets:[{properties:{sheetId:7,title:'Call list'}}]});
  if(url.includes('valueRenderOption=UNFORMATTED_VALUE'))return reply({values});
  if(url.includes('valueRenderOption=FORMULA'))return reply({values:formulas});
  if(url.includes('rowGroups'))return reply({sheets:[{properties:{sheetId:7},rowGroups:[{range:{dimension:'ROWS',startIndex:quill,endIndex:quill+1},depth:1}]}]});
  return reply({});
 };
 const summary=await c.updatePlanSheet(Promise.resolve('tok'));
 assert.deepEqual(Array.from(summary.added),['Newco PAC']);
 assert.ok(calls.every(x=>x.auth==='Bearer tok'));
 const [tagged,named,patch]=calls;
 assert.match(decodeURIComponent(tagged.url),/appProperties has \{ key='orestarFiler' and value='friends_of_test' \}/);
 assert.match(decodeURIComponent(named.url),/name contains 'Friends of Test — Lobbyist Plan'/);
 assert.equal(patch.method,'PATCH');assert.equal(patch.body.appProperties.orestarCycle,'2026','tagged, so renaming it later is fine');
 const posts=calls.filter(x=>x.method==='POST');
 assert.deepEqual(Array.from(posts[0].body.requests,r=>r.insertDimension.range.startIndex),[quill+1]);
 assert.equal(posts[0].body.requests[0].insertDimension.inheritFromBefore,true);
 assert.equal(posts[1].body.valueInputOption,'RAW');assert.ok(posts[1].body.data.some(d=>d.range==="'Call list'!C"+(quill+2)&&d.values[0][0]==='Newco PAC'));
 assert.equal(posts[2].body.valueInputOption,'USER_ENTERED');
 // Quill's one-row group becomes a group over Quill and Newco.
 const regroup=posts[3].body.requests;
 assert.deepEqual(Array.from(regroup,r=>Object.keys(r)[0]),['deleteDimensionGroup','addDimensionGroup']);
 assert.deepEqual([regroup[1].addDimensionGroup.range.startIndex,regroup[1].addDimensionGroup.range.endIndex],[quill,quill+2]);
 const noted=posts[4].body.requests.map(r=>r.updateCells);
 assert.ok(noted.some(u=>u.range.startRowIndex===quill+1&&/Added by Update/.test(u.rows[0].values[0].note)&&u.fields.includes('backgroundColor')));
 assert.match(get('export-status').innerHTML,/Updated <a href="https:\/\/docs\.google\.com\/spreadsheets\/d\/S1\/edit"/);
 assert.match(get('export-status').innerHTML,/1 new donor added, highlighted: Newco PAC/);
 // Nothing saved yet: say so, and write nothing.
 calls.length=0;c.fetch=async url=>reply({files:[]});
 assert.equal(await c.updatePlanSheet(Promise.resolve('tok')),null);
 assert.match(get('export-status').innerHTML,/No Google Sheet saved for Friends of Test/);
});
test("a lobbyist's comparable columns count their whole book, with non-target clients in one row and on their own sheet",async()=>{
 const {c}=harness();
 vm.runInContext(`lobbyistsById=new Map([[1,{lobbyist_id:1,name:'Pat',kind:'person'}],[2,{lobbyist_id:2,name:'Quinn',kind:'person'}]]);
 window._lobbyAttr=new Map([['a',[{lobbyist:lobbyistsById.get(1),status:'confirmed',is_primary:true,methods:[],client_names:[]}]]]);`,c);
 c.window._cycle=2026;c.window._recommendations=[];c.window._targetProfile={name:'Friends of Test',top_donors_by_year:{}};
 c.window._repeatTargets=[{donor:'Acme',donor_key:'a',donor_id:'a',target:2000,current_cycle_amt:500,remaining:1500,cycles:{2024:1500},last_cycle_amt:1500,comp_max:0,comp_max_filers:[],comp_gifts:[],factors:[]}];
 c.window._comparables=[{name:'Fahey',chosen:true},{name:'Wagner',chosen:true}];
 c.window._compCycles=new Map([
  ['a',new Map([['Fahey',{2024:1000}]])],                              // in the plan: never a non-target
  ['n1',new Map([['Fahey',{2026:500}],['Wagner',{2024:2000}]])],      // Pat's client, not in the plan
  ['n2',new Map([['Fahey',{2024:9000}]])],                            // strongest link is Quinn, who has no group
  ['n4',new Map()],                                                     // Pat's, but gave the comparables nothing
  ['n5',new Map([['Fahey',{2024:700}]])],                              // Pat's, but an Oregon candidate committee
 ]);
 const links=[
  {donor_id:'a',lobbyist_id:1,status:'confirmed',is_primary:true,score:1},
  {donor_id:'n1',lobbyist_id:1,status:'confirmed',is_primary:true,score:1},
  {donor_id:'n2',lobbyist_id:1,status:'confirmed',is_primary:false,score:5},
  {donor_id:'n2',lobbyist_id:2,status:'confirmed',is_primary:true,score:1},
  {donor_id:'n4',lobbyist_id:1,status:'confirmed',is_primary:true,score:1},
  {donor_id:'n5',lobbyist_id:1,status:'confirmed',is_primary:true,score:1},
 ];
 c.__links=links;
 vm.runInContext(`LOB.fetchIn=async(table,select,col,values)=>table==='donors'
   ?values.map(id=>({donor_id:id,display_name:{n1:'N One Industries',n5:'Friends of Oregon Candidate'}[id]||id}))
   :__links.filter(l=>values.includes(l[col]));`,c);
 vm.runInContext(`filerIndex=[{slug:'foc',name:'Friends of Oregon Candidate',committee_type:'Candidate Committee'}]`,c);
 const groups=c.planGroups();
 const found=await c.loadNonTargetClients(groups,2026);
 assert.deepEqual(Array.from(found,x=>x.donor_id),['n1']);
 const pat=groups.find(g=>g.lobbyist?.name==='Pat');
 assert.equal(pat.nonTarget.clients[0].name,'N One Industries');assert.equal(pat.nonTarget.clients[0].total,2500);
 const {rows,roles}=c.planSheetAoa(groups,2026);
 const [band,names,kinds]=[rows[0],rows[1],rows[2]];
 const thisCycle=band.indexOf('This cycle (2025–2026): comparables'),prior=band.indexOf('2023–2024');
 const col=(start,filer)=>start+names.slice(start).indexOf(filer);
 const ntIndex=rows.findIndex(r=>r[2]==='Non-target donors');
 const nt=rows[ntIndex],lead=rows.find(r=>r[1]==='Pat');
 assert.equal(roles[ntIndex],'nontarget');assert.equal(rows[ntIndex-1][2],'Acme','right under the lobbyist\'s own donors');
 assert.equal(nt[col(thisCycle,'Fahey')],500);assert.equal(nt[col(prior,'Wagner')],2000);
 assert.equal(nt[kinds.indexOf('Ask')],'');assert.equal(nt[kinds.indexOf('Remaining')],'');
 assert.equal(nt[prior],'','nothing in the candidate\'s own column');
 assert.equal(lead[col(prior,'Fahey')],1000,'Acme');assert.equal(lead[col(prior,'Wagner')],2000,'the whole book');
 assert.equal(lead[col(thisCycle,'Fahey')],500);
 assert.equal(lead[kinds.indexOf('Ask')],2000,'asks are the plan\'s alone');
 // Ticked, the same clients are listed one by one, and the lobbyist's totals do not move.
 const listed=c.planSheetAoa(groups,2026,{listNonTargets:true});
 const listedRow=listed.rows.find(r=>r[2]==='N One Industries');
 assert.ok(listedRow,'the client has its own row');assert.equal(listedRow[3],'Non-target');
 assert.equal(listed.roles[listed.rows.indexOf(listedRow)],'nontarget');
 assert.ok(!listed.rows.some(r=>r[2]==='Non-target donors'),'no summary row when listed');
 assert.equal(listedRow[col(prior,'Wagner')],2000);
 const listedLead=listed.rows.find(r=>r[1]==='Pat');
 assert.deepEqual(Array.from(listedLead),Array.from(lead),'same lobbyist row either way');
 const sheet=c.nonTargetSheetRows(groups,2026);
 assert.equal(sheet.length,1);
 assert.equal(sheet[0].Lobbyist,'Pat');assert.equal(sheet[0]['Non-target donor'],'N One Industries');
 assert.equal(sheet[0]['Total to comparables'],2500);assert.equal(sheet[0]['Fahey 2025–2026'],500);assert.equal(sheet[0]['Wagner 2023–2024'],2000);
});

// A stand-in worksheet and a small evaluator for the formulas the call list
// writes (SUM, MAX, IF, N, +, -, comparison), so the tests can recalculate.
function fakeSheet(rows){
 const cells=new Map();const key=(r,c)=>r+':'+c;
 rows.forEach((row,i)=>row.forEach((v,j)=>{if(v!=='')cells.set(key(i+1,j+1),{value:v});}));
 const cell=(r,c)=>{if(!cells.has(key(r,c)))cells.set(key(r,c),{value:null});return cells.get(key(r,c));};
 return {getRow:r=>({getCell:c=>cell(r,c)}),cell};
}
function colNum(letters){return [...letters].reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0);}
function evaluate(ws,r,c,seen=new Set()){
 const v=ws.cell(r,c).value;
 if(v&&typeof v==='object'&&'formula' in v){
  const id=r+':'+c;if(seen.has(id))throw Error('cycle at '+id);seen.add(id);
  const ref=a=>{const m=/^([A-Z]+)(\d+)$/.exec(a);return evaluate(ws,+m[2],colNum(m[1]),seen);};
  const num=x=>typeof x==='number'?x:0;
  let f=v.formula;
  f=f.replace(/SUM\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)/g,(_,c1,r1,c2,r2)=>{let s=0;for(let rr=+r1;rr<=+r2;rr++)s+=num(evaluate(ws,rr,colNum(c1),seen));return String(s);});
  f=f.replace(/N\(([A-Z]+\d+)\)/g,(_,a)=>String(num(ref(a))));
  f=f.replace(/\b([A-Z]+\d+)\b/g,(_,a)=>{const x=ref(a);return typeof x==='number'?String(x):'0';});
  f=f.replace(/MAX\(/g,'Math.max(').replace(/IF\(([^,]+),/g,'(($1)?').replace(/\?(.*),""\)$/,'?$1:"")');
  return Function('return '+f)();
 }
 return v===null||v===undefined?'':v;
}

test('call list totals are live formulas that reproduce today and follow hand-typed Committed and Given',()=>{
 const {c}=harness();
 vm.runInContext(`lobbyistsById=new Map([[1,{lobbyist_id:1,name:'Pat',kind:'person'}],[2,{lobbyist_id:2,name:'Quinn',kind:'person'}]]);
 window._lobbyAttr=new Map([['a',[{lobbyist:lobbyistsById.get(1),status:'confirmed',is_primary:true,methods:[],client_names:[]}]],
   ['b',[{lobbyist:lobbyistsById.get(1),status:'confirmed',is_primary:true,methods:[],client_names:[]}]],
   ['q',[{lobbyist:lobbyistsById.get(2),status:'confirmed',is_primary:true,methods:[],client_names:[]}]]]);`,c);
 c.window._cycle=2026;c.window._recommendations=[];
 c.window._targetProfile={name:'Friends of Test',top_donors_by_year:{
  2025:[{name:'Jane Doe',donor_id:'p',donor_key:'p',total:300},{name:'Miscellaneous Contributions $100 and under',donor_key:'m',total:90}],
  2026:[{name:'Ghost PAC',donor_id:'h',donor_key:'h',total:4000}]}};
 const t=(donor,key,target,given)=>({donor,donor_key:key,donor_id:key,target,current_cycle_amt:given,remaining:Math.max(0,target-given),cycles:{2026:given},last_cycle_amt:0,comp_max:0,comp_max_filers:[],comp_gifts:[],factors:[]});
 c.window._repeatTargets=[t('Acme','a',2000,500),t('Bolt','b',1000,1500),t('Quill','q',3000,0),t('Jane Doe','p',500,300)];
 c.window._donorTypes=new Map([['p','Individual']]);
 const groups=c.planGroups();
 const aoa=c.planSheetAoa(groups,2026);
 // Ghost PAC gave this cycle, has no ask and no lobbyist: it is on the call list anyway.
 assert.ok(aoa.rows.some(r=>r[2]==='Ghost PAC'),'no-lobbyist donors without an ask still count');
 const ws=fakeSheet(aoa.rows);
 const links=c.liveCallListFormulas(ws,aoa.rows,aoa.roles,aoa.headerRows,aoa.moneyFrom,groups);
 const kinds=aoa.rows[aoa.headerRows-1];
 const [ask,given,committed,rem,delta]=['Ask','Given','Committed','Remaining','Δ vs 2023–2024'].map(k=>kinds.indexOf(k)+1);
 assert.equal(delta,rem-1,'the change on last cycle sits just left of Remaining');
 const at=(label,col)=>{const r=aoa.rows.findIndex(x=>x[1]===label||x[2]===label)+1;return evaluate(ws,r,col);};
 // Every formula recalculates to the number the site computed.
 for(let r=1;r<=aoa.rows.length;r++)for(let col=aoa.moneyFrom+1;col<=kinds.length;col++){
  const v=ws.cell(r,col).value;
  if(v&&typeof v==='object'&&'formula' in v)assert.equal(evaluate(ws,r,col),v.result,`R${r}C${col} ${v.formula}`);
 }
 assert.equal(at('Everyone',given),500+1500+0+4000+300+90,'all the cash: call list, individuals, small gifts');
 assert.equal(at('Other contributions this cycle (not on the call list)',given),390);
 assert.equal(at('Pat',rem),1000,'3,000 asked − 2,000 given, Bolt\'s extra offsetting Acme');
 // Hand edits: a $1,000 pledge to Acme and a new $2,000 gift from Quill.
 const row=label=>aoa.rows.findIndex(x=>x[2]===label)+1;
 ws.cell(row('Acme'),committed).value=1000;
 ws.cell(row('Quill'),given).value=2000;
 assert.equal(at('Acme',rem),500,'2,000 − 500 − 1,000');
 assert.equal(at('Pat',committed),1000);assert.equal(at('Pat',rem),0,'3,000 − 2,000 − 1,000');
 assert.equal(at('Quinn',given),2000);assert.equal(at('Quill',rem),1000);assert.equal(at('Quinn',rem),1000);
 assert.equal(at('Everyone',given),500+1500+2000+4000+300+90);
 assert.equal(at('Everyone',rem),0+1000+0,'lobbyist Remainings added up; no-lobbyist Ghost PAC has none');
 // The change on last cycle follows the edits too: Given + Committed − last cycle.
 assert.equal(at('Acme',delta),500+1000);assert.equal(at('Quill',delta),2000);
 assert.equal(at('Pat',delta),500+1500+1000);
 assert.equal(at('Everyone',delta),at('Everyone',given)+at('Everyone',committed)-evaluate(ws,links.totalRow,kinds.indexOf('This candidate')+1));
 assert.equal(links.totalRow,aoa.headerRows+1);
});
