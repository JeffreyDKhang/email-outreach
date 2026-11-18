import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateDraft,createAdditionalDraft,editDraft,messageIssues,manualTemplate} from '../app/domain/outreach.mjs';
import {leadDrafts,selectDraft} from '../app/domain/draft-state.mjs';
import {genericDefaults} from '../app/domain/scoring.mjs';
import {messageSnapshot} from '../app/domain/outbox.mjs';
import {editLeadField} from '../app/domain/lead-edit.mjs';
import {createStorageRepository} from '../app/infrastructure/storage.mjs';
import {mountOutreach} from '../app/ui/outreach-ui.mjs';
import {createOutboxService} from '../app/application/outbox.mjs';
import {createUnsavedChangesGuard} from '../app/ui/unsaved-changes.mjs';

const raw={messageWorkflow:2,lead_id:'one',company:'Ada',email:'ada@company.test',recipient_column:'Email',values:{Name:'Ada',Email:'ada@company.test'}};
const config={_columns:['Name'],General:{subject:'Hi {{Name}}',body:'General message'},Other:{subject:'Other message',body:'Another template'}};
const rules=structuredClone(genericDefaults);

test('multiple drafts keep independent content/templates/versions through persistence and reset',()=>{
  let lead=editDraft(generateDraft(raw,config,'merge',rules),'Edited first','First saved text');
  const first=structuredClone(lead.draft),frozen=messageSnapshot(lead,rules);
  lead=createAdditionalDraft(lead,config,rules,'Other');
  const secondId=lead.draft.id;
  assert.notEqual(secondId,first.id);assert.equal(lead.draft.version,1);
  lead=editDraft(lead,'Second saved subject','Second saved text');
  assert.deepEqual(leadDrafts(lead).find(draft=>draft.id===first.id),first);
  const data=new Map(),repository=createStorageRepository({getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)});
  repository.saveWorkspace({version:1,activeId:'list',datasets:[{id:'list',name:'List',leads:[lead],rules,templates:config}]});
  lead=repository.loadWorkspace().datasets[0].leads[0];
  assert.equal(lead.activeDraftId,secondId);assert.equal(lead.draft.body,'Second saved text');
  lead=selectDraft(lead,first.id);assert.equal(lead.draft.body,'First saved text');
  assert.equal(messageSnapshot(lead,rules).body,'First saved text');
  lead=generateDraft(lead,config,'merge',rules,lead.draft.templateName);
  assert.equal(lead.draft.id,first.id);assert.equal(lead.draft.body,'General message');
  lead=selectDraft(lead,secondId);assert.equal(lead.draft.body,'Second saved text');
  assert.equal(lead.draft.templateName,'Other');
  assert.equal(frozen.body,'First saved text');
  const duplicate=createAdditionalDraft(lead,config,rules,'Other');
  assert.equal(leadDrafts(duplicate).length,3);assert.notEqual(duplicate.draft.id,secondId);
  assert.throws(()=>selectDraft(lead,'missing'),/no longer exists/);
});

test('legacy single drafts survive adding manual drafts and source freshness applies to inactive drafts',()=>{
  let lead=generateDraft(raw,config,'merge',rules);
  delete lead.drafts;delete lead.activeDraftId;delete lead.draft.id;
  const original=structuredClone(lead);
  lead=createAdditionalDraft(lead,config,rules,manualTemplate);
  const {id,...preserved}=leadDrafts(lead).find(draft=>draft.id==='initial');
  assert.deepEqual(preserved,original.draft);
  assert.equal(lead.draft.body,'');
  lead=editDraft(lead,'Manual subject','Manual text');
  const manualId=lead.draft.id;
  lead=editLeadField(lead,'csv:Name','Grace',[lead]);
  assert.ok(messageIssues(lead,rules).some(issue=>/Source data changed/.test(issue)));
  lead=selectDraft(lead,'initial');
  assert.ok(messageIssues(lead,rules).some(issue=>/Source data changed/.test(issue)));
  assert.throws(()=>messageSnapshot(lead,rules),/Source data changed/);
  lead=generateDraft(lead,config,'merge',rules,'General');
  assert.equal(lead.draft.subject,'Hi Grace');
  lead=selectDraft(lead,manualId);
  assert.equal(lead.draft.body,'Manual text');
  lead=generateDraft(lead,config,'merge',rules,manualTemplate);
  assert.equal(lead.draft.subject,'');assert.equal(lead.draft.body,'');
  assert.equal(original.draft.subject,'Hi Ada');assert.equal(original.draft.id,undefined);
});

