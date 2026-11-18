import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeliveryJobs, markBatchQueued, createQueueSync } from '../app/application/queue-sync.mjs';

const lead = { lead_id:'one', company:'Test', email:'one@company.test', draft:{body:'Reviewed copy'} };
const job = (status='queued', updated='2026-11-15T12:00:00Z') => ({ payload:{leadId:'one', sender:'sender@company.test'}, recipient:lead.email, status, updated });

test('delivery projection chooses newest job, matches identity/recipient and preserves unrelated records', () => {
  const other = { ...lead, lead_id:'two' }, before = structuredClone(lead);
  const result = applyDeliveryJobs([lead, other], [job('accepted'), job('queued', '2026-11-15T11:00:00Z')]);
  assert.equal(result[0].outreach_status, 'Gmail accepted');
  assert.equal(result[1], other); assert.equal(result[0].draft, lead.draft); assert.deepEqual(lead, before);
  const mismatch = [lead];
  assert.equal(applyDeliveryJobs(mismatch, [{...job(), recipient:'someone-else@company.test'}]), mismatch);
  assert.equal(applyDeliveryJobs(mismatch, [{...job(), status:'invalid'}]), mismatch);
  const queued = markBatchQueued([lead], [{leadId:'one', sender:'sender@company.test', recipient:lead.email}]);
  assert.equal(queued[0].live_delivery.status, 'queued');
});

test('status refresh saves only changed projections and handles persistence failure', async () => {
  let leads = [lead], writes = 0, fail = false;
  const sync = createQueueSync({ api:async()=>({jobs:[job()]}), getLeads:()=>leads, save(next){writes++;if(fail)return false;leads=next;return true;} });
  await sync.refresh(); await sync.refresh(); assert.equal(writes, 1);
  leads = [lead]; fail = true;
  await assert.rejects(sync.refresh(), /could not be saved/); assert.equal(leads[0], lead);
});

test('delayed queue responses merge against current leads rather than an old state snapshot', async () => {
  let resolve, leads = [lead];
  const sync = createQueueSync({ api:()=>new Promise(done=>{resolve=done;}), getLeads:()=>leads, save(next){leads=next;return true;} });
  const pending = sync.refresh();
  leads = [{...lead, company:'Edited while loading'}, {...lead, lead_id:'new'}];
  resolve({jobs:[job('accepted')]}); await pending;
  assert.equal(leads[0].company, 'Edited while loading'); assert.equal(leads.length, 2);
  assert.equal(leads[0].outreach_status, 'Gmail accepted');
});

test('cancel workflow fetches status once and never retries attempted messages', async () => {
  const calls = [];
  const sync = createQueueSync({ api:async path=>{calls.push(path);return {jobs:[]};}, getLeads:()=>[], save(){throw Error('Nothing changed');} });
  assert.deepEqual(await sync.cancel(), []);
  assert.deepEqual(calls, ['/api/live/cancel', '/api/live/jobs']);
});
