import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addDatasetRow,deleteDatasetRows,addDatasetColumn,deleteDatasetColumn,exportDatasetCSV} from '../app/domain/dataset-tools.mjs';
import {createDataset,validateWorkspace} from '../app/domain/datasets.mjs';
import {parseCSV,importCSV} from '../app/domain/leads.mjs';
import {datasetColumns} from '../app/domain/lead-schema.mjs';
import {generateDraft,approveDraft,approvalIssues} from '../app/domain/outreach.mjs';
import {genericDefaults} from '../app/domain/scoring.mjs';
import {prepareAppend,suggestAppendMapping} from '../app/domain/append-import.mjs';
import {mountDatasetTools} from '../app/ui/dataset-tools-ui.mjs';

const dataset=()=>createDataset('List',importCSV(parseCSV('Name,Email,Size\nAda,ada@company.test,0010'),'Email').accepted);
test('manual row add validates recipients and duplicates and preserves existing records/settings',()=>{
  const old=dataset(),snapshot=structuredClone(old);
  const next=addDatasetRow(old,{'csv:Name':'Ben','csv:Email':'ben@company.test','csv:Size':'0020'});
  assert.deepEqual(old,snapshot);assert.equal(next.leads.length,2);
  assert.deepEqual(next.leads[0],old.leads[0]);assert.deepEqual(next.rules,old.rules);
  assert.equal(next.leads[1].values.Size,'0020');assert.notEqual(next.leads[0].lead_id,next.leads[1].lead_id);
  assert.throws(()=>addDatasetRow(old,{'csv:Email':'ADA@company.test'}),/Duplicate/);
  assert.throws(()=>addDatasetRow(old,{'csv:Email':'invalid'}),/Invalid/);
  assert.throws(()=>addDatasetRow(old,{}),/at least one/);
});
test('deleting all rows preserves schema through JSON reload, manual add and CSV append',()=>{
  const old=dataset(),empty=JSON.parse(JSON.stringify(deleteDatasetRows(old,[old.leads[0].lead_id])));
  validateWorkspace({version:1,activeId:empty.id,datasets:[empty]});
  assert.equal(empty.leads.length,0);assert.deepEqual(datasetColumns(empty).map(c=>c.label),['Name','Email','Size']);
  assert.equal(parseCSV(exportDatasetCSV(addDatasetRow(empty,{'csv:Name':'New'}))).rows[0][0],'New');
  const parsed=parseCSV('Size,Email,Name\n0020,ben@company.test,Ben');
  assert.equal(prepareAppend(parsed,empty,suggestAppendMapping(parsed,empty).mapping).accepted.length,1);
  assert.throws(()=>deleteDatasetRows(old,[]),/Select/);
  assert.throws(()=>deleteDatasetRows(old,['missing']),/changed/);
});
test('column addition/removal updates schema and source snapshots without changing identity',()=>{
  const old=dataset();old.leads=[approveDraft(generateDraft(old.leads[0],old.templates,'merge',old.rules),old.rules)];
  const added=addDatasetColumn(old,'Notes');
  assert.equal(added.leads[0].values.Notes,'');assert.equal(old.leads[0].values.Notes,undefined);
  assert.equal(added.leads[0].approval,null);assert.equal(added.leads[0].lead_id,old.leads[0].lead_id);
  assert.ok(approvalIssues(added.leads[0],added.rules).some(reason=>reason.includes('Source data changed')));
  assert.throws(()=>addDatasetColumn(added,'Notes'),/already/);
  const removed=deleteDatasetColumn(added,'csv:Size');
  assert.deepEqual(datasetColumns(removed).map(c=>c.label),['Name','Email','Notes']);
  assert.equal(Object.hasOwn(removed.leads[0].values,'Size'),false);
  assert.throws(()=>deleteDatasetColumn(removed,'csv:Email'),/recipient/);
  assert.throws(()=>deleteDatasetColumn(removed,'score'),/source column/);
  const historical={...old,leads:[{...old.leads[0],live_delivery:{status:'queued'}}]};
  assert.throws(()=>addDatasetColumn(historical,'Notes'),/read-only/);
  assert.throws(()=>deleteDatasetColumn(historical,'csv:Size'),/read-only/);
});
test('deletion blocks references in ICP conditions, segments, templates',()=>{
  for(const patch of [
    {rules:{...genericDefaults,criteria:[{name:'Size',field:'csv:Size',weight:100,cases:[{operator:'present',points:100}]}]}},
    {rules:{...genericDefaults,eligibility:[{field:'csv:Size',operator:'present'}]}},
    {rules:{...genericDefaults,segments:[{name:'Large',conditions:[{field:'csv:Size',operator:'present'}]}]}},
    {templates:{General:{subject:'Hi',body:'Size {{Size}}'},_columns:['Size']}},
    {templates:{General:{subject:'Hi',body:'Size {{csv:Size}}'}}},
  ])assert.throws(()=>deleteDatasetColumn({...dataset(),...patch},'csv:Size'),/references/);
});
test('CSV export includes all current source values and handles Unicode, quotes, line breaks and reserved headers',()=>{
  const lead=importCSV({headers:['lead_id','Email','Notes','Size'],rows:[['external','','Hello, "world"\nCaf\u00e9','0007']]},'Email').accepted[0];
  const old=createDataset('Export',[lead]);
  const csv=exportDatasetCSV(old),parsed=parseCSV(csv);
  assert.deepEqual(parsed.headers,['lead_id','Email','Notes','Size']);
  assert.deepEqual(parsed.rows,[['external','','Hello, "world"\nCaf\u00e9','0007']]);
  assert.ok(!parsed.headers.includes('approval'));assert.ok(!csv.includes(lead.lead_id));
  assert.equal(exportDatasetCSV(deleteDatasetRows(old,[lead.lead_id])), '\uFEFF"lead_id","Email","Notes","Size"\r\n');
});
test('legacy schema removal persists and custom columns/rows remain compatible',()=>{
  const old=createDataset('Old',[{lead_id:'old',company:'Company',email:'old@company.test',city:'Toronto'}]);
  const removed=deleteDatasetColumn(old,'industry');
  assert.ok(!datasetColumns(removed).some(c=>c.key==='industry'));
  const added=addDatasetColumn(removed,'Note'),next=addDatasetRow(added,{company:'New',email:'new@company.test','custom:Note':'Hello'});
  assert.equal(next.leads[1].extra_fields.Note,'Hello');
  assert.equal(next.leads[1].values,undefined);
  validateWorkspace({version:1,activeId:next.id,datasets:[next]});
});
test('Data tools requires confirmation; Cancel and failed persistence leave rows unchanged',async()=>{
  const previous=globalThis.document,elements=new Map();
  function element(){return {hidden:false,open:false,textContent:'',value:'',showModal(){this.open=true;},close(){this.open=false;},set innerHTML(html){for(const match of html.matchAll(/id="([^"]+)"/g))elements.set(match[1],element());}};}
  elements.set('open-data-tools',element());
  globalThis.document={getElementById:id=>elements.get(id),createElement:()=>element(),body:{append(node){elements.set(node.id,node);}}};
  let data=dataset(),writes=0,fail=false;const snapshot=structuredClone(data);
  try{
    mountDatasetTools({getDataset:()=>data,getSelectedIds:()=>[data.leads[0].lead_id],onSave(next){writes++;if(fail)return false;data=next;return true;},escape:String,notice(){}});
    elements.get('open-data-tools').onclick();
    const remove=()=>elements.get('data-tools-menu').onclick({target:{closest:()=>({dataset:{tool:'row-delete'}})}});
    remove();assert.equal(writes,0);elements.get('cancel-data-tool').onclick();assert.deepEqual(data,snapshot);
    remove();fail=true;await elements.get('data-tools-form').onsubmit({preventDefault(){}});
    assert.deepEqual(data,snapshot);assert.match(elements.get('data-tools-error').textContent,/Unable to save/);
    fail=false;await elements.get('data-tools-form').onsubmit({preventDefault(){}});
    assert.equal(data.leads.length,0);assert.equal(elements.get('dataset-tools-dialog').open,false);
  }finally{globalThis.document=previous;}
});

test('outreach report matches table values under current rules and leaves source export unchanged',async()=>{
  const {scoreLead}=await import('../app/domain/scoring.mjs');
  const {columnValue}=await import('../app/ui/columns.mjs');
  const {outreachColumns}=await import('../app/domain/outreach-report.mjs');
  const data=dataset();
  data.rules={...genericDefaults,criteria:[{name:'Size',field:'csv:Size',weight:100,cases:[{operator:'gte',value:10,points:100}]}],segments:[{name:'Small team',conditions:[{field:'csv:Size',operator:'present'}]}]};
  data.leads[0].outreach_status='Drafted';
  const before=structuredClone(data),source=parseCSV(exportDatasetCSV(data)),report=parseCSV(exportDatasetCSV(data,'report'));
  assert.deepEqual(source.headers,['Name','Email','Size']);
  assert.deepEqual(report.headers.slice(3),outreachColumns.map(column=>column.label));
  assert.deepEqual(report.rows[0].slice(3),outreachColumns.map(column=>String(columnValue(data.leads[0],scoreLead(data.leads[0],data.rules),column.key,datasetColumns(data)))));
  assert.deepEqual(report.rows[0].slice(3),['Small team','100','High','Eligible','Qualified','Drafted','Complete']);
  assert.deepEqual(data,before);
  data.rules={...genericDefaults};
  const fresh=parseCSV(exportDatasetCSV(data,'report'));
  assert.deepEqual(fresh.rows[0].slice(3,8),['General','0','Unscored','Eligible','Not qualified']);
});
test('report column collisions preserve source values and generate unique headers',()=>{
  const rows=importCSV({headers:['Email','Score','Score (outreach)','Data quality'],rows:[['','original','also original','source quality']]},'Email').accepted;
  const data=createDataset('Collision',rows),parsed=parseCSV(exportDatasetCSV(data,'report'));
  assert.equal(new Set(parsed.headers).size,parsed.headers.length);
  assert.deepEqual(parsed.rows[0].slice(0,4),['','original','also original','source quality']);
  assert.equal(parsed.rows[0][parsed.headers.indexOf('Score (outreach 2)')],'0');
  assert.equal(parsed.rows[0][parsed.headers.indexOf('Data quality (outreach)')],'Needs attention');
});
test('empty outreach report retains source and derived headers and rejects unknown export modes',()=>{
  const data=dataset(),empty=deleteDatasetRows(data,[data.leads[0].lead_id]);
  const csv=exportDatasetCSV(empty,'report');
  assert.ok(csv.includes('"Score","Priority","Eligibility","Qualification","Outreach status","Data quality"'));
  assert.equal(csv.split('\r\n').length,2);
  assert.throws(()=>exportDatasetCSV(data,'backup'),/Choose/);
});
