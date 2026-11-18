import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseCSV,importCSV} from '../app/domain/leads.mjs';
import {sourceColumns,sourceValue,warnings} from '../app/domain/lead-schema.mjs';
import {genericDefaults,defaults,scoreLead,validateRules} from '../app/domain/scoring.mjs';
import {generateDraft,approveDraft,approvalIssues,isApproved,editDraft} from '../app/domain/outreach.mjs';
import {applyBatch} from '../app/domain/batch.mjs';
import {generateFollowup,approveFollowup,simulateInitial} from '../app/domain/delivery.mjs';
import {prepareLiveBatch} from '../server/sending.mjs';
const k=header=>'csv:'+encodeURIComponent(header);
const raw=()=>importCSV(parseCSV('Person,Contact address,Department,Budget,\"Custom {{field}}\"\nAlex,alex@company.test,Finance,5000,Exact value'), 'Contact address').accepted[0];
const rules={...genericDefaults,criteria:[{name:'Budget',field:k('Budget'),weight:100,cases:[{operator:'gte',value:1000,points:100}]}],eligibility:[{field:k('Contact address'),operator:'present'}],segments:[{name:'Finance',conditions:[{field:k('Department'),operator:'equals',value:'Finance'}]}]};
const copy={General:{subject:'Hello',body:'General introduction'},Finance:{subject:'For {{csv:Department}}',body:'Hi {{csv:Person}}, budget {{csv:Budget}}.'}};
test('native import preserves exact headers and values and asks only for email column',()=>{
  const parsed=parseCSV('Display Name, Mailbox ,001 code,Empty\n  Alex  ,a@company.test,0012,');
  const result=importCSV(parsed,' Mailbox ');assert.equal(result.rejected.length,0);assert.equal(result.accepted.length,1);
  const lead=result.accepted[0];assert.equal(lead.values['Display Name'],'  Alex  ');assert.equal(lead.values['001 code'],'0012');
  assert.deepEqual(sourceColumns([lead]).map(c=>c.label),parsed.headers);assert.equal(sourceColumns([lead]).some(c=>c.key==='company'),false);assert.equal(lead.email,'a@company.test');
  assert.throws(()=>importCSV(parsed,'missing'));assert.equal(importCSV(parsed,' Mailbox ',result.accepted).rejected.length,1);
});
test('four-lead renamed fixture imports without company/role mappings and preserves blank recipients',()=>{
  const parsed=parseCSV(readFileSync(new URL('../data/renamed-columns-leads.csv',import.meta.url),'utf8'));
  for(const row of parsed.rows)row[parsed.headers.indexOf('Work Email')]='';
  const result=importCSV(parsed,'Work Email');assert.equal(result.accepted.length,4);assert.equal(result.rejected.length,0);
  for(const lead of result.accepted){assert.equal(lead.email,'');assert.ok(warnings(lead).includes('Work Email'));assert.equal(scoreLead(lead,defaults).eligibility,'Eligible');assert.equal(scoreLead(lead,defaults).segment,'General');}
});
test('CSV scoring/eligibility/segments use source columns without OfficePantry requirements',()=>{
  const lead=raw(),result=scoreLead(lead,rules);assert.equal(result.score,100);assert.equal(result.qualified,true);assert.equal(result.segment,'Finance');assert.equal(result.eligibility,'Eligible');
  assert.equal(scoreLead({...lead,values:{...lead.values,Budget:'0'}},rules).score,0);
  assert.equal(scoreLead(lead,genericDefaults).segment,'General');assert.equal(scoreLead(lead,genericDefaults).eligibility,'Eligible');
  const restrictive={...rules,eligibility:[{field:k('Budget'),operator:'gte',value:6000}]};assert.equal(scoreLead(lead,restrictive).eligibility,'Ineligible');assert.equal(scoreLead({...lead,values:{...lead.values,Budget:''}},restrictive).eligibility,'Needs data');
  assert.throws(()=>validateRules({...rules,segments:[{name:'General',conditions:rules.eligibility}]}));
});
test('source variables, segment templates and raw-data changes participate in approval',()=>{
  const lead=raw(),draft=generateDraft(lead,copy,'merge',rules);assert.equal(draft.draft.body,'Hi Alex, budget 5000.');assert.equal(draft.draft.subject,'For Finance');
  const approved=approveDraft(draft,rules);assert.ok(isApproved(approved,rules));
  assert.equal(isApproved({...approved,values:{...approved.values,Person:'Another person'}},rules),false);
  assert.equal(isApproved({...approved,values:{...approved.values,'Contact address':'other@company.test'}},rules),false);
  assert.equal(isApproved(approved,{...rules,segments:[]}),false);
  const absent=generateDraft(lead,{General:{subject:'Hi',body:'Hello {{csv:Missing}}'}},'merge',genericDefaults);assert.ok(approvalIssues(absent,genericDefaults).some(s=>s.includes('Missing template values')));
  assert.equal(approvalIssues(editDraft(absent,'Hi','Reviewed message'),genericDefaults).length,0);
  const direct=generateDraft(lead,{General:{subject:'Hi',body:'Hello {{Person}}'},_columns:['Person']});assert.equal(direct.draft.body,'Hello Alex');
});
test('arbitrary headers, reserved names and blank email do not collide with internal metadata',()=>{
  const lead=raw();assert.equal(sourceValue(lead,k('Custom {{field}}')),'Exact value');
  assert.equal(generateDraft(lead,{General:{subject:'Hi',body:'{{'+k('Custom {{field}}')+'}}'}}).draft.body,'Exact value');
  const collision=importCSV(parseCSV('lead_id,email,status,__proto__\nsource-value,a@company.test,source-status,source-prototype'),'email').accepted[0];
  assert.notEqual(collision.lead_id,'source-value');assert.equal(sourceValue(collision,k('status')),'source-status');assert.equal(sourceValue(collision,k('__proto__')),'source-prototype');
  assert.equal(sourceValue(collision,k('constructor')),'');
  const blank=importCSV(parseCSV('Name,Mailbox\nSomeone,'),'Mailbox').accepted[0];assert.throws(()=>approveDraft(generateDraft(blank),genericDefaults));
});
test('CSV-native record completes simulated follow-up and backend validates selected recipient',()=>{
  const approved=approveDraft(generateDraft(raw(),copy,'merge',rules),rules);
  assert.equal(applyBatch([approved],[approved],rules,'send').accepted.length,1);
  const followup=generateFollowup(simulateInitial(approved,rules),rules);assert.ok(approveFollowup(followup,rules).followup.approval);
  const preview=prepareLiveBatch([approved],rules,{id:'google',email:'sender@company.test',provider:'gmail'},[]);assert.equal(preview.items[0].recipient,'alex@company.test');assert.equal(preview.items[0].body,approved.draft.body);
  const altered={...approved,email:'wrong@company.test'};assert.throws(()=>prepareLiveBatch([altered],rules,{id:'google',email:'sender@company.test',provider:'gmail'},[]));
});
