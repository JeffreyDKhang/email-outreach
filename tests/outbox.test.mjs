import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../server/store.mjs';
import {createApplication} from '../server/http.mjs';
import {prepareHeldMessages,prepareOutboxSend,prepareInstantSend} from '../server/outbox.mjs';
import {createQueue} from '../server/sending.mjs';
import {generateDraft,editDraft} from '../app/domain/outreach.mjs';
import {genericDefaults} from '../app/domain/scoring.mjs';
import {filterOutbox,outboxFields} from '../app/domain/outbox.mjs';
import {editLeadField} from '../app/domain/lead-edit.mjs';
import {createOutboxService} from '../app/application/outbox.mjs';

const rules=structuredClone(genericDefaults),account={id:'sender',email:'sender@company.test',provider:'gmail'};
function lead(){return generateDraft({messageWorkflow:2,lead_id:'one',company:'Company',email:'recipient@company.test',recipient_column:'Email',values:{Name:'Ada',Email:'recipient@company.test',Team:'Sales'}},{General:{subject:'Hi',body:'First message'}},'merge',rules);}
function request(rows=[lead()]){return {requestId:crypto.randomUUID(),leads:rows,rules,datasetId:'dataset',datasetName:'Test list'};}
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'email-outbox-')),store=openStore(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return store;}

test('Outbox freezes multiple variations without approval and never sends while held',async t=>{
  const store=fixture(t),original=lead(),variant=editDraft(original,'Another subject','Second message');
  const input=request([original,variant]),prepared=prepareHeldMessages(input);
  const result=store.addHeld(prepared);assert.equal(result.ids.length,2);
  assert.equal(store.jobs().length,0);
  let sent=0;await createQueue({store,provider:{sendMessage:async()=>{sent++;}}}).tick();assert.equal(sent,0);
  original.draft.body='Later edit';original.values.Team='Changed';
  assert.equal(store.outbox().find(message=>message.id===result.ids[0]).payload.body,'First message');
  assert.equal(store.outbox()[0].payload.source.Team,'Sales');
  assert.deepEqual(store.addHeld(prepared),result);assert.equal(store.outbox().length,2);
  assert.throws(()=>store.addHeld({...prepared,digest:'different'}),/different/);
  store.assignBatch(result.ids,'batch','First campaign');
  assert.equal(store.jobs().length,0);
  assert.ok(store.outbox().every(message=>message.batch_name==='First campaign'));
  assert.equal(filterOutbox(store.outbox(),[{key:'source:Team',value:'sales'},{key:'subject',value:'Another'}]).length,1);
  assert.ok(outboxFields(store.outbox()).some(field=>field.key==='source:Name'));
});

test('one message copy queues once; different copies may share a recipient and keep immutable history',async t=>{
  const store=fixture(t),rows=[lead(),editDraft(lead(),'Other','Variation')];
  const {ids}=store.addHeld(prepareHeldMessages(request(rows)));
  const preview=prepareOutboxSend(store.outbox(),ids,account,store.jobs());
  store.enqueueHeld(preview.items);assert.equal(store.jobs().length,2);
  assert.throws(()=>store.enqueueHeld(preview.items),/held/);
  assert.throws(()=>store.assignBatch(ids,'new','Changed'),/held/);
  assert.throws(()=>store.removeHeld(ids),/held/);
  const sent=[];const worker=createQueue({store,provider:{sendMessage:async payload=>{sent.push(payload);return {status:'accepted',messageId:'gmail-'+payload.id};}}});
  await worker.tick();await worker.tick();assert.equal(sent.length,2);
  assert.equal(new Set(sent.map(message=>message.recipient)).size,1);
  assert.ok(store.jobs().every(job=>job.status==='accepted'));
  const third=store.addHeld(prepareHeldMessages(request()));
  store.enqueueHeld(prepareOutboxSend(store.outbox(),third.ids,account,store.jobs()).items);
  assert.equal(store.jobs().length,3);
});

test('preview requires a sender, blocks synthetic delivery, and stale capacity is atomic',t=>{
  const store=fixture(t);const {ids}=store.addHeld(prepareHeldMessages(request()));
  assert.throws(()=>prepareOutboxSend(store.outbox(),ids,null,[]),/Connect/);
  assert.throws(()=>prepareOutboxSend(store.outbox(),[...ids,...ids],account,[]),/distinct/);
  const preview=prepareOutboxSend(store.outbox(),ids,account,[]);
  const occupied=Array.from({length:500},(_,index)=>({id:'job-'+index,outboxId:'old-'+index,account:account.id,recipient:'same@company.test'}));
  store.enqueue(occupied);
  assert.throws(()=>store.enqueueHeld(preview.items),/allowance/);
  assert.equal(store.outbox()[0].status,'held');assert.equal(store.jobs().length,500);
  const synthetic=store.addHeld(prepareHeldMessages(request([{...lead(),data_origin:'synthetic'}])));
  assert.throws(()=>prepareOutboxSend(store.outbox(),synthetic.ids,account,[]),/Synthetic/);
  const invalid=lead();invalid.draft.subject='Header\nInjection';assert.throws(()=>prepareHeldMessages(request([invalid])),/Invalid subject/);
});

