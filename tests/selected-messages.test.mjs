import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mountBatch} from '../app/ui/batch-ui.mjs';
import {mountLiveSend} from '../app/ui/live-send-ui.mjs';
import {genericDefaults} from '../app/domain/scoring.mjs';

function mockDOM(ids){
  const previous=globalThis.document,elements=new Map();
  function element(){return {value:'',textContent:'',disabled:false,html:'',listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},showModal(){this.open=true;},close(){this.open=false;},querySelectorAll(){return [];},set innerHTML(value){this.html=value;for(const match of value.matchAll(/id="([^"]+)"/g))elements.set(match[1],element());}};}
  for(const id of ids)elements.set(id,element());
  globalThis.document={getElementById:id=>elements.get(id),createElement:element,body:{append(node){elements.set(node.id,node);}}};
  return {elements,restore(){globalThis.document=previous;}};
}
const rules=structuredClone(genericDefaults);
const raw={messageWorkflow:2,lead_id:'one',company:'Ada',email:'ada@company.test',recipient_column:'Email',values:{Name:'Ada',Email:'ada@company.test'}};

test('selected messages automatically save missing drafts and expose hold or instant confirmation paths',async()=>{
  const {elements,restore}=mockDOM(['batch','leads','table-head','select-all']);
  let rows=[structuredClone(raw)],holds=0,instant=0;
  try{
    mountBatch({getLeads:()=>rows,getVisibleIds:()=>['one'],getRules:()=>rules,getTemplates:()=>({General:{subject:'Hello',body:'Message'}}),outboxService:{async add(value){holds++;assert.ok(value[0].draft);}},liveSender:{async openInstant(value){instant++;assert.ok(value[0].draft);}},save(next){rows=next;return true;},escape:String});
    elements.get('leads').listeners.change({target:{dataset:{select:'one'},checked:true}});
    assert.equal(elements.get('batch').textContent,'Selected lead(s) message (1)');
    elements.get('batch').onclick();
    assert.doesNotMatch(elements.get('batch-dialog').html,/Create these drafts/);
    await elements.get('batch-to-outbox').onclick();assert.equal(holds,1);assert.ok(rows[0].draft);
    await elements.get('batch-instant-send').onclick();assert.equal(instant,1);
    rows[0]={...rows[0],draft:{...rows[0].draft,body:'Changed elsewhere'}};
    await elements.get('batch-instant-send').onclick();assert.equal(instant,1);
    assert.match(elements.get('batch-message').textContent,/changed/);
  }finally{restore();}
});

test('instant send only previews until the final confirmation; closing does not enqueue',async()=>{
  const {elements,restore}=mockDOM([]);const calls=[];
  const item={id:'one',leadId:'one',recipient:raw.email,sender:'sender@company.test',subject:'Hello',body:'Message',version:1};
  try{
    const sender=mountLiveSend({getDataset:()=>({id:'data',name:'List',rules}),getLeads:()=>[raw],save:()=>true,escape:String,api:async(path,value)=>{
      calls.push(path);
      if(path==='/api/instant/preview')return {id:'preview',digest:'digest',items:[item]};
      if(path==='/api/sending')return {settings:{delaySeconds:0},allowance:{remaining:500}};
      return {queued:1};
    }});
    await sender.openInstant([raw]);assert.deepEqual(calls,['/api/instant/preview','/api/sending']);
    assert.match(elements.get('real-send-content').html,/bypasses Outbox/);
    elements.get('close-real-send').onclick();assert.ok(!calls.includes('/api/live/enqueue'));
    await sender.openInstant([raw]);await elements.get('confirm-real-send').onclick();
    assert.equal(calls.filter(path=>path==='/api/live/enqueue').length,1);
    await elements.get('confirm-real-send').onclick();assert.equal(calls.filter(path=>path==='/api/live/enqueue').length,1);
  }finally{restore();}
});
