const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function harness(){
 const elements=new Map();
 const document={addEventListener(){},getElementById(id){if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',hidden:false,querySelectorAll:()=>[]});return elements.get(id);}};
 const c=vm.createContext({document,console,setTimeout,clearTimeout});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../docs/explore.js'),'utf8'),c);
 return {c,elements,document};
}
test('browse restores both source names with one bounded primary-key lookup',async()=>{
 const {c}=harness();let calls=0;
 const sb={from(table){assert.equal(table,'transactions');return {select(cols){assert.match(cols,/filer_id/);return {async in(key,ids){calls++;assert.equal(key,'tran_id');assert.deepEqual(Array.from(ids),[4957470]);return {data:[{tran_id:4957470,filer:'Elect Zach Hudson',filer_id:'17995',contributor_payee:'Oregon Trial Lawyers Association PAC (39)',donor_id:'c39'}]};}};}};}};
 const result=await c.completeTransactionNames(sb,[{tran_id:4957470,filer_canonical:null,contributor_payee_canonical:null,amount:1000},{tran_id:2,filer_canonical:'Other committee',contributor_payee_canonical:'Other donor'}],{donor_id:'c39',display_name:'Oregon Trial Lawyers Association PAC'});
 assert.equal(calls,1);assert.equal(result[0].filer_canonical,'Elect Zach Hudson');assert.equal(result[0].contributor_payee_canonical,'Oregon Trial Lawyers Association PAC');assert.equal(result[0].amount,1000);
 assert.equal(result[0].contributor_payee,'Oregon Trial Lawyers Association PAC (39)');assert.equal(result[1].filer_canonical,'Other committee');
});
test('complete rows require no source query; whitespace labels fall back safely and preserve CSV source fields',async()=>{
 const {c}=harness();
 await c.completeTransactionNames({from(){throw Error('unnecessary query');}},[{filer_canonical:'Committee',contributor_payee_canonical:'Donor'}]);
 const row=c.transactionNames({filer_canonical:'  ',filer:'Source Committee',contributor_payee_canonical:'\t',contributor_payee:'Original Donor',donor_id:'other'},{donor_id:'c39',display_name:'Wrong Donor'});
 assert.equal(row.filer_canonical,'Source Committee');assert.equal(row.contributor_payee_canonical,'Original Donor');assert.equal(row.contributor_payee,'Original Donor');
 assert.equal(c.transactionNames({filer_id:'123'}).filer_canonical,'Committee 123');assert.equal(c.transactionNames({}).contributor_payee_canonical,'Not reported');
});
test('adopted spelling applies to fallback names and recovered HTML is escaped',()=>{
 const {c,document}=harness();c.DN={display:s=>s==='At&T'?'AT&T':s};
 const row=c.transactionNames({filer:'<script>bad</script>',contributor_payee:'At&T'});
 assert.equal(row.contributor_payee_canonical,'AT&T');c.renderTable([row]);
 assert.match(document.getElementById('xp-tbody').innerHTML,/&lt;script&gt;/);assert.doesNotMatch(document.getElementById('xp-tbody').innerHTML,/<script>/);
});
test('source-name lookup errors are surfaced rather than silently showing blank cells',async()=>{
 const {c}=harness();const sb={from:()=>({select:()=>({in:async()=>({error:{message:'failed'}})})})};
 await assert.rejects(c.completeTransactionNames(sb,[{tran_id:1}]),/Could not load transaction names: failed/);
});
test('filtered CSV fills display columns while retaining original transaction names',async()=>{
 const {c,document}=harness();let downloaded;
 const source={tran_id:1,filer:'Source Committee',filer_canonical:null,contributor_payee:'Original PAC (39)',contributor_payee_canonical:null,donor_id:'c39',amount:500};
 c.getSupabase=async()=>({from:()=>({select:()=>({order:()=>({range:async()=>({data:[source]})})})})});
 c.triggerDownload=(csv,mime,name)=>{downloaded={csv,mime,name};};
 await c.downloadFiltered();
 assert.match(downloaded.csv,/Source Committee,Source Committee,Original PAC \(39\),Original PAC \(39\)/);
 assert.equal(downloaded.name,'orestar_filtered.csv');assert.equal(source.filer_canonical,null);
 assert.equal(document.getElementById('xp-status').textContent,'Downloaded 1 rows.');
});
