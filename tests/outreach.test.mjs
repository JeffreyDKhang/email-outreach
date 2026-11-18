import {test} from 'node:test';
import assert from 'node:assert/strict';
import {templates,withoutPersonalization,validateTemplates,generateDraft,editDraft,approveDraft,approvalIssues,isApproved,reconcileApproval} from '../app/domain/outreach.mjs';
import {defaults} from '../app/domain/scoring.mjs';
const lead={lead_id:'one',company:'Example Office',first_name:'Alex',email:'alex@example.com',job_title:'Office Manager',city:'Toronto',office_employees:50,avg_daily_onsite:25,purchasing_method:'manual shopping',company_fact:'The team is moving into a larger office.',fact_source:'Synthetic demo scenario'};
test('merge and segment routing use source values and remove empty personalization',()=>{
  const draft=generateDraft(lead);assert.match(draft.draft.body,/Hi Alex/);assert.match(draft.draft.body,/Example Office/);assert.doesNotMatch(draft.draft.body,/{{|I noticed|\n\n\n/);
  assert.equal(generateDraft({...lead,job_title:'HR Manager'}).draft.subject,templates['People and HR'].subject);
  assert.match(generateDraft({...lead,first_name:''}).draft.body,/Hi there/);
  assert.equal(generateDraft({...lead,job_title:'Developer'}).draft.templateName,'General');
});
test('retired personalization settings and placeholders safely become ordinary merge',()=>{
  const config={General:{subject:'Hello',body:'Hello {{personalized_line}}'},_factColumn:'company_fact'};
  const copy=withoutPersonalization(config);
  assert.equal(copy.General.body,'Hello');assert.equal(copy._factColumn,undefined);
  assert.equal(config._factColumn,'company_fact');
  const draft=generateDraft(lead,templates,'mock');
  assert.equal(draft.draft.mode,'merge');
  assert.doesNotMatch(draft.draft.body,/I noticed|moving into/);
  assert.throws(()=>generateDraft(lead,templates,'real'));
});

test('template validation rejects unknown and malformed placeholders',()=>{
  for(const text of ['{{unknown}}','{{company','{{}}'])assert.throws(()=>validateTemplates({...templates,'Office operations':{subject:'Hello',body:text}}));
  assert.throws(()=>validateTemplates({...templates,'Office operations':{subject:' ',body:'Hi'}}));
});
test('edits and regeneration invalidate versioned approval; no-op edit preserves approval',()=>{
  const approved=approveDraft(generateDraft(lead));assert.ok(isApproved(approved));assert.equal(approved.approval.version,1);
  assert.equal(editDraft(approved,approved.draft.subject,approved.draft.body),approved);
  const edited=editDraft(approved,'New subject',approved.draft.body);assert.equal(edited.draft.version,2);assert.equal(edited.approval,null);assert.equal(edited.outreach_status,'Drafted');
  assert.equal(generateDraft(approved).approval,null);assert.equal(generateDraft(approved).draft.version,2);
  assert.equal(approveDraft(approved).activity.length,approved.activity.length);
});
test('approval blocks missing email, eligibility, blanks and placeholders',()=>{
  for(const patch of [{email:''},{email:'bad'},{city:'Ottawa'},{avg_daily_onsite:''}])assert.throws(()=>approveDraft(generateDraft({...lead,...patch})));
  const draft=generateDraft(lead);assert.throws(()=>approveDraft(editDraft(draft,'','Body')));assert.throws(()=>approveDraft(editDraft(draft,'Hello','Hi {{first_name}}')));
  assert.deepEqual(approvalIssues(lead),['Generate a draft first.']);
});
test('source changes and rule changes invalidate approval; serialized drafts retain review history',()=>{
  const approved=approveDraft(generateDraft(lead));
  assert.ok(isApproved(JSON.parse(JSON.stringify(approved))));
  assert.equal(isApproved({...approved,company_fact:'A different fact'}),false);
  assert.equal(reconcileApproval({...approved,email:'other@example.com'}).approval,null);
  const rules={...defaults,cities:['Ottawa']};assert.equal(reconcileApproval(approved,rules).outreach_status,'Drafted');
  assert.ok(approved.activity.every(e=>e.at&&e.version));
});
