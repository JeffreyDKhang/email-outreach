import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateDraft,editDraft,approveDraft,reconcileApproval} from '../app/domain/outreach.mjs';
import {defaults} from '../app/domain/scoring.mjs';
import {simulateInitial,generateFollowup,editFollowup,approveFollowup,followupApproved,simulateFollowup,simulateReply} from '../app/domain/delivery.mjs';
const source={lead_id:'test',company:'Demo',first_name:'Alex',email:'alex@example.com',job_title:'Office Manager',city:'Toronto',office_employees:50,avg_daily_onsite:25};
const approved=()=>approveDraft(generateDraft(source));
const sent=()=>simulateInitial(approved());
test('initial simulation requires current approval and snapshots exact reviewed copy',()=>{
  assert.throws(()=>simulateInitial(generateDraft(source)));
  const original=approved(),result=simulateInitial(original);assert.equal(result.outbox.length,1);assert.equal(result.outbox[0].body,original.draft.body);assert.equal(result.outbox[0].recipient,source.email);assert.equal(result.outbox[0].delivery,'simulated');assert.ok(result.outbox[0].approvedAt);assert.equal(original.outbox,undefined);
  assert.throws(()=>simulateInitial(result));assert.throws(()=>generateDraft(result));assert.throws(()=>editDraft(result,'changed','body'));assert.throws(()=>approveDraft(result));
});
test('follow-up requires initial delivery, independent review and only one delivery',()=>{
  assert.throws(()=>generateFollowup(approved()));
  const initial=sent(),draft=generateFollowup(initial);assert.match(draft.followup.draft.subject,/^Re:/);assert.equal(draft.outreach_status,'Simulated sent');
  assert.throws(()=>simulateFollowup(draft));
  const ready=approveFollowup(draft),final=simulateFollowup(ready);assert.equal(final.outbox.length,2);assert.equal(final.outbox[1].kind,'followup');assert.equal(final.outreach_status,'Simulated follow-up sent');assert.equal(final.outbox[0].body,initial.outbox[0].body);
  assert.throws(()=>simulateFollowup(final));assert.throws(()=>generateFollowup(final));assert.throws(()=>editFollowup(final,'s','b'));
});
test('follow-up edits and regeneration clear approval; source and eligibility rechecked',()=>{
  const ready=approveFollowup(generateFollowup(sent()));
  assert.ok(followupApproved(ready));assert.equal(approveFollowup(ready).activity.length,ready.activity.length);
  const edited=editFollowup(ready,'Updated',ready.followup.draft.body);assert.equal(edited.followup.approval,null);assert.equal(edited.followup.draft.version,2);assert.throws(()=>simulateFollowup(edited));
  assert.equal(generateFollowup(ready).followup.approval,null);
  assert.throws(()=>simulateFollowup({...ready,email:'new@example.com'}));
  assert.throws(()=>simulateFollowup(ready,{...defaults,cities:['Ottawa']}));
  assert.throws(()=>approveFollowup(editFollowup(ready,'','')));
});
test('reply blocks all subsequent follow-up operations before or after approval',()=>{
  assert.throws(()=>simulateReply(approved(),'Hello'));assert.throws(()=>simulateReply(sent(),' '));
  for(const lead of [sent(),approveFollowup(generateFollowup(sent())),simulateFollowup(approveFollowup(generateFollowup(sent())))]){
    const replied=simulateReply(lead,'Please send a plan.');assert.equal(replied.outreach_status,'Simulated replied');assert.equal(replied.reply.simulated,true);
    assert.throws(()=>generateFollowup(replied));assert.throws(()=>approveFollowup(replied));assert.throws(()=>simulateFollowup(replied));assert.throws(()=>simulateReply(replied,'Again'));
  }
});
test('delivered records remain historical after scoring changes and JSON persistence',()=>{
  const complete=simulateReply(simulateFollowup(approveFollowup(generateFollowup(sent()))),'Thanks');
  const restored=JSON.parse(JSON.stringify(complete));assert.deepEqual(reconcileApproval(restored,{...defaults,cities:['Ottawa']}),restored);assert.equal(restored.outbox.length,2);assert.equal(restored.reply.body,'Thanks');assert.ok(restored.activity.some(e=>e.type==='Follow-up simulated sent'));assert.ok(restored.activity.every(e=>e.at));
});
