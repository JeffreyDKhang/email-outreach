import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDataset,datasetName,emptyWorkspace,defaultTemplates,validateWorkspace} from '../app/domain/datasets.mjs';
import {createStorageRepository,storageKeys} from '../app/infrastructure/storage.mjs';
import {importCSV,parseCSV} from '../app/domain/leads.mjs';
import {sourceColumns} from '../app/domain/lead-schema.mjs';
import {defaults,genericDefaults,scoreLead} from '../app/domain/scoring.mjs';
import {templates,generateDraft,approveDraft} from '../app/domain/outreach.mjs';
import {simulateInitial} from '../app/domain/delivery.mjs';

const memory=()=>{const data=new Map();return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};};
const imported=(text,email)=>importCSV(parseCSV(text),email).accepted;

test('fresh workspace starts empty; repeated imports have independent IDs and source columns',()=>{
  const repository=createStorageRepository(memory());
  assert.deepEqual(repository.loadWorkspace(),emptyWorkspace);
  const a=createDataset('First list',imported('Name,To\nAda,ada@example.com','To'));
  const b=createDataset('Second list',imported('Contact,Email,Size\nBen,ada@example.com,0050','Email'));
  const c=createDataset('First list',imported('Name,To\nAda,ada@example.com','To'));
  assert.notEqual(a.leads[0].lead_id,c.leads[0].lead_id);
  assert.notEqual(a.id,c.id);
  assert.deepEqual(sourceColumns(a.leads).map(c=>c.label),['Name','To']);
  assert.deepEqual(sourceColumns(b.leads).map(c=>c.label),['Contact','Email','Size']);
  assert.equal(b.leads[0].values.Size,'0050');
  assert.deepEqual(a.rules,genericDefaults);
  assert.deepEqual(a.templates,defaultTemplates);
  a.templates.General.subject='First only';
  assert.notEqual(a.templates.General.subject,b.templates.General.subject);
  assert.equal(scoreLead(b.leads[0],b.rules).band,'Unscored');
});

test('names, active tab, rules, templates and draft history persist independently after reload',()=>{
  const storage=memory(),repository=createStorageRepository(storage);
  const a=createDataset('First',imported('Name,Email\nAda,ada@example.com','Email'));
  const b=createDataset('Second',imported('Full Name,Send To\nBen,ben@example.com','Send To'));
  a.name=datasetName('  Renamed list  ');
  a.rules.criteria=[{name:'Named',field:'csv:Name',weight:100,cases:[{operator:'present',points:100}]}];
  a.templates.General={subject:'Hello {{csv:Name}}',body:'A message for {{csv:Name}}'};
  a.leads=[simulateInitial(approveDraft(generateDraft(a.leads[0],a.templates,'merge',a.rules),a.rules),a.rules)];
  repository.saveWorkspace({version:1,activeId:b.id,datasets:[a,b]});
  const restored=createStorageRepository(storage).loadWorkspace();
  assert.equal(restored.activeId,b.id);
  assert.deepEqual(restored.datasets,[a,b]);
  assert.equal(restored.datasets[0].leads[0].outbox.length,1);
  assert.deepEqual(restored.datasets[1].rules,genericDefaults);
  assert.deepEqual(restored.datasets[1].templates,defaultTemplates);
});

test('legacy mixed data migrates once by schema without losing history or altering old storage',()=>{
  const storage=memory(),repository=createStorageRepository(storage);
  const old=simulateInitial(approveDraft(generateDraft({lead_id:'old',company:'Example',first_name:'Alex',email:'alex@example.com',job_title:'Office Manager',city:'Toronto',avg_daily_onsite:25})));
  const rows=imported('Full Name,Email\nAda,ada@example.com\nBen,ben@example.com','Email');
  repository.saveLeads([old,...rows]);repository.saveRules(defaults);repository.saveTemplates(templates);
  const snapshot=storage.getItem(storageKeys.leads);
  const workspace=repository.loadWorkspace();
  assert.equal(workspace.datasets.length,2);
  assert.deepEqual(workspace.datasets[0].leads,[old]);
  assert.deepEqual(workspace.datasets[1].leads,rows);
  assert.deepEqual(workspace.datasets[1].rules,genericDefaults);
  assert.equal(storage.getItem(storageKeys.leads),snapshot);
  repository.saveLeads([]);
  assert.deepEqual(repository.loadWorkspace(),workspace);
});

test('invalid names, malformed state and storage failure cannot overwrite saved workspace',()=>{
  const storage=memory(),repository=createStorageRepository(storage);
  repository.saveWorkspace(emptyWorkspace);
  const original=storage.getItem(storageKeys.workspace);
  for(const name of ['', '   ', 'x'.repeat(101)])assert.throws(()=>datasetName(name));
  assert.throws(()=>repository.saveWorkspace({...emptyWorkspace,activeId:'missing'}));
  assert.equal(storage.getItem(storageKeys.workspace),original);
  const dataset=createDataset('One',[]);
  assert.throws(()=>validateWorkspace({version:1,activeId:dataset.id,datasets:[dataset,dataset]}));
  storage.setItem(storageKeys.workspace,'invalid JSON');
  assert.throws(()=>repository.loadWorkspace());
  assert.equal(storage.getItem(storageKeys.workspace),'invalid JSON');
  const failing=createStorageRepository({getItem:storage.getItem,setItem(){throw Error('Full');}});
  assert.throws(()=>failing.saveWorkspace(emptyWorkspace),/Full/);
});
