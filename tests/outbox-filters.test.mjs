import {test} from 'node:test';
import assert from 'node:assert/strict';
import {outboxFields,outboxFieldType,filterOutbox,outboxFilterError,outboxFilterChoices,outboxForDataset,heldBatches} from '../app/domain/outbox-filters.mjs';
import {mountOutbox} from '../app/ui/outbox-ui.mjs';

const dataset={id:'list',columns:[{key:'csv:Name',label:'Name'},{key:'csv:Size',label:'Size'},{key:'csv:Code',label:'Code'},{key:'csv:Empty',label:'Empty'}],rules:{columnTypes:{}},leads:[{values:{Name:'Ada',Size:'40',Code:'001'}}]};
const message=(id,source)=>({id,status:'held',created:'2026-01-01T00:00:00Z',payload:{datasetId:'list',recipient:'test@company.test',subject:'Hello',source}});
const rows=[message('a',{Name:' Ada ',Size:'40',Code:'001'}),message('b',{Name:'Bob',Size:'80',Code:'002'}),message('c',{Name:'',Size:'',Code:''})];

test('Outbox exposes full dataset schema while empty and retains snapshot-only columns',()=>{
  const fields=outboxFields([], [{...dataset,leads:[]}]);
  for(const label of ['Name','Size','Code','Empty'])assert.ok(fields.some(field=>field.key==='source:'+label));
  assert.ok(outboxFields([message('old',{Removed:'historic'})],[dataset]).some(field=>field.key==='source:Removed'));
  assert.equal(outboxFieldType(rows,'source:Size',[dataset]),'number');
  assert.equal(outboxFieldType(rows,'source:Code',[dataset]),'text');
  assert.equal(outboxFieldType(rows,'source:Code',[{...dataset,rules:{columnTypes:{'csv:Code':'number'}}}]),'number');
});
test('Outbox conditions match shared scoring semantics, AND conditions, blanks and numeric bounds',()=>{
  const ids=conditions=>filterOutbox(rows,conditions,[dataset]).map(row=>row.id);
  assert.deepEqual(ids([{key:'source:Name',operator:'equals',value:'ada'}]),['a']);
  assert.deepEqual(ids([{key:'source:Name',operator:'not_equals',value:'ada'}]),['b']);
  assert.deepEqual(ids([{key:'source:Name',operator:'in',value:'ada, bob'}]),['a','b']);
  assert.deepEqual(ids([{key:'source:Size',operator:'gte',value:'40'},{key:'source:Size',operator:'lte',value:'60'}]),['a']);
  assert.deepEqual(ids([{key:'source:Size',operator:'between',value:'40',to:'80'}]),['a','b']);
  assert.deepEqual(ids([{key:'source:Name',operator:'missing'}]),['c']);
  assert.deepEqual(ids([{key:'source:Name',operator:'present'}]),['a','b']);
  assert.deepEqual(ids([{key:'source:Code',operator:'between',value:0,to:10}]),[]);
  assert.match(outboxFilterError({key:'source:Name',operator:'gte',value:4},rows,[dataset]),/compatible/);
  assert.match(outboxFilterError({key:'source:Size',operator:'between',value:80,to:20},rows,[dataset]),/upper bound/);
});
test('message filter fields exclude recipient/dataset and match saved content and used template',()=>{
  const fields=outboxFields([], [dataset]);
  assert.deepEqual(fields.filter(field=>field.group==='message').map(field=>field.key),['subject','body','templateName','segment','batch_name']);
  assert.ok(fields.filter(field=>field.group==='source').every(field=>field.key.startsWith('source:')));
  for(const key of ['recipient','datasetName'])assert.match(outboxFilterError({key,value:'test'},rows,[dataset]),/available field/);
  // CSV columns with similar names remain ordinary source fields.
  assert.ok(outboxFields([message('source',{Recipient:'Ada',Dataset:'Sales'})]).some(field=>field.key==='source:Recipient'));
  const messages=[
    {...message('subject',{Name:'Ada'}),payload:{subject:'Well, HELLO Ada',body:'A different message',templateName:'Sales',source:{Name:'Ada',Subject:'Other'}}},
    {...message('body',{Name:'Bob'}),payload:{subject:'Meeting request',body:'Hello from the team',templateName:'General',source:{Name:'Bob',Subject:'Hello'}}}
  ];
  const ids=filters=>filterOutbox(messages,filters,[dataset]).map(row=>row.id);
  assert.deepEqual(ids([{key:'subject',operator:'contains',value:'hello'}]),['subject']);
  assert.deepEqual(ids([{key:'body',operator:'contains',value:'HELLO'}]),['body']);
  assert.deepEqual(ids([{key:'templateName',operator:'equals',value:'Sales'}]),['subject']);
  assert.deepEqual(ids([{key:'templateName',operator:'equals',value:'Sales'},{key:'source:Name',operator:'equals',value:'Bob'}]),[]);
});
test('held batch choices use real batch IDs/counts and omit fully dispatched batches',()=>{
  const messages=[{...rows[0],batch_id:'first',batch_name:'Tuesday'},{...rows[1],batch_id:'first',batch_name:'Tuesday'},{...rows[2],batch_id:'sent',batch_name:'Old',status:'queued'}];
  assert.deepEqual(heldBatches(messages),[{id:'first',name:'Tuesday',count:2}]);
});
test('Template, Segment and Batch choices combine configured and frozen values with exact matching',()=>{
  const configured={...dataset,templates:{General:{},Sales:{},'Sales follow-up':{},_columns:[]},rules:{segments:[{name:'Small teams'},{name:'New segment'}]}};
  const messages=[
    {...rows[0],batch_name:'Tuesday, AM',payload:{...rows[0].payload,templateName:'Sales',segment:'Retired segment'}},
    {...rows[1],batch_name:'Tuesday, AM follow-up',payload:{...rows[1].payload,templateName:'Sales follow-up',segment:'Small teams'}},
    {...rows[2],payload:{...rows[2].payload,templateName:'__manual__',segment:''}}
  ];
  const choices=key=>outboxFilterChoices(messages,key,[configured]);
  assert.deepEqual(choices('templateName').map(choice=>choice.label).sort(),['General','Manually from scratch','Sales','Sales follow-up'].sort());
  for(const name of ['New segment','Retired segment','Small teams'])assert.ok(choices('segment').some(choice=>choice.value===name));
  assert.ok(choices('batch_name').some(choice=>choice.value===''&&choice.label==='No batch'));
  assert.deepEqual(filterOutbox(messages,[{key:'templateName',value:'Sales'}],[configured]).map(row=>row.id),['a']);
  assert.deepEqual(filterOutbox(messages,[{key:'batch_name',value:'Tuesday, AM'}],[configured]).map(row=>row.id),['a']);
  assert.deepEqual(filterOutbox(messages,[{key:'segment',value:''}],[configured]).map(row=>row.id),['c']);
  assert.deepEqual(filterOutbox(messages,[{key:'batch_name',value:''}],[configured]).map(row=>row.id),['c']);
  assert.deepEqual(filterOutbox(messages,[{key:'templateName',value:'Sales'},{key:'source:Size',operator:'gte',value:50}],[configured]),[]);
  assert.match(outboxFilterError({key:'templateName'},messages,[configured]),/Choose/);
  assert.deepEqual(filterOutbox(messages,[{key:'batch_name',value:'Deleted batch'}],[configured]),[]);
  assert.ok(outboxFilterChoices([],'templateName',[configured]).some(choice=>choice.value==='Sales'));
});
test('Outbox dataset scope uses stable IDs and excludes foreign or unattributed copies',()=>{
  const messages=[rows[0],{...rows[1],payload:{...rows[1].payload,datasetId:'other',datasetName:'Same name'}},{...rows[2],payload:{...rows[2].payload,datasetId:undefined}}];
  assert.deepEqual(outboxForDataset(messages,'list').map(row=>row.id),['a']);
  assert.deepEqual(outboxForDataset(messages,'other').map(row=>row.id),['b']);
  assert.deepEqual(outboxForDataset(messages,null),[]);
  assert.deepEqual(outboxForDataset(messages,''),[]);
});
test('opening another dataset isolates messages, templates, segments, CSV fields, batches and selections',async()=>{
  const previous=globalThis.document,elements=new Map();
  const lists=[
    {...dataset,name:'Import list',templates:{General:{},'Import template':{}},rules:{segments:[{name:'Import segment'}]}},
    {...dataset,id:'demo',name:'Office Pantry',templates:{General:{},'Demo template':{}},rules:{segments:[{name:'Demo segment'}]},columns:[{key:'csv:Demo',label:'Demo column'}]}
  ];
  let active=lists[0];
  const messages=lists.map((list,index)=>({...message('copy-'+index,{[index?'Demo snapshot':'Import snapshot']:'value'}),batch_id:'batch-'+index,batch_name:index?'Demo batch':'Import batch',payload:{...message('',{}).payload,datasetId:list.id,templateName:index?'Retired demo template':'Retired import template',segment:index?'Retired demo segment':'Retired import segment',source:{[index?'Demo snapshot':'Import snapshot']:'value'}}}));
  function element(){return {value:'',hidden:false,disabled:false,html:'',textContent:'',showModal(){},close(){},set innerHTML(html){this.html=html;for(const match of html.matchAll(/id="([^"]+)"/g))elements.set(match[1],element());}};}
  elements.set('outbox',element());
  globalThis.document={getElementById:id=>elements.get(id),createElement:element,body:{append(){}}};
  let sendIds;
  try{
    mountOutbox({getDataset:()=>active,api:async()=>({messages}),liveSender:{open:ids=>{sendIds=ids;}},escape:String,statusFactory:()=>({open(){}})});
    const open=async()=>{elements.get('outbox').onclick();await new Promise(resolve=>setImmediate(resolve));};
    const change=key=>elements.get('outbox-message-filters').onchange({target:{tagName:'SELECT',value:key,dataset:{outboxFilter:'key'},closest:()=>({dataset:{filterIndex:'0'}})}});
    await open();
    assert.equal(elements.get('outbox-title').textContent,'Outbox: Import list');
    assert.match(elements.get('outbox-messages').html,/copy-0/);
    assert.doesNotMatch(elements.get('outbox-messages').html,/copy-1/);
    elements.get('add-outbox-message-filter').onclick();
    for(const [key,own,foreign] of [['templateName','Import template','Demo template'],['segment','Import segment','Demo segment'],['batch_name','Import batch','Demo batch']]){
      change(key);
      assert.match(elements.get('outbox-message-filters').html,new RegExp(own));
      assert.doesNotMatch(elements.get('outbox-message-filters').html,new RegExp(foreign,'i'));
    }
    elements.get('add-outbox-filter').onclick();
    assert.match(elements.get('outbox-filters').html,/Import snapshot/);
    assert.doesNotMatch(elements.get('outbox-filters').html,/Demo column|Demo snapshot/);
    elements.get('clear-outbox-filters').onclick();elements.get('clear-outbox-message-filters').onclick();
    elements.get('outbox-select-visible').onclick();
    elements.get('outbox-send-selected').onclick();assert.deepEqual(sendIds,['copy-0']);
    elements.get('outbox-batch-filter').value='batch-0';
    elements.get('add-outbox-message-filter').onclick();
    active=lists[1];await open();
    assert.equal(elements.get('outbox-message-filters').html,'');
    assert.equal(elements.get('outbox-filters').html,'');
    assert.equal(elements.get('outbox-batch-filter').value,'');
    assert.equal(elements.get('outbox-send-selected').textContent,'Review selected send (0)');
    assert.match(elements.get('outbox-messages').html,/copy-1/);
    assert.doesNotMatch(elements.get('outbox-messages').html,/copy-0/);
    assert.doesNotMatch(elements.get('outbox-batch-filter').html,/Import batch/);
    elements.get('add-outbox-message-filter').onclick();change('templateName');
    assert.match(elements.get('outbox-message-filters').html,/Demo template/);
    assert.match(elements.get('outbox-message-filters').html,/Retired demo template/);
    assert.doesNotMatch(elements.get('outbox-message-filters').html,/Import template|Retired import template/);
  }finally{globalThis.document=previous;}
});
test('Outbox UI explains empty batch state and renders dataset conditions with type-aware inputs',async()=>{
  const previous=globalThis.document,elements=new Map();let messages=[];
  function element(){return {value:'',hidden:false,disabled:false,html:'',textContent:'',showModal(){},close(){},set innerHTML(html){this.html=html;for(const match of html.matchAll(/id="([^"]+)"/g))elements.set(match[1],element());}};}
  elements.set('outbox',element());
  globalThis.document={getElementById:id=>elements.get(id),createElement:element,body:{append(){}}};
  try{
    mountOutbox({getDataset:()=>dataset,api:async()=>({messages}),liveSender:{},escape:String,statusFactory:()=>({open(){}})});
    elements.get('outbox').onclick();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(elements.get('outbox-batch-selector').hidden,true);
    assert.match(elements.get('outbox-batch-hint').textContent,/No held batches/);
    assert.match(elements.get('outbox-messages').html,/No messages in Outbox/);
    assert.equal(elements.get('outbox-message-count').textContent,'0 of 0 held messages');
    elements.get('add-outbox-filter').onclick();
    assert.match(elements.get('outbox-filters').html,/CSV: Empty/);
    assert.doesNotMatch(elements.get('outbox-filters').html,/value="subject"|value="recipient"|value="datasetName"/);
    const change=(key,value)=>elements.get('outbox-filters').onchange({target:{tagName:'SELECT',value,dataset:{outboxFilter:key},closest:()=>({dataset:{filterIndex:'0'}})}});
    change('key','source:Size');change('operator','between');
    assert.match(elements.get('outbox-filters').html,/Lower bound/);assert.match(elements.get('outbox-filters').html,/Upper bound/);
    change('key','source:Name');assert.match(elements.get('outbox-filters').html,/incompatible/);
    change('operator','missing');assert.doesNotMatch(elements.get('outbox-filters').html,/data-outbox-filter="value"/);
    elements.get('add-outbox-message-filter').onclick();
    assert.match(elements.get('outbox-message-filters').html,/value="subject" selected/);
    assert.doesNotMatch(elements.get('outbox-message-filters').html,/CSV:|value="recipient"|value="datasetName"/);
    // Shared indices survive separate rendering and clearing either group.
    assert.match(elements.get('outbox-message-filters').html,/data-filter-index="1"/);
    elements.get('clear-outbox-filters').onclick();
    assert.equal(elements.get('outbox-filters').html,'');
    assert.match(elements.get('outbox-message-filters').html,/data-filter-index="0"/);
    elements.get('clear-outbox-message-filters').onclick();
    assert.equal(elements.get('outbox-message-filters').html,'');
    messages=[{...rows[0],batch_id:'batch-one',batch_name:'Test batch'}];
    await elements.get('outbox-refresh').onclick();
    assert.equal(elements.get('outbox-batch-selector').hidden,false);
    assert.match(elements.get('outbox-batch-filter').html,/Test batch \(1\)/);
    assert.equal(elements.get('outbox-message-count').textContent,'1 of 1 held messages');
    elements.get('outbox-select-visible').onclick();
    assert.equal(elements.get('outbox-selection-count').textContent,'(1)');
    elements.get('add-outbox-message-filter').onclick();
    const messageChange=(key,value)=>elements.get('outbox-message-filters').onchange({target:{tagName:'SELECT',value,dataset:{outboxFilter:key},closest:()=>({dataset:{filterIndex:'0'}})}});
    for(const key of ['templateName','segment','batch_name']){
      messageChange('key',key);
      const html=elements.get('outbox-message-filters').html;
      assert.match(html,/data-outbox-filter="choice"/);
      assert.doesNotMatch(html,/data-outbox-filter="operator"|<input/);
      assert.match(html,key==='batch_name'?/Test batch/:/General/);
    }
    messageChange('choice',JSON.stringify('Test batch'));
    assert.match(elements.get('outbox-messages').html,/Select message to/);
    messageChange('choice',JSON.stringify(''));
    assert.match(elements.get('outbox-messages').html,/No messages match these filters/);
    assert.equal(elements.get('outbox-message-count').textContent,'0 of 1 held messages');
    assert.equal(elements.get('outbox-selection-count').textContent,'(0)');
    messageChange('key','subject');
    assert.match(elements.get('outbox-message-filters').html,/data-outbox-filter="operator"/);
    assert.match(elements.get('outbox-message-filters').html,/value="contains" selected/);
  }finally{globalThis.document=previous;}
});
