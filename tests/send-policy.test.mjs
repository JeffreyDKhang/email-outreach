import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {appAllowance,validateSendingSettings,WINDOW_MS} from '../server/send-policy.mjs';
import {openStore} from '../server/store.mjs';
import {createQueue,prepareLiveBatch} from '../server/sending.mjs';
import {parseCSV,importCSV} from '../app/domain/leads.mjs';
import {generateDraft,approveDraft} from '../app/domain/outreach.mjs';
import {genericDefaults} from '../app/domain/scoring.mjs';
import {SendError} from '../server/providers/interface.mjs';

function fixture(t){const dir=mkdtempSync(join(tmpdir(),'outreach-policy-'));const store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {dir,store};}
const account={id:'one',email:'sender@company.test',provider:'gmail'};
const item=i=>({id:String(i),account:account.id,recipient:`contact${i}@company.test`,sender:account.email,subject:'Hi',body:'Hello',leadId:String(i)});

test('500-row native import and approved real batch succeed; 501 rows/messages reject',()=>{
  const text='Name,Email\n'+Array.from({length:500},(_,i)=>`Contact ${i},contact${i}@company.test`).join('\n');
  const rows=importCSV(parseCSV(text),'Email').accepted;
  assert.equal(rows.length,500);
  assert.throws(()=>parseCSV(text+'\nExtra,extra@company.test'),/500/);
  const leads=rows.map(row=>approveDraft(generateDraft(row,undefined,'merge',genericDefaults),genericDefaults));
  assert.equal(prepareLiveBatch(leads,genericDefaults,account,[]).items.length,500);
  assert.throws(()=>prepareLiveBatch([...leads,leads[0]],genericDefaults,account,[]),/500/);
});
test('rolling allowance releases individual slots at exact boundaries and reserves old queued jobs',()=>{
  const now=Date.parse('2026-11-14T12:00:00Z');
  const jobs=[
    {account:'one',status:'accepted',created:new Date(now-2*WINDOW_MS).toISOString(),attempted_at:new Date(now-1000).toISOString()},
    {account:'one',status:'failed',created:new Date(now-WINDOW_MS+1000).toISOString()},
    {account:'one',status:'unknown',created:new Date(now-WINDOW_MS).toISOString()},
    {account:'one',status:'queued',created:new Date(now-2*WINDOW_MS).toISOString()},
    {account:'other',status:'queued',created:new Date(now).toISOString()},
  ];
  const a=appAllowance(jobs,'one',now);
  assert.equal(a.used,3);assert.equal(a.remaining,497);assert.equal(a.reserved,1);
  assert.equal(a.nextReleaseAt,new Date(now+1000).toISOString());
  assert.equal(appAllowance(jobs,'one',now+1000).used,2);
});
test('transactional enqueue rejects stale preview allowance atomically',t=>{
  const {store}=fixture(t);
  store.enqueue(Array.from({length:499},(_,i)=>item(i)));
  assert.throws(()=>store.enqueue([item('new1'),item('new2')]),/allowance/);
  assert.equal(store.jobs().length,499);
  store.enqueue([item('last')]);
  assert.equal(appAllowance(store.jobs(),'one').remaining,0);
  assert.throws(()=>store.enqueue([item('overflow')]),/allowance/);
  // Cancellation retains the conservative reservation for its original 24h window.
  store.cancelQueued();assert.equal(appAllowance(store.jobs(),'one').used,500);
});
test('prompt sending has no intentional inter-message delay and never overlaps requests',async t=>{
  const {store}=fixture(t);store.enqueue([item(1),item(2)]);
  let release,calls=0;
  const provider={async sendMessage(){calls++;if(calls===1)await new Promise(resolve=>{release=resolve;});return {status:'accepted'};}};
  const queue=createQueue({store,provider});
  const first=queue.tick();await queue.tick();assert.equal(calls,1);
  release();assert.equal((await first).waitMs,0);
  assert.equal((await queue.tick()).waitMs,0);assert.equal(calls,2);
  assert.ok(store.jobs().every(job=>job.status==='accepted'&&job.attempted_at));
});
test('configured pacing and persisted provider-error pause survive worker recreation',async t=>{
  const {store}=fixture(t);store.set('sending-settings',validateSendingSettings({delaySeconds:2}));store.enqueue([item(1),item(2)]);
  let clock=Date.now(),calls=0;
  const provider={async sendMessage(){calls++;return {status:'accepted'};}};
  await createQueue({store,provider,now:()=>clock}).tick();
  const queue=createQueue({store,provider,now:()=>clock});
  assert.ok((await queue.tick()).waitMs>0);assert.equal(calls,1);
  clock+=3000;await queue.tick();assert.equal(calls,2);
  store.set('sending-settings',{delaySeconds:0});store.enqueue([item(3),item(4)]);
  const rejected={async sendMessage(){throw new SendError('Provider limit',false,true);}};
  await createQueue({store,provider:rejected}).tick();assert.ok(store.get('sending-pause'));
  await createQueue({store,provider}).tick();assert.equal(calls,2);
  assert.equal(store.jobs().filter(job=>job.status==='queued').length,1);
  store.remove('sending-pause');await createQueue({store,provider}).tick();assert.equal(calls,3);
  assert.equal(store.jobs().filter(job=>job.status==='failed').length,1);
});
test('migration preserves existing job history and settings; interrupted sends keep their allowance',t=>{
  const {dir,store}=fixture(t);store.enqueue([item(1)]);store.update('1','sending');
  const attempted=store.jobs()[0].attempted_at;
  const second=openStore(dir);try{assert.equal(second.jobs()[0].status,'unknown');assert.equal(second.jobs()[0].attempted_at,attempted);assert.equal(appAllowance(second.jobs(),'one').used,1);}finally{second.close();}
  store.db.exec('ALTER TABLE jobs DROP COLUMN attempted_at');
  const migrated=openStore(dir);try{assert.equal(migrated.jobs()[0].attempted_at,migrated.jobs()[0].updated);assert.equal(appAllowance(migrated.jobs(),'one').used,1);}finally{migrated.close();}
});
test('sending pace accepts prompt mode and bounded whole-second delays',()=>{
  assert.deepEqual(validateSendingSettings({delaySeconds:0}),{delaySeconds:0});
  assert.deepEqual(validateSendingSettings({delaySeconds:2}),{delaySeconds:2});
  for(const value of [-1,0.1,3601,'2',null])assert.throws(()=>validateSendingSettings({delaySeconds:value}));
});
