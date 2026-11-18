import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mountEligibility} from '../app/ui/eligibility-ui.mjs';
import {genericDefaults} from '../app/domain/scoring.mjs';
import {readFileSync} from 'node:fs';

test('eligibility edits are isolated, discarded on close and remain open on failed save',async()=>{
  const previous=globalThis.document,elements=new Map();
  function element(){return {textContent:'',html:'',open:false,showModal(){this.open=true;},close(){this.open=false;},set innerHTML(html){this.html=html;for(const match of html.matchAll(/id="([^"]+)"/g))elements.set(match[1],element());}};}
  elements.set('eligibility',element());
  globalThis.document={getElementById:id=>elements.get(id),createElement:element,body:{append(node){elements.set(node.id,node);}}};
  const rules=structuredClone(genericDefaults),before=structuredClone(rules);let saved,fail=true;
  try{
    mountEligibility({getLeads:()=>[{values:{Name:'Ada'}}],getColumns:()=>[{key:'csv:Name',label:'Name'}],getRules:()=>rules,escape:String,onSave(value){if(fail)throw Error('Storage full');saved=value;}});
    const open=()=>elements.get('eligibility').onclick();
    const submit=()=>elements.get('eligibility-form').onsubmit({preventDefault(){}});
    open();elements.get('add-eligibility').onclick();elements.get('close-eligibility').onclick();
    assert.deepEqual(rules,before);assert.equal(saved,undefined);
    open();assert.equal(elements.get('eligibility-conditions').html,'');
    elements.get('add-eligibility').onclick();await submit();
    assert.match(elements.get('eligibility-error').textContent,/Storage full/);
    assert.equal(elements.get('eligibility-dialog').open,true);
    fail=false;await submit();assert.deepEqual(saved,[{field:'csv:Name',operator:'present'}]);
    assert.equal(elements.get('eligibility-dialog').open,false);assert.deepEqual(rules,before);
  }finally{globalThis.document=previous;}
});
test('priority settings follow scoring criteria and eligibility follows ICP in toolbar',()=>{
  const html=readFileSync(new URL('../app/index.html',import.meta.url),'utf8');
  assert.ok(html.indexOf('id="add-criterion"')<html.indexOf('id="priority-heading"'));
  assert.ok(html.indexOf('id="settings"')<html.indexOf('id="eligibility"'));
  assert.ok(html.indexOf('id="eligibility"')<html.indexOf('id="templates"'));
  assert.match(html,/Medium priority starts at/);assert.match(html,/High priority starts at/);
  assert.doesNotMatch(html,/id="eligibility-rules"/);
});
