import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateDraft,editDraft,approveDraft,isApproved,manualTemplate} from '../app/domain/outreach.mjs';
import {genericDefaults} from '../app/domain/scoring.mjs';
import {mountTemplates} from '../app/ui/templates-ui.mjs';
const lead={lead_id:'one',company:'Ada',email:'ada@example.com',recipient_column:'Email',values:{Name:'Ada',Email:'ada@example.com',Role:'Manager'}};
const rules={...structuredClone(genericDefaults),segments:[{name:'Managers',conditions:[{field:'csv:Role',operator:'equals',value:'Manager'}]}]};
const config={_columns:['Name'],General:{subject:'Hello {{Name}}',body:'General message'},Other:{subject:'Other {{Name}}',body:'Another group'}};
test('General fallback, segment routing and per-lead override keep actual segment and approval checks',()=>{
  assert.equal(generateDraft(lead,config,'merge',rules).draft.templateName,'General');
  const routed={...config,Managers:{subject:'Manager',body:'Manager message'}};
  assert.equal(generateDraft(lead,routed,'merge',rules).draft.templateName,'Managers');
  const override=generateDraft(lead,routed,'merge',rules,'Other');
  assert.equal(override.draft.subject,'Other Ada');assert.equal(override.draft.segment,'Managers');
  assert.equal(isApproved(approveDraft(override,rules),rules),true);
  const edited=editDraft(override,'Edited','Custom message');
  const reset=generateDraft(JSON.parse(JSON.stringify(edited)),routed,'merge',rules,edited.draft.templateName);
  assert.equal(reset.draft.subject,'Other Ada');assert.equal(reset.draft.body,'Another group');assert.equal(reset.approval,null);
  assert.throws(()=>generateDraft(lead,config,'merge',rules,'Removed'),/no longer exists/);
});
test('manual drafts are blank, editable, persist selection and reset to blank',()=>{
  const blank=generateDraft(lead,config,'merge',rules,manualTemplate);
  assert.equal(blank.draft.subject,'');assert.equal(blank.draft.body,'');
  assert.throws(()=>approveDraft(blank,rules),/blank/);
  const edited=editDraft(blank,'My subject','My own message');
  const approved=approveDraft(edited,rules);
  assert.equal(approved.draft.templateName,manualTemplate);
  const reset=generateDraft(JSON.parse(JSON.stringify(approved)),config,'merge',rules,manualTemplate);
  assert.equal(reset.draft.body,'');assert.equal(reset.approval,null);
  assert.throws(()=>generateDraft({...approved,live_delivery:{status:'queued'}},config,'merge',rules,manualTemplate),/queued or sent/);
});
test('opening Templates lists segment choices without automatically adding templates',()=>{
  const previous=globalThis.document,previousConfirm=globalThis.confirm,elements=new Map();
  function element(){return {value:'',disabled:false,html:'',textContent:'',addEventListener(){},showModal(){},close(){},set innerHTML(html){this.html=html;for(const match of html.matchAll(/id="([^"]+)"/g))elements.set(match[1],element());}};}
  elements.set('templates',element());
  globalThis.document={getElementById:id=>elements.get(id),createElement:element,body:{append(){}}};
  let saved;
  try{
    mountTemplates({repository:{loadTemplates:()=>structuredClone(config),saveTemplates:value=>{saved=value;}},getLeads:()=>[lead],getColumns:()=>[{key:'csv:Name',label:'Name'}],getRules:()=>rules,escape:String,notice(){}});
    elements.get('templates').onclick();
    assert.doesNotMatch(elements.get('template-fields').html,/<legend>Managers/);
    assert.match(elements.get('new-template-segment').html,/Managers/);
    elements.get('new-template-segment').value='Managers';elements.get('new-template-segment').onchange();
    assert.equal(elements.get('new-template-name').value,'Managers');
    assert.equal(elements.get('new-template-name').disabled,true);
    assert.equal(saved,undefined);
    globalThis.confirm=()=>false;elements.get('restore-templates').onclick();
    assert.match(elements.get('template-fields').html,/<legend>Other/);
    globalThis.confirm=()=>true;elements.get('restore-templates').onclick();
    assert.doesNotMatch(elements.get('template-fields').html,/<legend>Other/);
    assert.match(elements.get('template-error').textContent,/Save templates/);
    assert.equal(saved,undefined);
    elements.get('close-templates').onclick();elements.get('templates').onclick();
    assert.match(elements.get('template-fields').html,/<legend>Other/);

  }finally{globalThis.document=previous;globalThis.confirm=previousConfirm;}
});