test('database migration retains old job snapshots and allows new recipient variations',t=>{
  const directory=mkdtempSync(join(tmpdir(),'outbox-migration-'));let store=openStore(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  store.enqueue([{id:'legacy',account:account.id,recipient:'recipient@company.test',body:'Historical copy'}]);
  store.db.exec(`ALTER TABLE jobs RENAME TO jobs_temp;
    CREATE TABLE jobs(id TEXT PRIMARY KEY,account TEXT NOT NULL,recipient TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,result TEXT,created TEXT NOT NULL,updated TEXT NOT NULL,attempted_at TEXT,UNIQUE(account,recipient));
    INSERT INTO jobs SELECT id,account,recipient,payload,status,result,created,updated,attempted_at FROM jobs_temp;DROP TABLE jobs_temp;`);
  const old=store.jobs()[0];
  const heldBefore=store.addHeld(prepareHeldMessages(request()));store.assignBatch(heldBefore.ids,'survives','Persistent batch');
  // Reopening is covered without touching any real application state.
  const row=store.db.prepare("SELECT sql FROM sqlite_master WHERE name='jobs'").get();assert.match(row.sql,/UNIQUE/);
  const path=store.db.prepare('PRAGMA database_list').all()[0].file;
  store.close();
  const reopened=openStore(directory);store=reopened;
  assert.equal(reopened.jobs()[0].payload.body,old.payload.body);
  assert.equal(reopened.outbox()[0].batch_name,'Persistent batch');assert.equal(reopened.outbox()[0].status,'held');
  const held=reopened.addHeld(prepareHeldMessages(request()));
  reopened.enqueueHeld(prepareOutboxSend(reopened.outbox(),held.ids,account,reopened.jobs()).items);
  assert.equal(reopened.jobs().length,2);
});

test('HTTP Outbox workflow uses CSRF, immutable preview, atomic queueing and no automatic hold delivery',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'outbox-http-')),store=openStore(directory);let origin;
  const server=createApplication({root:fileURLToPath(new URL('../',import.meta.url)),origin:()=>origin,store,provider:{getAccount:()=>account}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(directory,{recursive:true,force:true});});
  const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],{csrf}=await session.json();
  const headers={Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf,Origin:origin};
  const post=(path,data,h=headers)=>fetch(origin+path,{method:'POST',headers:h,body:JSON.stringify(data)});
  assert.equal((await post('/api/outbox/add',request(),{...headers,'X-CSRF-Token':'wrong'})).status,403);
  const input=request([lead(),editDraft(lead(),'Variation','Second')]);
  const added=await (await post('/api/outbox/add',input)).json();
  assert.deepEqual(await (await post('/api/outbox/add',input)).json(),added);
  assert.equal(store.jobs().length,0);
  assert.equal((await post('/api/outbox/batch',{ids:added.ids,name:'Batch A'})).status,200);
  const preview=await (await post('/api/outbox/preview',{ids:added.ids})).json();
  assert.equal((await post('/api/live/enqueue',{id:preview.id,digest:'tampered'})).status,400);
  assert.equal(store.jobs().length,0);
  assert.equal((await post('/api/live/enqueue',{id:preview.id,digest:preview.digest})).status,200);
  assert.equal(store.jobs().length,2);
  assert.equal((await post('/api/live/enqueue',{id:preview.id,digest:preview.digest})).status,400);
  assert.equal((await post('/api/outbox/preview',{ids:added.ids})).status,400);
  const instant=await (await post('/api/instant/preview',request())).json();
  assert.equal(instant.kind,'instant');assert.equal(store.jobs().length,2);
  assert.equal(store.outbox().length,2);
  assert.equal((await post('/api/live/enqueue',{id:instant.id,digest:instant.digest})).status,200);
  assert.equal(store.jobs().length,3);assert.equal(store.outbox().length,2);

});

test('uncertain Add to Outbox retries reuse the request ID; deliberate next add gets a new one',async()=>{
  const ids=[];let fail=true;
  const service=createOutboxService({getDataset:()=>({id:'data',name:'List',rules}),api:async(path,value)=>{ids.push(value.requestId);if(fail)throw Error('Lost response');return {ids:['one']};}});
  await assert.rejects(service.add([lead()]));fail=false;await service.add([lead()]);assert.equal(ids[0],ids[1]);
  await service.add([lead()]);assert.notEqual(ids[1],ids[2]);
});

test('editing a previously contacted lead prepares new variations without changing held history',t=>{
  const store=fixture(t),original={...lead(),live_delivery:{status:'accepted'},outbox:[{body:'Legacy simulated snapshot'}]};
  const held=store.addHeld(prepareHeldMessages(request([original])));
  const changed=editLeadField(original,'csv:Name','Grace');
  assert.equal(changed.values.Name,'Grace');
  const reset=generateDraft(changed,{General:{subject:'New subject',body:'New message'}},'merge',rules);
  store.addHeld(prepareHeldMessages(request([reset])));
  assert.equal(store.outbox().find(message=>message.id===held.ids[0]).payload.body,'First message');
  assert.equal(original.outbox[0].body,'Legacy simulated snapshot');
});

test('instant preview creates no held/queued records until confirmation and uses message-level replay protection',t=>{
  const store=fixture(t),input=request([lead(),editDraft(lead(),'Variation','Another message')]);
  const preview=prepareInstantSend(input,account,store.jobs());
  assert.equal(preview.kind,'instant');assert.equal(store.outbox().length,0);assert.equal(store.jobs().length,0);
  assert.ok(preview.items.every(item=>item.directId&&!item.outboxId));
  assert.deepEqual(prepareInstantSend(input,account,[]).items.map(item=>item.id),preview.items.map(item=>item.id));
  store.enqueue(preview.items);assert.equal(store.jobs().length,2);assert.equal(store.outbox().length,0);
  assert.throws(()=>store.enqueue(preview.items),/UNIQUE/);assert.equal(store.jobs().length,2);
  store.enqueue(prepareInstantSend(request([lead()]),account,store.jobs()).items);
  assert.equal(store.jobs().length,3);
});
