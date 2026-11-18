import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createUnsavedChangesGuard} from '../app/ui/unsaved-changes.mjs';

function fixture(){
  const listeners=new Map(),target={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
  const guard=createUnsavedChangesGuard(target);
  function unload(){const event={prevented:false,preventDefault(){this.prevented=true;}};listeners.get('beforeunload')?.(event);return event;}
  return {guard,unload,listeners};
}
const field=(value,type='text')=>({value,type});

test('native unload warning appears only for unsaved edits, clears on save/revert/cancel and never saves',()=>{
  const {guard,unload,listeners}=fixture(),input=field('Saved text');
  const dialog={open:false,querySelectorAll:()=>[input]};
  const tracked=guard.track(dialog);tracked.reset();
  assert.equal(unload().prevented,false);
  dialog.open=true;assert.equal(unload().prevented,false);
  input.value='Changed';
  assert.equal(unload().prevented,true);assert.equal(unload().returnValue,'');
  assert.equal(input.value,'Changed');
  input.value='Saved text';assert.equal(unload().prevented,false);
  input.value='New saved text';tracked.reset();assert.equal(unload().prevented,false);
  input.value='Discarded';dialog.open=false;assert.equal(unload().prevented,false);
  dialog.open=true;input.value='Reopened saved text';tracked.reset();assert.equal(unload().prevented,false);
  input.value='Later edit';assert.equal(unload().prevented,true);
  guard.dispose();assert.equal(listeners.has('beforeunload'),false);
});

test('structural edits and independent open editors are protected without tracking search/filter controls',()=>{
  const {guard,unload}=fixture(),fields=[field('50','number')];
  const editor={open:true,querySelectorAll:selector=>{assert.equal(selector,'[data-persistent]');return fields;}};
  const tracked=guard.track(editor,{selector:'[data-persistent]'});tracked.reset();
  fields.push(field('New criterion'));assert.equal(unload().prevented,true);
  fields.pop();assert.equal(unload().prevented,false);
  const toggle={type:'checkbox',checked:false};fields.push(toggle);tracked.reset();
  toggle.checked=true;assert.equal(unload().prevented,true);
  const other={open:true,querySelectorAll:()=>[field('Original')]};
  const otherTracked=guard.track(other);otherTracked.reset();
  assert.equal(unload().prevented,true);tracked.clear();assert.equal(unload().prevented,false);
  const unregister=guard.register(()=>true);assert.equal(unload().prevented,true);
  unregister();assert.equal(unload().prevented,false);
});

test('failed or pending saves remain dirty, including edits made during an asynchronous save',()=>{
  const {guard,unload}=fixture();let value={subject:'Saved'};
  const tracked=guard.track(null,{active:()=>true,read:()=>value});tracked.reset();
  value={subject:'Submitted'};
  // An unsuccessful save leaves the baseline alone.
  assert.equal(unload().prevented,true);
  const submitted=structuredClone(value);value={subject:'Typed during save'};
  tracked.reset(submitted);assert.equal(unload().prevented,true);
  value=submitted;assert.equal(unload().prevented,false);
});
