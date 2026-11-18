import {test} from 'node:test';
import assert from 'node:assert/strict';
import {editLeadField} from '../app/domain/lead-edit.mjs';
import {createDataset} from '../app/domain/datasets.mjs';
import {parseCSV,importCSV} from '../app/domain/leads.mjs';
import {generateDraft,approveDraft,approvalIssues} from '../app/domain/outreach.mjs';
import {genericDefaults,scoreLead} from '../app/domain/scoring.mjs';
import {createStorageRepository} from '../app/infrastructure/storage.mjs';
import {mountLeadEdit} from '../app/ui/lead-edit-ui.mjs';
import {createUnsavedChangesGuard} from '../app/ui/unsaved-changes.mjs';

const lead=()=>importCSV(parseCSV('Name,Email,Size\nAda,,0010'),'Email').accepted[0];
test('a confirmed email correction updates source and recipient projections and persists after reload',()=>{
  const original=lead(),next=editLeadField(original,'csv:Email',' ada@example.com ',[original]);
  assert.equal(original.email,'');
  assert.equal(next.values.Email,' ada@example.com ');
  assert.equal(next.email,'ada@example.com');
  assert.equal(next.lead_id,original.lead_id);
  assert.notEqual(next.import_fingerprint,original.import_fingerprint);
  const data=new Map(),repository=createStorageRepository({getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)});
  const dataset=createDataset('Edited list',[next]);
  repository.saveWorkspace({version:1,activeId:dataset.id,datasets:[dataset]});
  assert.deepEqual(repository.loadWorkspace().datasets[0].leads[0],next);
});
test('source correction clears approval, retains old draft for review and recalculates scores',()=>{
  const rules={...genericDefaults,criteria:[{name:'Size',field:'csv:Size',weight:100,cases:[{operator:'gte',value:20,points:100}]}]};
  const original=editLeadField(lead(),'csv:Email','ada@example.com');
  const approved=approveDraft(generateDraft(original,undefined,'merge',rules),rules);
  const next=editLeadField(approved,'csv:Size','0020');
  assert.equal(next.approval,null);
  assert.deepEqual(next.draft,approved.draft);
  assert.equal(next.outreach_status,'Drafted');
  assert.equal(next.values.Size,'0020');
  assert.equal(scoreLead(next,rules).score,100);
  assert.ok(approvalIssues(next,rules).some(issue=>issue.includes('Source data changed')));
  assert.ok(approveDraft(generateDraft(next,undefined,'merge',rules),rules).approval);
});
test('invalid/duplicate emails, metadata edits and queued/sent corrections are blocked without mutation',()=>{
  const original=lead(),snapshot=structuredClone(original);
  assert.throws(()=>editLeadField(original,'csv:Email','bad address'),/valid/);
  assert.throws(()=>editLeadField(original,'csv:Email','ADA@example.com',[{lead_id:'other',email:'ada@example.com'}]),/already exists/);
  for(const key of ['lead_id','score','outreach_status','csv:Unknown'])assert.throws(()=>editLeadField(original,key,'bad'),/source fields/);
  assert.throws(()=>editLeadField({...original,live_delivery:{status:'queued'}},'csv:Name','Other'),/read-only/);
  assert.throws(()=>editLeadField({...original,outbox:[{recipient:'original@example.com'}]},'csv:Name','Other'),/read-only/);
  assert.equal(editLeadField(original,'csv:Email',''),original);
  assert.deepEqual(original,snapshot);
});
test('legacy/custom fields and reserved CSV headers remain separate from internal IDs',()=>{
  const old={lead_id:'old',company:'Old',email:'',extra_fields:{Budget:'0010'}};
  assert.equal(editLeadField(old,'custom:Budget','0020').extra_fields.Budget,'0020');
  assert.equal(editLeadField(old,'email','ada@example.com').email,'ada@example.com');
  assert.throws(()=>editLeadField(old,'lead_id','new'),/source fields/);
  const raw=importCSV(parseCSV('lead_id,__proto__,Email\nexternal,first,'),'Email').accepted[0];
  const next=editLeadField(raw,'csv:lead_id','external-new');
  assert.equal(next.lead_id,raw.lead_id);
  assert.equal(next.values.lead_id,'external-new');
  assert.equal(editLeadField(next,'csv:__proto__','second').values.__proto__,'second');
});

test('editor Cancel never saves; Save validates and storage failures keep the editor open',async()=>{
  const previous=globalThis.document,elements=new Map();
  function element(){return {value:'',textContent:'',open:false,listeners:{},querySelectorAll(){return [elements.get('field-edit-value')];},addEventListener(name,fn){this.listeners[name]=fn;},focus(){},showModal(){this.open=true;},close(){this.open=false;this.listeners.close?.();},set innerHTML(html){for(const match of html.matchAll(/id="([^"]+)"/g))elements.set(match[1],element());}};}
  elements.set('leads',element());
  globalThis.document={getElementById:id=>elements.get(id),createElement:()=>element(),body:{append(node){elements.set(node.id,node);}}};
  let dataset=createDataset('List',[lead()]),saves=0,fail=false,delay=false,rejectSave;
  const original=structuredClone(dataset);
  const unsavedChanges=createUnsavedChangesGuard({addEventListener(){},removeEventListener(){}});
  try{
    mountLeadEdit({unsavedChanges,getDataset:()=>dataset,async save(rows){saves++;if(fail)return false;if(delay)await new Promise((resolve,reject)=>{rejectSave=reject;});dataset={...dataset,leads:rows};return true;},escape:String,notice(){}});
    const open=()=>elements.get('leads').listeners.click({target:{closest:()=>({dataset:{editLead:dataset.leads[0].lead_id,editField:'csv:Email'}})}});
    const submit=()=>elements.get('edit-field-form').onsubmit({preventDefault(){}});
    open();assert.equal(unsavedChanges.isDirty(),false);
    elements.get('field-edit-value').value='ignored@example.com';assert.equal(unsavedChanges.isDirty(),true);
    elements.get('discard-field-edit').onclick();assert.equal(unsavedChanges.isDirty(),false);
    assert.equal(saves,0);assert.deepEqual(dataset,original);
    open();elements.get('field-edit-value').value='invalid';await submit();assert.equal(saves,0);
    assert.match(elements.get('field-edit-error').textContent,/valid/);
    elements.get('field-edit-value').value='ada@example.com';fail=true;await submit();
    assert.equal(elements.get('edit-field-dialog').open,true);assert.deepEqual(dataset,original);
    assert.equal(unsavedChanges.isDirty(),true);
    fail=false;delay=true;const pending=submit();
    assert.equal(elements.get('edit-field-dialog').open,true);assert.equal(unsavedChanges.isDirty(),true);
    rejectSave(Error('Backend unavailable'));await pending;
    assert.match(elements.get('field-edit-error').textContent,/Backend unavailable/);
    assert.equal(elements.get('field-edit-value').value,'ada@example.com');assert.deepEqual(dataset,original);
    delay=false;await submit();assert.equal(elements.get('edit-field-dialog').open,false);
    assert.equal(unsavedChanges.isDirty(),false);
    assert.equal(dataset.leads[0].email,'ada@example.com');
  }finally{unsavedChanges.dispose();globalThis.document=previous;}
});
