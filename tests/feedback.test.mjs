import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {defaults,toCriteria,validateRules,scoreLead} from '../app/domain/scoring.mjs';
import {sourceColumns,columnValue,matchesColumns} from '../app/ui/columns.mjs';
import {parseCSV,prepareImport,fields} from '../app/domain/leads.mjs';
import {generateDraft,editDraft,approveDraft} from '../app/domain/outreach.mjs';
import {applyBatch} from '../app/domain/batch.mjs';
const lead={lead_id:'one',company:'Example',first_name:'Alex',email:'alex@example.com',job_title:'Office Manager',city:'Toronto',office_employees:50,avg_daily_onsite:25,industry:'Consulting',purchasing_method:'manual shopping'};
const custom={cities:defaults.cities,medium:10,high:25,criteria:[{name:'Industry fit',field:'industry',weight:20,cases:[{operator:'contains',value:'consult',points:20}]},{name:'Size fit',field:'office_employees',weight:30,cases:[{operator:'between',value:20,to:100,points:30},{operator:'gte',value:40,points:15}]}]};
test('legacy saved rules migrate without changing scores across the complete fixture',()=>{
  const parsed=parseCSV(readFileSync(new URL('../data/demo-leads.csv',import.meta.url),'utf8'));
  const leads=prepareImport(parsed,Object.fromEntries(fields.map(f=>[f,f]))).accepted;
  const migrated={cities:defaults.cities,medium:defaults.medium,high:defaults.high,criteria:toCriteria(defaults)};
  for(const item of leads){const a=scoreLead(item),b=scoreLead(item,migrated);assert.equal(b.score,a.score,item.lead_id);assert.equal(b.eligibility,a.eligibility);}
});
test('custom criteria use highest matching condition, unknown handling and configurable columns',()=>{
  assert.equal(scoreLead(lead,custom).score,50);
  assert.equal(scoreLead({...lead,industry:''},custom).score,30);
  assert.equal(scoreLead({...lead,industry:'Other',office_employees:200},custom).score,15);
  const presence={...custom,criteria:[{name:'Data',field:'industry',weight:30,cases:[{operator:'missing',points:10},{operator:'present',points:30}]}]};
  assert.equal(scoreLead({...lead,industry:''},presence).score,10);assert.equal(scoreLead(lead,presence).score,30);
  assert.throws(()=>validateRules({...custom,criteria:[{...custom.criteria[0],cases:[{operator:'equals',value:'A',points:25}]}]}));
  assert.throws(()=>validateRules({...custom,criteria:[{...custom.criteria[0],cases:[{operator:'between',value:10,to:5,points:20}]}]}));
});
test('unmapped imported fields survive safely and support scoring and filters',()=>{
  const imported=prepareImport(parseCSV('Company,Email,Annual budget,__proto__\nExample,alex@example.com,5000,safe'),{company:'Company',email:'Email'}).accepted[0];
  assert.equal(imported.extra_fields['Annual budget'],'5000');assert.equal(imported.extra_fields.__proto__,'safe');
  assert.ok(sourceColumns([imported]).some(c=>c.key==='custom:Annual budget'));
  const rules={...custom,medium:5,high:10,criteria:[{name:'Budget',field:'custom:Annual budget',weight:20,cases:[{operator:'gte',value:1000,points:20}]}]};
  const result=scoreLead(imported,rules);assert.equal(result.score,20);assert.ok(matchesColumns(imported,result,{'custom:Annual budget':{min:3000,max:6000}}));
});
test('column filters combine, distinguish blanks from zero and allow empty selection',()=>{
  const result=scoreLead(lead);assert.ok(matchesColumns(lead,result,{industry:{values:['Consulting']},score:{min:80,max:100}}));
  assert.equal(matchesColumns(lead,result,{industry:{values:[]}}),false);
  assert.equal(matchesColumns({...lead,office_employees:''},result,{office_employees:{min:0}}),false);
  assert.ok(matchesColumns({...lead,office_employees:0},result,{office_employees:{values:['0'],min:0,max:0}}));
  assert.equal(columnValue({...lead,email:''},result,'data'),'Needs attention');
});
test('bulk sends require saved current approval, skip blocked records, and prevent duplicates',()=>{
  const first=generateDraft(lead),second=generateDraft({...lead,lead_id:'two',email:'second@example.com'});
  const preview=[first,second];assert.equal(applyBatch([first,second],preview,defaults,'send').accepted.length,0);
  const approval=applyBatch([first,second],preview,defaults,'approve');assert.equal(approval.accepted.length,2);
  const sent=applyBatch(approval.accepted,preview,defaults,'send');assert.equal(sent.accepted.length,2);assert.equal(sent.accepted[0].outbox[0].body,first.draft.body);
  assert.equal(applyBatch(sent.accepted,preview,defaults,'send').accepted.length,0);
  const mixed=applyBatch([approveDraft(first),second],preview,defaults,'send');assert.equal(mixed.accepted.length,1);assert.equal(mixed.excluded.length,1);
  const edited=editDraft(approveDraft(first),'Changed subject',first.draft.body);
  assert.equal(applyBatch([edited],[first],defaults,'send').accepted.length,0);
  assert.equal(applyBatch([approveDraft(first)],[first,first],defaults,'send').accepted.length,1);
  assert.equal(applyBatch([approveDraft(first)],[first],{...defaults,cities:['Ottawa']},'send').accepted.length,0);
});
