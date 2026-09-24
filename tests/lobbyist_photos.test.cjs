const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),vm=require('vm'),path=require('path');
const root=path.resolve(__dirname,'..');
const entry={name:'Jane Example',path:'assets/lobbyist-photos/user-1-123456abcdef.jpg',profile:'https://oregoncapitolclub.org/user/?type=user&search=Jane'};
function harness(fetch){const c=vm.createContext({window:{},document:{addEventListener(){}},console,fetch,AbortSignal,Uint8Array,setTimeout,clearTimeout});vm.runInContext(fs.readFileSync(path.join(root,'docs/lib/lobbyist-photos.js'),'utf8')+'\nglobalThis.photos=LP;',c);return c;}
test('directory IDs and unique exact names resolve portraits; ambiguous names and firms do not',async()=>{
 const c=harness(async()=>({ok:true,json:async()=>({version:1,photos:{'user-1':entry,'user-2':{...entry,name:'Other Person',path:'assets/lobbyist-photos/user-2-123456abcdef.jpg'},'user-3':{...entry,name:'Other Person',path:'assets/lobbyist-photos/user-3-123456abcdef.jpg'}}})}));await c.photos.load();
 assert.equal(c.photos.get({cc_id:'user-1',name:'Renamed',kind:'person'}).name,'Jane Example');
 assert.equal(c.photos.get({name:' JANE  EXAMPLE '}).name,'Jane Example');assert.equal(c.photos.get({name:'Other Person'}),null);
 assert.equal(c.photos.get({name:'Jane Example',cc_id:'user-99'}),null);assert.equal(c.photos.get({name:'Jane Example',kind:'firm'}),null);
 assert.equal(c.photos.get({name:'Jane'}),null);
});
test('remote and injected paths are rejected; image failure is optional and recoverable',async()=>{
 let fail=true;const c=harness(async url=>url.endsWith('.json')?{ok:true,json:async()=>({version:1,photos:{'user-1':entry,'user-2':{...entry,name:'Unsafe',path:'https://evil.example/1.jpg'}}})}:{ok:!fail,arrayBuffer:async()=>new Uint8Array([255,216,255,217]).buffer});
 await c.photos.load();assert.equal(c.photos.get({name:'Unsafe'}),null);assert.equal(await c.photos.image({cc_id:'user-1'}),null);
 fail=false;assert.equal((await c.photos.image({cc_id:'user-1'})).data.length,4);
});
test('catalog outages and non-JPEG image responses do not block the page',async()=>{
 const c=harness(async()=>{throw Error('offline')});await c.photos.load();assert.equal(c.photos.get({cc_id:'user-1'}),null);
 const d=harness(async url=>url.endsWith('.json')?{ok:true,json:async()=>({version:1,photos:{'user-1':entry}})}:{ok:true,arrayBuffer:async()=>new Uint8Array([60,104,116,109,108]).buffer});await d.photos.load();assert.equal(await d.photos.image({cc_id:'user-1'}),null);
});
test('firm portrait uses only its designated lead and app escapes photo labels',()=>{
 const c=harness();vm.runInContext(fs.readFileSync(path.join(root,'docs/recommend.js'),'utf8'),c);
 vm.runInContext('lobbyistsById=new Map([[7,{lobbyist_id:7,name:"Jane Example",kind:"person"}]])',c);
 assert.equal(c.portraitPerson({kind:'firm',firm_primary_id:7}).name,'Jane Example');
 assert.equal(c.portraitPerson({kind:'firm',firm_member_ids:[7]}),null);
 assert.match(c.portraitMarkup(null),/Photo unavailable/);
 const header=c.lobbyistHeaderText({kind:'firm',name:'Example & Partners',firm_primary_id:7,firm_member_ids:[7]});
 assert.match(header,/<div class="plan-lobbyist">Jane Example<\/div><div class="plan-contact">Example &amp; Partners<\/div>/);
 const noLead=c.lobbyistHeaderText({kind:'firm',name:'No lead firm',firm_member_ids:[7]});
 assert.match(noLead,/<div class="plan-lobbyist">No lead firm/);

});
let ExcelJS;try{ExcelJS=require(process.env.EXCELJS_MODULE||'exceljs')}catch{}
test('the candidate call list carries no portraits, colours Remaining, and lists unassigned donors', {skip:!ExcelJS}, async()=>{
 const catalog=JSON.parse(fs.readFileSync(path.join(root,'docs/assets/lobbyist-photos.json')));const [cc_id,photo]=Object.entries(catalog.photos)[0];
 const c=harness(async url=>url.endsWith('.json')?{ok:true,json:async()=>catalog}:{ok:true,arrayBuffer:async()=>{const b=fs.readFileSync(path.join(root,'docs',url));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)}});
 vm.runInContext(fs.readFileSync(path.join(root,'docs/lib/lobbyists.js'),'utf8')+fs.readFileSync(path.join(root,'docs/recommend.js'),'utf8'),c);await c.photos.load();
 const person={lobbyist_id:1,kind:'person',cc_id,name:photo.name};c.person=person;vm.runInContext('lobbyistsById=new Map([[1,person]])',c);
 c.window._targetProfile={name:'Test committee'};
 const g={lobbyist:person,rows:[{donor:'Test organization',donor_key:'a',target:1000,given:250,remaining:750,cycles:{2024:500},contacts:[],also:[]}],tier:{label:'Tier 1',why:'fixture',tier:1},target:1000,given:250,remaining:750,last_cycle:500};
 // Use the browser bundle in the same realm as the page (ExcelJS checks
 // native arrays when assigning row values).
 c.TextEncoder=TextEncoder;c.TextDecoder=TextDecoder;c.Blob=Blob;c.Buffer=Buffer;
 vm.runInContext(fs.readFileSync(process.env.EXCELJS_MODULE || require.resolve('exceljs/dist/exceljs.min.js'),'utf8'),c);
 const BrowserExcelJS=c.window.ExcelJS;
 const INK=vm.runInContext('INK',c);   // a top-level const: not a sandbox property
 const wb=new BrowserExcelJS.Workbook();const ws=await c.writeCallList(wb,[g],2026);
 const res=v=>v&&typeof v==='object'&&'result' in v?v.result:v;
 // The team's layout: headers from row 1, Everyone on row 4 and frozen with them;
 // B lobbyist, C tier, D donor; this cycle's Ask, Given, Committed, change on last cycle, Remaining in H to L.
 assert.deepEqual(['B1','C1','D1','E1','F1'].map(a=>ws.getCell(a).value),['Lobbyist or firm','Tier','Donor','Email','Phone']);
 assert.deepEqual(['H3','I3','J3','K3','L3'].map(a=>ws.getCell(a).value),['Ask','Given','Committed','Δ vs 2023–2024','Remaining']);
 assert.equal(ws.getCell('N3').value,'This candidate','last cycle, where the change is measured from');
 assert.equal(ws.views[0].ySplit,4);assert.equal(ws.views[0].xSplit,1);
 assert.equal(ws.getCell('B4').value,'Everyone');
 assert.deepEqual(['H4','I4','L4'].map(a=>res(ws.getCell(a).value)),[1000,250,750]);
 assert.equal(ws.getImages().length,0,'no portraits on the call list');
 // Live totals: Everyone adds up the lobbyist rows, a lobbyist sums its donors,
 // Remaining takes Given and Committed off the Ask.
 assert.deepEqual(['H4','I4','J4','L4'].map(a=>ws.getCell(a).value.formula),['H5','I5','J5','L5']);
 assert.equal(ws.getCell('H5').value.formula,'SUM(H6:H6)');assert.equal(ws.getCell('J5').value.formula,'SUM(J6:J6)');
 assert.equal(ws.getCell('L5').value.formula,'MAX(0,H5-I5-J5)');assert.equal(res(ws.getCell('L5').value),750);
 assert.equal(ws.getCell('L6').value.formula,'IF(N(H6)>0,MAX(0,H6-N(I6)-N(J6)),"")');assert.equal(res(ws.getCell('L6').value),750);
 // The change on last cycle: Given + Committed − last cycle, on every row.
 assert.equal(ws.getCell('K6').value.formula,'N(I6)+N(J6)-N(N6)');assert.equal(res(ws.getCell('K6').value),-250);
 assert.equal(ws.getCell('K5').value.formula,'N(I5)+N(J5)-N(N5)');assert.equal(ws.getCell('K4').value.formula,'N(I4)+N(J4)-N(N4)');
 assert.equal(ws.getCell('K6').numFmt,'+"$"#,##0;-"$"#,##0;');
 assert.ok([null,''].includes(ws.getCell('J6').value),'Committed is left for the team to fill in');
 // Remaining stands apart: its own header colour and a tinted column; red and green are conditional.
 assert.equal(ws.getCell('L3').fill.fgColor.argb,INK.remainingHead);
 assert.equal(ws.getCell('J3').fill.fgColor.argb,INK.head,'Committed keeps the ordinary header');
 assert.equal(ws.getCell('L6').fill.fgColor.argb,INK.remaining);
 const colours=sheet=>sheet.conditionalFormattings.find(f=>f.ref.startsWith('L')).rules;
 const deltaColours=ws.conditionalFormattings.find(f=>f.ref.startsWith('K')).rules;
 assert.ok(deltaColours.some(r=>r.operator==='lessThan'&&r.style.font.color.argb===INK.owed),'behind last cycle is red');
 assert.ok(deltaColours.some(r=>r.operator==='greaterThan'&&r.style.font.color.argb===INK.met),'ahead is green');
 assert.ok(colours(ws).some(r=>r.operator==='greaterThan'&&r.style.font.color.argb===INK.owed));
 assert.ok(colours(ws).some(r=>r.operator==='equal'&&r.style.font.color.argb===INK.met));
 // One grey for every lobbyist row; donors grouped under it but open.
 assert.equal(ws.getCell('B5').fill.fgColor.argb,INK.lobbyist);assert.equal(INK.lobbyist,'FFEFEFEF');
 assert.equal(ws.getCell('C5').value,'Tier 1');assert.equal(ws.getCell('D6').value,'Test organization');
 assert.equal(ws.getRow(6).hidden,false);assert.equal(ws.getRow(6).outlineLevel,1);
 const reread=new BrowserExcelJS.Workbook();await reread.xlsx.load(await wb.xlsx.writeBuffer());const saved=reread.getWorksheet('Call list');
 assert.equal(saved.getImages().length,0);assert.equal(saved.getRow(6).outlineLevel,1);
 assert.equal(saved.getCell('L4').value.formula,'L5');assert.equal(res(saved.getCell('L4').value),750);
 assert.equal(saved.getCell('L6').value.formula,'IF(N(H6)>0,MAX(0,H6-N(I6)-N(J6)),"")');
 assert.equal(saved.getCell('K6').value.formula,'N(I6)+N(J6)-N(N6)');
 assert.ok(colours(saved).some(r=>r.operator==='greaterThan'&&r.style.font.color.argb===INK.owed),'colours survive a save');
 // An ask already met reads $0 (green by the conditional format), not a blank.
 const met={...g,rows:[{...g.rows[0],given:1200,remaining:0}],given:1200,remaining:0};
 const metSheet=await c.writeCallList(new BrowserExcelJS.Workbook(),[met],2026);
 assert.equal(res(metSheet.getCell('L6').value),0);assert.equal(res(metSheet.getCell('L5').value),0);
 // Donors with no lobbyist are listed as they are.
 const none={...g,lobbyist:null,tier:{label:'',why:'',tier:4}};
 const noneSheet=await c.writeCallList(new BrowserExcelJS.Workbook(),[none],2026);
 assert.equal(noneSheet.getRow(5).getCell(2).value,'(nobody on file — assign these at /admin/lobbyists)');
 assert.equal(noneSheet.getRow(6).hidden,false);assert.equal(noneSheet.getRow(6).getCell(4).value,'Test organization');
 assert.equal(noneSheet.getCell('L5').value.formula,'SUM(L6:L6)','no target of its own: the rows\' Remaining, added up');
 const firm={kind:'firm',name:'Example Firm',firm_primary_id:1,firm_member_ids:[1]};
 const firmBook=new BrowserExcelJS.Workbook();
 const firmSheet=await c.writeCallList(firmBook,[{...g,lobbyist:firm}],2026);
 assert.equal(firmSheet.getCell('B5').value.richText.map(r=>r.text).join(''),person.name+'\nExample Firm');
 assert.equal(firmSheet.getImages().length,0);
 const savedFirm=new BrowserExcelJS.Workbook();await savedFirm.xlsx.load(await firmBook.xlsx.writeBuffer());
 assert.equal(savedFirm.getWorksheet('Call list').getCell('B5').value.richText.map(r=>r.text).join(''),person.name+'\nExample Firm');
 const flat=c.writeTable(firmBook,'Lobbyists',[{Tier:'Tier 1','Lobbyist / Firm':firm.name}],{note:'fixture'});
 c.writeFirmName(flat,firm,4,2);
 assert.equal(flat.getCell('B4').value.richText[0].text,person.name);
 assert.equal(typeof c.writeContactPhotos,'undefined','the Contact photos sheet is gone');
});

test('reviewed official-site portraits match stable contact IDs, including contacts with directory placeholders',async()=>{
 const official={name:'Official Contact',path:'assets/lobbyist-photos/lobbyist-42-123456abcdef.jpg',profile:'https://example.org/team/contact'};
 const c=harness(async()=>({ok:true,json:async()=>({version:1,photos:{'lobbyist-42':official,'user-1':entry}})}));
 await c.photos.load();
 assert.equal(c.photos.get({lobbyist_id:42,cc_id:'user-99',name:'Official Contact'}).path,official.path);
 assert.equal(c.photos.get({lobbyist_id:43,name:'Someone Else'}),null);
 assert.equal(c.photos.get({lobbyist_id:42,kind:'firm'}),null);
 assert.equal(c.photos.get({cc_id:'user-1'}).path,entry.path);
});
