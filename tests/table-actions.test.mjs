import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mountTable} from '../app/ui/table-ui.mjs';

test('each row has one explicit detail action; source cells only edit and locked rows explain why',()=>{
  const previous=globalThis.document,elements=new Map();
  function element(){return {html:'',textContent:'',set innerHTML(value){this.html=value;for(const match of value.matchAll(/id="([^"]+)"/g))elements.set(match[1],element());}};}
  for(const id of ['table-head','leads','filter-summary'])elements.set(id,element());
  globalThis.document={getElementById:id=>elements.get(id),createElement:element,body:{append(){}}};
  const native={lead_id:'new',company:'Imported',values:{Code:'001',Name:'Ada'}};
  const legacy={lead_id:'old',company:'Legacy',first_name:'Sam',email:'sam@example.com'};
  const rows=[native,legacy,{...legacy,lead_id:'sent',outbox:[{}]},{...legacy,lead_id:'queued',live_delivery:{status:'queued'}}];
  const columns=[{key:'csv:Code',label:'Code'},{key:'csv:Name',label:'Name'},{key:'lead_id',label:'Internal ID'},{key:'first_name',label:'First name'},{key:'company',label:'Company'}];
  try{
    const table=mountTable({getLeads:()=>rows,getColumns:()=>columns,score:()=>({score:0,band:'Unscored',eligibility:'Eligible'}),escape:String,onChange(){}});
    table.render(rows);
    const html=elements.get('leads').html;
    assert.equal((html.match(/data-id=/g)||[]).length,4);
    assert.equal((html.match(/>View Lead<\/button>/g)||[]).length,4);
    assert.match(elements.get('table-head').html,/Lead actions/);
    assert.match(html,/data-edit-field="csv:Code"/);
    assert.match(html,/data-edit-field="first_name"/);
    assert.match(html,/data-edit-field="company"/);
    assert.doesNotMatch(html,/edit-pencil|class="contact"/);
    assert.doesNotMatch(html,/data-edit-lead="(?:sent|queued)"/);
    assert.match(html,/Read-only: previously simulated sent/);
    assert.match(html,/Read-only: real delivery record/);
    assert.doesNotMatch(html,/data-edit-lead="old" data-edit-field="lead_id"/);
  }finally{globalThis.document=previous;}
});
