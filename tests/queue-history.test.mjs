import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../server/store.mjs';
import {appAllowance,requireAllowance} from '../server/send-policy.mjs';
import {createApplication} from '../server/http.mjs';
import {createQueueSync,applyDeliveryJobs} from '../app/application/queue-sync.mjs';
import {mountQueue} from '../app/ui/queue-ui.mjs';

const item=id=>({id,account:'sender',sender:'sender@company.test',recipient:id+'@company.test',subject:'Subject '+id,body:'Body '+id,leadId:id});
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'outreach-history-')),store=openStore(dir);let closed=false;const close=store.close;store.close=()=>{if(!closed){close();closed=true;}};t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {dir,store};}

test('clearing completed history persists without changing active jobs, quotas, delivery tracking or replay protection',t=>{
  const {dir,store}=fixture(t),terminal=['accepted','failed','unknown','cancelled','simulated'];
  store.enqueue([...terminal,'queued','sending'].map(item));
  for(const status of [...terminal,'sending'])store.update(status,status,status==='accepted'?{messageId:'gmail-id'}:null);
  store.set('sending-pause',{reason:'Retain pause'});
  const before=store.jobs(),active=before.filter(job=>['queued','sending'].includes(job.status)),now=Date.now();
  const allowance=appAllowance(before,'sender',now);
  assert.throws(()=>store.clearHistory([...terminal,'queued']),/Only completed/);
  assert.ok(store.jobs().every(job=>!job.history_cleared_at));
  assert.deepEqual(store.clearHistory(terminal),{cleared:5});
  const after=store.jobs();
  assert.ok(after.filter(job=>terminal.includes(job.id)).every(job=>job.history_cleared_at));
  assert.deepEqual(after.filter(job=>['queued','sending'].includes(job.status)),active);
  assert.deepEqual(appAllowance(after,'sender',now),allowance);
  assert.throws(()=>requireAllowance(after,'sender',allowance.remaining+1,now),/remaining/);
  assert.deepEqual(store.get('sending-pause'),{reason:'Retain pause'});
  assert.deepEqual(store.clearHistory(terminal),{cleared:0});
  assert.throws(()=>store.enqueue([{...item('new'),recipient:item('accepted').recipient}]),/already recorded/);
  assert.throws(()=>store.enqueue([{...item('accepted'),directId:'accepted'}]),/UNIQUE/);
  const leads=[{lead_id:'accepted',email:item('accepted').recipient,company:'Lead',draft:{body:'Saved draft'}}];
  assert.equal(applyDeliveryJobs(leads,after)[0].live_delivery.status,'accepted');
  assert.equal(applyDeliveryJobs(leads,after)[0].draft.body,'Saved draft');
  store.close();const reopened=openStore(dir);
  try{assert.ok(reopened.jobs().filter(job=>terminal.includes(job.id)).every(job=>job.history_cleared_at));assert.equal(reopened.jobs().length,7);}finally{reopened.close();}
});

test('history clear workflow refreshes tracking and propagates failed requests without changing local records',async()=>{
  const calls=[],jobs=[{...item('accepted'),payload:item('accepted'),status:'accepted',updated:'2026-01-01',history_cleared_at:'2026-01-02'}];let rows=[{lead_id:'accepted',email:item('accepted').recipient,company:'Lead'}],fail=false;
  const sync=createQueueSync({getLeads:()=>rows,save:next=>{rows=next;return true;},api:async(path,value)=>{calls.push({path,value});if(fail)throw Error('Storage full');return {jobs};}});
  assert.deepEqual(await sync.clearHistory(['accepted']),jobs);
  assert.equal(rows[0].live_delivery.status,'accepted');
  assert.deepEqual(calls.map(call=>call.path),['/api/live/history/clear','/api/live/jobs']);
  assert.deepEqual(calls[0].value,{ids:['accepted']});fail=true;const before=rows;
  await assert.rejects(sync.clearHistory(['accepted']),/Storage full/);assert.equal(rows,before);
});

test('history clear endpoint enforces CSRF and rejects active records atomically',async t=>{
  const {store}=fixture(t);let origin;
  store.enqueue([item('accepted'),item('queued')]);store.update('accepted','accepted');
  const server=createApplication({root:fileURLToPath(new URL('../',import.meta.url)),origin:()=>origin,store,provider:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],{csrf}=await session.json();
  const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf};
  const post=(ids,h=headers)=>fetch(origin+'/api/live/history/clear',{method:'POST',headers:h,body:JSON.stringify({ids})});
  assert.equal((await post(['accepted'],{...headers,'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await post(['accepted','queued'])).status,400);assert.ok(store.jobs().every(job=>!job.history_cleared_at));
  assert.deepEqual(await (await post(['accepted'])).json(),{cleared:1});
  assert.equal(store.jobs().find(job=>job.id==='queued').status,'queued');
});

test('Clear history confirms, preserves active/newer records and ignores stale refresh responses',async()=>{
  const previousDocument=globalThis.document,previousConfirm=globalThis.confirm,previousInterval=globalThis.setInterval,elements=new Map();
  function element(){return {disabled:false,textContent:'',html:'',open:false,showModal(){this.open=true;},close(){this.open=false;},set innerHTML(html){this.html=html;for(const match of html.matchAll(/id="([^"]+)"/g))elements.set(match[1],element());}};}
  elements.set('live-jobs',element());globalThis.document={getElementById:id=>elements.get(id),createElement:element,body:{append(){}}};globalThis.setInterval=()=>0;
  const job=(id,status)=>({id,status,payload:item(id),recipient:item(id).recipient,updated:'2026-01-01'});
  let jobs=[job('done','accepted'),job('pending','queued')],clears=0,fail=false,delay=false,resolveOld;
  const snapshot=()=>structuredClone(jobs);
  try{
    mountQueue({escape:String,queueSync:{refresh:async()=>delay?new Promise(resolve=>{resolveOld=resolve;}):snapshot(),clearHistory:async ids=>{clears++;if(fail)throw Error('Could not save history change');jobs=jobs.map(job=>ids.includes(job.id)?{...job,history_cleared_at:'now'}:job);return snapshot();}}});
    await elements.get('live-jobs').onclick();
    globalThis.confirm=()=>false;await elements.get('clear-live-history').onclick();assert.equal(clears,0);
    globalThis.confirm=()=>true;fail=true;await elements.get('clear-live-history').onclick();
    assert.match(elements.get('live-jobs-message').textContent,/Could not save/);assert.match(elements.get('live-jobs-content').html,/Subject done/);
    fail=false;delay=true;const old=snapshot(),pendingRefresh=elements.get('refresh-live-jobs').onclick();
    globalThis.confirm=()=>{jobs.push(job('newly-finished','accepted'));return true;};
    await elements.get('clear-live-history').onclick();
    assert.doesNotMatch(elements.get('live-jobs-content').html,/Subject done/);
    assert.match(elements.get('live-jobs-content').html,/Subject pending/);assert.match(elements.get('live-jobs-content').html,/Subject newly-finished/);
    resolveOld(old);await pendingRefresh;assert.doesNotMatch(elements.get('live-jobs-content').html,/Subject done/);
    globalThis.confirm=()=>true;await elements.get('clear-live-history').onclick();
    assert.equal(elements.get('clear-live-history').disabled,true);assert.match(elements.get('live-jobs-content').html,/No delivery history to show/);
  }finally{globalThis.document=previousDocument;globalThis.confirm=previousConfirm;globalThis.setInterval=previousInterval;}
});
