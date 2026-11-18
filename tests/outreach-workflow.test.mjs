import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../server/store.mjs';
import { createApplication } from '../server/http.mjs';
import { createQueue } from '../server/sending.mjs';
import { createStorageRepository } from '../app/infrastructure/storage.mjs';
import { createQueueSync } from '../app/application/queue-sync.mjs';
import { createDataset } from '../app/domain/datasets.mjs';
import { importCSV, parseCSV } from '../app/domain/leads.mjs';
import { editLeadField } from '../app/domain/lead-edit.mjs';
import { generateDraft, approveDraft } from '../app/domain/outreach.mjs';
import { exportDatasetCSV } from '../app/domain/dataset-tools.mjs';
import { genericDefaults } from '../app/domain/scoring.mjs';

async function backend(t) {
  const dir = mkdtempSync(join(tmpdir(), 'outreach-workflow-'));
  const store = openStore(dir);
  const account = { id:'workflow-sender', email:'sender@company.test', provider:'gmail' };
  let origin, calls = 0;
  const provider = {
    configured:()=>true, getAccount:()=>account,
    async sendMessage(message) { calls++; return { status:'accepted', messageId:'mock-' + message.id }; },
  };
  const server = createApplication({ root:fileURLToPath(new URL('../',import.meta.url)), origin:()=>origin, store, provider });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async()=>{
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
    store.close(); rmSync(dir,{recursive:true,force:true});
  });
  const session = await fetch(origin + '/api/session');
  const cookie = session.headers.get('set-cookie').split(';')[0], {csrf} = await session.json();
  async function api(path, value) {
    const response = await fetch(origin + path, {
      method:value === undefined ? 'GET' : 'POST',
      headers:{ Cookie:cookie, Origin:origin, 'Content-Type':'application/json', 'X-CSRF-Token':csrf },
      ...(value === undefined ? {} : { body:JSON.stringify(value) }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    return result;
  }
  return { api, queue:createQueue({store,provider}), store, calls:()=>calls };
}

test('import/edit/draft/approve/HTTP queue/mock delivery/status sync/export survives reload and dataset switching', async t => {
  const server = await backend(t), memory = new Map();
  const repository = createStorageRepository({ getItem:key=>memory.get(key)??null, setItem:(key,value)=>memory.set(key,value) });
  const imported = importCSV(parseCSV('Name,Email\nAda,ada@company.test'), 'Email').accepted;
  const first = createDataset('First', imported);
  const second = createDataset('Second', importCSV(parseCSV('Full Name,To\nBen,ben@company.test'),'To').accepted);
  const otherBefore = structuredClone(second);
  first.templates = { General:{subject:'Hello {{csv:Name}}',body:'A message for {{csv:Name}}'} };
  first.leads = [approveDraft(generateDraft(first.leads[0],first.templates,'merge',first.rules),first.rules)];
  first.leads = [editLeadField(first.leads[0],'csv:Name','Ada corrected',first.leads)];
  await assert.rejects(server.api('/api/live/preview',{leads:first.leads,rules:first.rules}), /approved/);
  first.leads = [approveDraft(generateDraft(first.leads[0],first.templates,'merge',first.rules),first.rules)];
  repository.saveWorkspace({version:1,activeId:second.id,datasets:[first,second]});
  let workspace = repository.loadWorkspace();
  const saved = workspace.datasets[0];
  const preview = await server.api('/api/live/preview',{leads:saved.leads,rules:saved.rules});
  await server.api('/api/live/enqueue',{id:preview.id,digest:preview.digest});
  await server.queue.tick(); assert.equal(server.calls(),1);
  const sync = createQueueSync({
    api:server.api, getLeads:()=>workspace.datasets.flatMap(dataset=>dataset.leads),
    save(leads) {
      const byId = new Map(leads.map(lead=>[lead.lead_id,lead]));
      workspace = {...workspace,datasets:workspace.datasets.map(dataset=>({...dataset,leads:dataset.leads.map(lead=>byId.get(lead.lead_id))}))};
      repository.saveWorkspace(workspace); return true;
    },
  });
  await sync.refresh(); workspace = repository.loadWorkspace();
  assert.equal(workspace.activeId,second.id);
  assert.deepEqual(workspace.datasets[1],otherBefore);
  assert.equal(workspace.datasets[0].leads[0].outreach_status,'Gmail accepted');
  const report = parseCSV(exportDatasetCSV(workspace.datasets[0],'report'));
  assert.equal(report.rows[0][report.headers.indexOf('Name')],'Ada corrected');
  assert.equal(report.rows[0][report.headers.indexOf('Outreach status')],'Gmail accepted');
  assert.equal(server.store.jobs()[0].payload.body,'A message for Ada corrected');
  await assert.rejects(server.api('/api/live/preview',{leads:workspace.datasets[0].leads,rules:saved.rules}));
});

test('backend rejects older legacy approval with incomplete source signature and accepts regenerated copy', async t => {
  const {api} = await backend(t);
  const lead = {lead_id:'old',company:'Legacy',email:'legacy@company.test',extra_fields:{Budget:'20'}};
  const config = {General:{subject:'Budget',body:'Budget {{custom:Budget}}'},_columns:['custom:Budget']};
  const fresh = approveDraft(generateDraft(lead,config,'merge',genericDefaults),genericDefaults);
  const old = structuredClone(fresh); delete old.draft.sourceVersion;
  old.draft.sourceKey = JSON.stringify(['','','Legacy','','','legacy@company.test','','']);
  old.draft.body = 'Budget 10';
  await assert.rejects(api('/api/live/preview',{leads:[old],rules:genericDefaults}));
  const preview = await api('/api/live/preview',{leads:[fresh],rules:genericDefaults});
  assert.equal(preview.items[0].body,'Budget 20');
});