test('Outbox requests contain only the selected draft while saved alternatives stay local',async()=>{
  const first=generateDraft(raw,config,'merge',rules);
  const lead=createAdditionalDraft(first,config,rules,'Other');let request;
  const service=createOutboxService({getDataset:()=>({id:'list',name:'List',rules}),api:async(path,value)=>{request=value;return {ids:['held']};}});
  await service.add([lead]);
  assert.equal(request.leads[0].draft.templateName,'Other');
  assert.equal(request.leads[0].drafts,undefined);
  assert.equal(leadDrafts(lead).length,2);
});

test('Review Message creates/switches drafts, protects unsaved edits and sends only the selected draft',async()=>{
  const previous=globalThis.document,previousConfirm=globalThis.confirm,elements=new Map();
  function element(){return {value:'',html:'',textContent:'',open:false,addEventListener(){},querySelectorAll(selector){return selector==='#draft-subject,#draft-body'?[elements.get('draft-subject'),elements.get('draft-body')].filter(Boolean):[];},showModal(){this.open=true;},close(){this.open=false;},set innerHTML(html){
    this.html=html;for(const match of html.matchAll(/id="([^"]+)"/g))elements.set(match[1],element());
    const subject=html.match(/id="draft-subject" value="([^"]*)"/),body=html.match(/id="draft-body"[^>]*>([\s\S]*?)<\/textarea>/);
    if(subject)elements.get('draft-subject').value=subject[1];
    if(body)elements.get('draft-body').value=body[1];
  }};}
  for(const id of ['templates','batch','leads','table-head','select-all'])elements.set(id,element());
  globalThis.document={getElementById:id=>elements.get(id),createElement:element,body:{append(node){elements.set(node.id,node);}}};
  let rows=[structuredClone(raw)],failSave=false,held;
  const unsavedChanges=createUnsavedChangesGuard({addEventListener(){},removeEventListener(){}});
  try{
    globalThis.confirm=()=>true;
    const ui=mountOutreach({unsavedChanges,getLeads:()=>rows,getColumns:()=>[],getVisibleIds:()=>['one'],getRules:()=>rules,
      repository:{loadTemplates:()=>config},save:next=>{if(failSave)return false;rows=next;return true;},
      outboxService:{add:async leads=>{held=structuredClone(leads[0]);}},liveSender:{},escape:String,notice(){}});
    // Populate mocked text controls with the values a real DOM reads from the HTML.
    const sync=()=>{elements.get('draft-subject').value=rows[0].draft.subject;elements.get('draft-body').value=rows[0].draft.body;elements.get('lead-template').value=rows[0].draft.templateName;};
    await ui.open(rows[0]);sync();assert.equal(unsavedChanges.isDirty(),false);
    const firstId=rows[0].draft.id;
    elements.get('draft-body').value='Unsaved first';assert.equal(unsavedChanges.isDirty(),true);
    await elements.get('additional-draft').onclick();assert.equal(leadDrafts(rows[0]).length,1);
    assert.match(elements.get('review-message').textContent,/Save edits/);
    await elements.get('save-draft').onclick();sync();assert.equal(unsavedChanges.isDirty(),false);
    failSave=true;await elements.get('additional-draft').onclick();
    assert.equal(leadDrafts(rows[0]).length,1);assert.match(elements.get('review-message').textContent,/could not be saved/);
    failSave=false;await elements.get('additional-draft').onclick();sync();
    const secondId=rows[0].draft.id;
    assert.equal(leadDrafts(rows[0]).length,2);
    elements.get('lead-template').value='Other';await elements.get('lead-template').onchange();sync();
    assert.equal(rows[0].draft.templateName,'Other');
    elements.get('draft-body').value='Unsaved second';
    elements.get('lead-draft').value=firstId;await elements.get('lead-draft').onchange();
    assert.equal(rows[0].draft.id,secondId);assert.equal(elements.get('lead-draft').value,secondId);
    await elements.get('save-draft').onclick();sync();
    elements.get('lead-draft').value=firstId;await elements.get('lead-draft').onchange();sync();
    assert.equal(rows[0].draft.body,'Unsaved first');
    await elements.get('send-to-outbox').onclick();assert.equal(held.draft.id,firstId);assert.equal(held.draft.body,'Unsaved first');
    elements.get('lead-draft').value=secondId;await elements.get('lead-draft').onchange();sync();
    assert.equal(rows[0].draft.body,'Unsaved second');assert.equal(unsavedChanges.isDirty(),false);
    await elements.get('generate-draft').onclick();sync();assert.equal(rows[0].draft.body,'Another template');
    assert.equal(leadDrafts(rows[0]).find(draft=>draft.id===firstId).body,'Unsaved first');
  }finally{unsavedChanges.dispose();globalThis.document=previous;globalThis.confirm=previousConfirm;}
});
