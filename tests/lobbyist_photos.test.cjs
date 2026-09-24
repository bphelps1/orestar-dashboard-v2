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
 // No Photo column: B is the lobbyist, and this cycle's Ask, Given, Remaining sit in J, K, L.
 assert.equal(ws.getCell('B5').value,'Lobbyist or firm');
 assert.deepEqual([ws.getCell('J7').value,ws.getCell('K7').value,ws.getCell('L7').value],['Ask','Given','Remaining']);
 assert.deepEqual([ws.getCell('J8').value,ws.getCell('K8').value,ws.getCell('L8').value],[1000,250,750]);
 assert.equal(ws.getImages().length,0,'no portraits on the call list');
 // Remaining stands apart: its own header colour, a tinted column, red while money is owed.
 assert.equal(ws.getCell('L7').fill.fgColor.argb,INK.remainingHead);
 assert.equal(ws.getCell('L10').fill.fgColor.argb,INK.remaining);
 assert.equal(ws.getCell('L10').value,750);assert.equal(ws.getCell('L10').font.color.argb,INK.owed);
 assert.equal(ws.getRow(10).hidden,true,'a lobbyist\'s donors still collapse under the lobbyist');assert.equal(ws.getRow(10).outlineLevel,1);
 const reread=new BrowserExcelJS.Workbook();await reread.xlsx.load(await wb.xlsx.writeBuffer());const saved=reread.getWorksheet('Call list');
 assert.equal(saved.getImages().length,0);assert.equal(saved.getRow(10).hidden,true);assert.equal(saved.getCell('L8').value,750);
 assert.equal(saved.getCell('L10').font.color.argb,INK.owed);
 // An ask already met reads as a green $0, not a blank.
 const met={...g,rows:[{...g.rows[0],given:1200,remaining:0}],given:1200,remaining:0};
 const metSheet=await c.writeCallList(new BrowserExcelJS.Workbook(),[met],2026);
 assert.equal(metSheet.getCell('L10').value,0);assert.equal(metSheet.getCell('L10').font.color.argb,INK.met);
 // Donors with no lobbyist are listed as they are, not collapsed into a line
 // that makes the sheet look empty.
 const none={...g,lobbyist:null,tier:{label:'',why:'',tier:4}};
 const noneSheet=await c.writeCallList(new BrowserExcelJS.Workbook(),[none],2026);
 assert.equal(noneSheet.getRow(9).getCell(2).value,'(nobody on file — assign these at /admin/lobbyists)');
 assert.equal(noneSheet.getRow(10).hidden,false);assert.equal(noneSheet.getRow(10).getCell(3).value,'Test organization');
 const firm={kind:'firm',name:'Example Firm',firm_primary_id:1,firm_member_ids:[1]};
 const firmBook=new BrowserExcelJS.Workbook();
 const firmSheet=await c.writeCallList(firmBook,[{...g,lobbyist:firm}],2026);
 assert.equal(firmSheet.getCell('B9').value.richText.map(r=>r.text).join(''),person.name+'\nExample Firm');
 assert.equal(firmSheet.getImages().length,0);
 const savedFirm=new BrowserExcelJS.Workbook();await savedFirm.xlsx.load(await firmBook.xlsx.writeBuffer());
 assert.equal(savedFirm.getWorksheet('Call list').getCell('B9').value.richText.map(r=>r.text).join(''),person.name+'\nExample Firm');
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
