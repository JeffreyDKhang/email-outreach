import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDataset} from '../app/domain/datasets.mjs';
import {parseCSV,importCSV} from '../app/domain/leads.mjs';
import {prepareAppend,suggestAppendMapping} from '../app/domain/append-import.mjs';
import {generateDraft,approveDraft,isApproved} from '../app/domain/outreach.mjs';
import {sourceColumns} from '../app/domain/lead-schema.mjs';

function dataset(){return createDataset('Customers',importCSV(parseCSV('Name,Email,Size\nAda,ada@example.com,0010'),'Email').accepted);}
test('same headers in any order align automatically while preserving target schema and values',()=>{
  const target=dataset(),parsed=parseCSV('Size,Name,Email\n0020,Ben,ben@example.com');
  const plan=suggestAppendMapping(parsed,target);
  assert.equal(plan.exact,true);
  const result=prepareAppend(parsed,target,plan.mapping);
  assert.equal(result.accepted.length,1);
  assert.deepEqual(result.accepted[0].values,{Name:'Ben',Email:'ben@example.com',Size:'0020'});
  assert.equal(result.accepted[0].recipient_column,'Email');
  assert.notEqual(result.accepted[0].lead_id,target.leads[0].lead_id);
  assert.deepEqual(sourceColumns([...target.leads,...result.accepted]).map(c=>c.label),['Name','Email','Size']);
});
test('different headers require explicit recipient mapping; extras can be ignored and fields left blank',()=>{
  const target=dataset(),parsed=parseCSV('Full Name,Work Address,Notes\nBen,ben@example.com,Unused');
  assert.equal(suggestAppendMapping(parsed,target).exact,false);
  assert.throws(()=>prepareAppend(parsed,target,{}),/recipient/);
  const result=prepareAppend(parsed,target,{'csv:Name':'Full Name','csv:Email':'Work Address','csv:Size':''});
  assert.deepEqual(result.accepted[0].values,{Name:'Ben',Email:'ben@example.com',Size:''});
  assert.equal(result.accepted[0].email,'ben@example.com');
  assert.throws(()=>prepareAppend(parsed,target,{'csv:Name':'Full Name','csv:Email':'Full Name'}),/only once/);
  assert.throws(()=>prepareAppend(parsed,target,{'csv:Email':'Nonexistent'}),/imported CSV/);
});
test('append rejects existing and within-file duplicates and invalid recipients, allowing blank emails',()=>{
  const target=dataset(),parsed=parseCSV('Name,Email,Size\nOther,ADA@example.com,30\nBen,ben@example.com,20\nAgain,BEN@example.com,20\nBad,bad-address,20\nBlank,,20\nBlank,,20');
  const result=prepareAppend(parsed,target,suggestAppendMapping(parsed,target).mapping);
  assert.equal(result.accepted.length,2);
  assert.equal(result.rejected.length,4);
  assert.deepEqual(result.rejected.map(row=>row.row),[2,4,5,7]);
  const updated={...target,leads:[...target.leads,...result.accepted]};
  assert.equal(prepareAppend(parsed,updated,suggestAppendMapping(parsed,updated).mapping).accepted.length,0);
});
test('append preserves existing approval/history, settings and template variables',()=>{
  const target=dataset();target.templates.General={subject:'Hello {{csv:Name}}',body:'A message for {{csv:Name}}'};
  target.leads=[approveDraft(generateDraft(target.leads[0],target.templates,'merge',target.rules),target.rules)];
  const snapshot=structuredClone(target),parsed=parseCSV('Name,Email,Size\nBen,ben@example.com,20');
  const result=prepareAppend(parsed,target,suggestAppendMapping(parsed,target).mapping);
  assert.deepEqual(target,snapshot);
  assert.equal(isApproved(target.leads[0],target.rules),true);
  const drafted=generateDraft(result.accepted[0],target.templates,'merge',target.rules);
  assert.equal(drafted.draft.subject,'Hello Ben');
});
test('legacy datasets accept mapped rows without mixing native schemas or overwriting IDs',()=>{
  const target=createDataset('Previous leads',[{lead_id:'original',company:'Old Co',email:'old@example.com',extra_fields:{Budget:'0010'}}]);
  const result=prepareAppend(parseCSV('Business,To,Amount\nNew Co,new@example.com,0020'),target,{company:'Business',email:'To','custom:Budget':'Amount'});
  assert.equal(result.accepted.length,1);
  assert.equal(result.accepted[0].company,'New Co');
  assert.equal(result.accepted[0].values,undefined);
  assert.equal(result.accepted[0].extra_fields.Budget,'0020');
  assert.notEqual(result.accepted[0].lead_id,'original');
  assert.throws(()=>suggestAppendMapping(parseCSV('Name,Email\nA,a@example.com'),createDataset('Empty',[])),/no columns/);
});
