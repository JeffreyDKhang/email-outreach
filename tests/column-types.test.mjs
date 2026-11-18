import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inferColumnType,columnType,allowedOperators,validateConditionTypes,pointsError} from '../app/domain/column-types.mjs';
import {genericDefaults,validateRules} from '../app/domain/scoring.mjs';
import {createDataset,validateWorkspace} from '../app/domain/datasets.mjs';
import {mountTable} from '../app/ui/table-ui.mjs';
import {mountScoring} from '../app/ui/scoring-ui.mjs';

const leads=[{lead_id:'a',company:'A',values:{Name:'Alice',Size:'25',Code:'00123'}},{lead_id:'b',company:'B',values:{Name:'Bob',Size:'50',Code:'00124'}}];
const columns=['Name','Size','Code'].map(label=>({key:'csv:'+label,label}));
test('column inference is conservative and overrides preserve original values',()=>{
  for(const values of [[],['',' '],['001','002'],['10','unknown'],['0x10'],['Infinity']])assert.equal(inferColumnType(values),'text');
  assert.equal(inferColumnType(['',' -2.5 ','0','.5','100']),'number');
  assert.equal(columnType(leads,'csv:Size'),'number');
  assert.equal(columnType(leads,'csv:Code'),'text');
  assert.equal(columnType(leads,'csv:Size',{'csv:Size':'text'}),'text');
  assert.equal(columnType(leads,'csv:Code',{'csv:Code':'number'}),'number');
  assert.equal(leads[0].values.Code,'00123');
  assert.equal(columnType([{extra_fields:{Budget:10}}],'custom:Budget'),'number');
});
test('shared operator policy detects conflicts across criteria, eligibility and segments without rewriting',()=>{
  assert.ok(!allowedOperators('text').includes('between'));
  assert.ok(allowedOperators('number').includes('between'));
  const condition={field:'csv:Name',operator:'gte',value:10};
  for(const extra of [{criteria:[{...condition,cases:[condition]}]},{eligibility:[condition]},{segments:[{name:'X',conditions:[condition]}]}]){
    const rules={...structuredClone(genericDefaults),...extra},before=structuredClone(rules);
    assert.throws(()=>validateConditionTypes(rules,leads),/incompatible/);
    assert.deepEqual(rules,before);
    validateConditionTypes({...rules,columnTypes:{'csv:Name':'number'}},leads);
  }
});
test('point limits and override metadata validate and survive workspace reload',()=>{
  for(const value of [20,-1,'',NaN])assert.match(pointsError(value,10),/between 0 and 10/);
  assert.equal(pointsError(10,10),'');
  const rules={...structuredClone(genericDefaults),medium:3,high:8,columnTypes:{'csv:Code':'text'},criteria:[{name:'Size',field:'csv:Size',weight:10,cases:[{operator:'present',points:20}]}]};
  assert.throws(()=>validateRules(rules),/points/);
  rules.criteria[0].cases[0].points=10;
  const dataset={...createDataset('Test',leads),rules};
  const restored=validateWorkspace(JSON.parse(JSON.stringify({version:1,activeId:dataset.id,datasets:[dataset]})));
  assert.equal(restored.datasets[0].rules.columnTypes['csv:Code'],'text');
  assert.throws(()=>validateRules({...rules,columnTypes:{x:'date'}}),/Column types/);
});
test('ICP editor renders type-specific operators, relevant bounds and preserved conflicts',()=>{
  const previous=globalThis.document,previousConfirm=globalThis.confirm,elements=new Map();
  const element=()=>({value:'',textContent:'',html:'',before(){},querySelectorAll(){return [];},showModal(){},close(){},set innerHTML(value){this.html=value;for(const match of value.matchAll(/id="([^"]+)"/g))elements.set(match[1],element());}});
  for(const id of ['scoring-criteria','weight-fields','eligibility-rules','segment-rules','rule-medium','rule-high','rules-error','rules-maximum','priority-summary','settings','settings-dialog','close-settings','blank-rules','add-criterion','add-segment','rules-form'])elements.set(id,element());
  globalThis.document={getElementById:id=>elements.get(id),createElement:element};
  let rules={...structuredClone(genericDefaults),criteria:[{name:'Name',field:'csv:Name',weight:10,cases:[{operator:'present',points:10}]}]};
  try{
    mountScoring({getLeads:()=>leads,getColumns:()=>columns,getRules:()=>rules,onSave(){},escape:String});
    elements.get('settings').onclick();
    let html=elements.get('weight-fields').html;
    assert.doesNotMatch(html,/Upper bound|data-field="value"|value="between"/);
    assert.match(html,/max="10"/);
    assert.match(elements.get('priority-summary').textContent,/thresholds/);
    elements.get('rule-medium').value='3';elements.get('rule-high').value='8';elements.get('rule-high').oninput();
    assert.match(elements.get('priority-summary').textContent,/Low priority: 0 to below 3/);
    assert.match(elements.get('priority-summary').textContent,/High priority: 8 and above/);
    const points={value:'20',nextElementSibling:{textContent:''},setCustomValidity(message){this.error=message;},setAttribute(){}},weight={value:'10'};
    const box={dataset:{group:'criteria',index:'0'},querySelector:()=>weight,querySelectorAll:()=>[points]};
    elements.get('weight-fields').querySelectorAll=()=>[box];
    const change=(field,value,condition)=>elements.get('weight-fields').oninput({target:{dataset:{field},value,closest:selector=>selector==='[data-group]'?box:condition?{dataset:{condition:'0'}}:null}});
    change('points','20',true);assert.equal(points.max,'10');assert.match(points.error,/between 0 and 10/);
    points.value='8';change('points','8',true);assert.equal(points.error,'');
    weight.value='5';change('weight','5',false);assert.match(points.error,/between 0 and 5/);
    elements.get('weight-fields').querySelectorAll=()=>[];

    rules.criteria[0]={name:'Size',field:'csv:Size',weight:10,cases:[{operator:'between',value:10,to:30,points:10}]};
    elements.get('settings').onclick();html=elements.get('weight-fields').html;
    assert.match(html,/Lower bound/);assert.match(html,/Upper bound/);assert.match(html,/value="gte"/);
    rules.criteria[0].field='csv:Name';elements.get('settings').onclick();
    assert.match(elements.get('weight-fields').html,/incompatible/);
    globalThis.confirm=()=>false;elements.get('blank-rules').onclick();
    assert.match(elements.get('weight-fields').html,/incompatible/);
    globalThis.confirm=()=>true;elements.get('blank-rules').onclick();
    assert.equal(elements.get('weight-fields').html,'');

  }finally{globalThis.document=previous;globalThis.confirm=previousConfirm;}
});

test('table filter hides text ranges and shares explicit numeric overrides',()=>{
  const previousDocument=globalThis.document,previousWindow=globalThis.window,elements=new Map();
  function element(){return {value:'',hidden:false,style:{},textContent:'',offsetWidth:100,offsetHeight:100,showModal(){},close(){},checkValidity(){return true;},querySelectorAll(){return [];},set innerHTML(value){for(const match of value.matchAll(/id="([^"]+)"/g))elements.set(match[1],element());}};}
  elements.set('table-head',element());
  globalThis.document={getElementById:id=>elements.get(id),createElement:element,body:{append(){}}};
  globalThis.window={innerWidth:1000,innerHeight:800};
  let types={};
  try{
    mountTable({getLeads:()=>leads,getColumns:()=>columns,getTypes:()=>types,score:()=>({}),escape:String,onChange(){}});
    const open=key=>elements.get('table-head').onclick({target:{closest:()=>({dataset:{column:key},getBoundingClientRect:()=>({left:0,bottom:0})})}});
    open('csv:Name');assert.equal(elements.get('column-range').hidden,true);
    open('csv:Size');assert.equal(elements.get('column-range').hidden,false);
    open('csv:Code');assert.equal(elements.get('column-range').hidden,true);
    types={'csv:Code':'number'};open('csv:Code');assert.equal(elements.get('column-range').hidden,false);
  }finally{globalThis.document=previousDocument;globalThis.window=previousWindow;}
});
