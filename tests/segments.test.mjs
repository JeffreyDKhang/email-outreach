import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mountSegments} from '../app/ui/segments-ui.mjs';
import {editableRuleProfile} from '../app/domain/rule-profile.mjs';
import {genericDefaults,defaults,scoreLead} from '../app/domain/scoring.mjs';
import {generateDraft,approveDraft,isApproved,reconcileApproval} from '../app/domain/outreach.mjs';

const row={lead_id:'one',company:'Example',email:'test@example.com',values:{Name:'Ada',Role:'Manager',Email:'test@example.com'},recipient_column:'Email'};
const profile={...structuredClone(genericDefaults),segments:[{name:'Managers',conditions:[{field:'csv:Role',operator:'equals',value:'Manager'}]}]};
test('segment editor keeps edits local until save and rejects incompatible conditions',()=>{
  const container={innerHTML:''};
  const editor=mountSegments({container,getLeads:()=>[row],getColumns:()=>[{key:'csv:Role',label:'Role'}],escape:String});
  editor.open(profile);
  const section={dataset:{segment:'0'}};
  container.oninput({target:{value:'Leaders',tagName:'INPUT',hasAttribute:()=>true,dataset:{},closest:()=>section}});
  assert.equal(profile.segments[0].name,'Managers');
  assert.equal(editor.value()[0].name,'Leaders');
  editor.open(profile);assert.equal(editor.value()[0].name,'Managers');
  editor.open({...profile,segments:[{name:'Bad',conditions:[{field:'csv:Role',operator:'between',value:1,to:2}]}]});
  assert.match(container.innerHTML,/incompatible/);
  assert.throws(()=>editor.value(),/incompatible/);
});
test('moving routing preserves legacy profiles and current scoring while changing message approvals',()=>{
  const legacy=editableRuleProfile(defaults,[]);
  assert.equal(legacy.criteria.length,5);assert.equal(legacy.segments.length,2);
  assert.deepEqual(editableRuleProfile(profile,[row]),profile);
  const templates={General:{subject:'Hello',body:'General message'},Managers:{subject:'Manager',body:'Manager message'}};
  const approved=approveDraft(generateDraft(row,templates,'merge',profile),profile);
  assert.equal(approved.draft.subject,'Manager');
  const next={...profile,segments:[]};
  assert.equal(scoreLead(row,next).score,scoreLead(row,profile).score);
  assert.equal(scoreLead(row,next).eligibility,scoreLead(row,profile).eligibility);
  assert.equal(isApproved(reconcileApproval(approved,next),next),false);
  assert.equal(generateDraft(row,templates,'merge',next).draft.subject,'Hello');
});
