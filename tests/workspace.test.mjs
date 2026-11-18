import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../server/store.mjs';
import {createApplication} from '../server/http.mjs';
import {createDataset,emptyWorkspace} from '../app/domain/datasets.mjs';
import {generateDraft,createAdditionalDraft,editDraft} from '../app/domain/outreach.mjs';
import {createStorageRepository,storageKeys} from '../app/infrastructure/storage.mjs';
import {createWorkspaceRepository} from '../app/infrastructure/workspace-repository.mjs';
import {createLiveApi} from '../app/infrastructure/live-api.mjs';
import {mountWorkspaceStatus} from '../app/ui/workspace-status.mjs';
import {createUnsavedChangesGuard} from '../app/ui/unsaved-changes.mjs';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'outreach-workspace-'));let store=openStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,get store(){return store;},reopen(){store.close();store=openStore(dir);return store;}};
}
function sample(){
  const dataset=createDataset('My saved workspace',[{lead_id:'one',company:'A private company',email:'ada@company.test',values:{Name:'Ada',Email:'ada@company.test'},recipient_column:'Email'}]);
  dataset.native=true;dataset.columns=[{key:'csv:Name',label:'Name'},{key:'csv:Email',label:'Email'}];dataset.recipientKey='csv:Email';
  dataset.rules.columnTypes={'csv:Name':'text'};
  dataset.rules.segments=[{name:'My segment',conditions:[{field:'csv:Name',operator:'equals',value:'Ada'}]}];
  dataset.rules.eligibility=[{field:'csv:Email',operator:'present'}];
  dataset.templates={_columns:['Name','Email'],General:{subject:'Hi {{Name}}',body:'My private message'},Other:{subject:'Other',body:'Second message'}};
  let lead=generateDraft(dataset.leads[0],dataset.templates,'merge',dataset.rules);
  lead=editDraft(lead,'Saved first subject','Saved first body');
  lead=createAdditionalDraft(lead,dataset.templates,dataset.rules,'Other');
  lead=editDraft(lead,'Saved second subject','Saved second body');
  dataset.leads=[lead];
  return {version:1,activeId:dataset.id,datasets:[dataset]};
}
function storeApi(store){return async(path,value)=>{assert.equal(path,'/api/workspace');return value===undefined?store.readWorkspace():store.writeWorkspace(value.workspace,value.revision);};}
function browser(value){
  const data=new Map(value?[[storageKeys.workspace,JSON.stringify(value)]]:[]);
  return {data,legacy:createStorageRepository({getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)})};
}

test('encrypted backend workspace survives restart with columns, settings and all independent drafts; queue and credentials are separate',t=>{
  const f=fixture(t),workspace=sample();
  f.store.set('test-credential',{marker:'fake-only'});f.store.set('sending-pause',{reason:'Keep paused'});
  f.store.enqueue([{id:'delivery',account:'fake',recipient:'ada@company.test',subject:'Queued subject',body:'Queued message'}]);
  const jobs=f.store.jobs();
  assert.deepEqual(f.store.readWorkspace(),{workspace:null,revision:0,updated:null});
  assert.equal(f.store.writeWorkspace(workspace,0).revision,1);
  const raw=f.store.db.prepare('SELECT payload FROM workspace').get().payload;
  assert.doesNotMatch(raw,/My private message|A private company|Saved first body/);
  f.reopen();assert.deepEqual(f.store.readWorkspace().workspace,workspace);
  assert.deepEqual(f.store.jobs(),jobs);assert.deepEqual(f.store.get('test-credential'),{marker:'fake-only'});
  assert.throws(()=>f.store.writeWorkspace({...workspace,activeId:'missing'},1),/Invalid active/);
  assert.equal(f.store.readWorkspace().revision,1);
  assert.equal(f.store.writeWorkspace(structuredClone(emptyWorkspace),1).revision,2);
  assert.deepEqual(f.store.readWorkspace().workspace,emptyWorkspace);
  assert.deepEqual(f.store.get('sending-pause'),{reason:'Keep paused'});assert.deepEqual(f.store.jobs(),jobs);
});

test('migration verifies backend copy, preserves original browser data, and fresh/cleared browsers load backend without touching their cache',async t=>{
  const {store}=fixture(t),workspace=sample(),old=browser(workspace),original=[...old.data];
  const repo=createWorkspaceRepository({api:storeApi(store),legacy:old.legacy});
  const result=await repo.load();assert.equal(result.migrated,true);assert.deepEqual(result.workspace,workspace);
  assert.deepEqual([...old.data],original);assert.deepEqual(store.readWorkspace().workspace,workspace);
  old.data.clear();
  const another=createWorkspaceRepository({api:storeApi(store),legacy:{loadWorkspace(){throw Error('Browser storage must not be read');}}});
  assert.deepEqual((await another.load()).workspace,workspace);
  await repo.save(structuredClone(emptyWorkspace));
  const stale=browser(workspace),third=createWorkspaceRepository({api:storeApi(store),legacy:stale.legacy});
  assert.deepEqual((await third.load()).workspace,emptyWorkspace);assert.deepEqual([...stale.data],original);
});

test('legacy v1 keys migrate without writing to browser storage and corrupt migration cannot initialize backend',async t=>{
  const {store}=fixture(t),workspace=sample(),lead=workspace.datasets[0].leads[0];
  const data=new Map([[storageKeys.leads,JSON.stringify([lead])]]);
  const legacy=createStorageRepository({getItem:key=>data.get(key)??null,setItem(){throw Error('Browser storage full');}});
  const repo=createWorkspaceRepository({api:storeApi(store),legacy});
  assert.equal((await repo.load()).workspace.datasets[0].leads[0].drafts.length,2);
  assert.equal(data.size,1);
  // Separate uninitialized backend: invalid JSON must not become an empty saved workspace.
  const f=fixture(t),broken=createWorkspaceRepository({api:storeApi(f.store),legacy:createStorageRepository({getItem:()=>'{broken',setItem(){throw Error('must not write');}})});
  await assert.rejects(broken.load());assert.equal(f.store.readWorkspace().revision,0);
});

test('concurrent first opens choose one migration, and stale tabs cannot overwrite newer saved edits',async t=>{
  const {store}=fixture(t),first=sample(),second=sample();second.datasets[0].name='Other browser';
  const a=createWorkspaceRepository({api:storeApi(store),legacy:browser(first).legacy});
  const b=createWorkspaceRepository({api:storeApi(store),legacy:browser(second).legacy});
  const [one,two]=await Promise.all([a.load(),b.load()]);
  assert.deepEqual(one.workspace,two.workspace);assert.equal(store.readWorkspace().revision,1);
  const changed=structuredClone(one.workspace);changed.datasets[0].name='A saved edit';
  await a.save(changed);
  await assert.rejects(b.save(two.workspace),/another tab or browser/);
  await assert.rejects(b.save(two.workspace),/another tab or browser/);
  assert.deepEqual(store.readWorkspace().workspace,changed);assert.equal(store.readWorkspace().revision,2);
});

test('failed saves preserve committed state, lost responses are verified without repeating mutations, and overlapping writes reject',async t=>{
  const {store}=fixture(t);let mode='ok',writes=0,finish;
  const api=async(path,value)=>{
    if(!value)return store.readWorkspace();
    writes++;
    if(mode==='fail')throw Error('Connection lost');
    if(mode==='delay')await new Promise(resolve=>{finish=resolve;});
    const result=store.writeWorkspace(value.workspace,value.revision);
    if(mode==='lost')throw Error('Response lost');
    return result;
  };
  const repo=createWorkspaceRepository({api,legacy:browser(sample()).legacy});const {workspace}=await repo.load();
  const changed=structuredClone(workspace);changed.datasets[0].name='Updated';
  mode='fail';await assert.rejects(repo.save(changed),/Unable to confirm/);
  assert.deepEqual(store.readWorkspace().workspace,workspace);
  mode='lost';const before=writes;assert.deepEqual(await repo.save(changed),changed);assert.equal(writes,before+1);
  mode='delay';changed.datasets[0].name='Next';const saving=repo.save(changed);
  await assert.rejects(repo.save(workspace),/already in progress/);finish();await saving;
  assert.deepEqual(store.readWorkspace().workspace,changed);
});

test('workspace HTTP API enforces session, CSRF, validation, revision conflicts and supports accumulated workspaces over 2 MB',async t=>{
  const {store}=fixture(t);let origin;
  const server=createApplication({root:fileURLToPath(new URL('../',import.meta.url)),origin:()=>origin,store,provider:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  assert.equal((await fetch(origin+'/api/workspace')).status,401);
  const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],{csrf}=await session.json();
  const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf};
  const post=(workspace,revision,h=headers)=>fetch(origin+'/api/workspace',{method:'POST',headers:h,body:JSON.stringify({workspace,revision})});
  assert.equal((await post(emptyWorkspace,0,{...headers,'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await post({version:1,datasets:[]},0)).status,400);assert.equal(store.readWorkspace().revision,0);
  const workspace=sample();workspace.datasets[0].leads[0].values.Notes='A'.repeat(2_100_000)+'\u00e9';
  assert.equal((await post(workspace,0)).status,200);
  const result=await post(emptyWorkspace,0);assert.equal(result.status,409);assert.equal((await result.json()).code,'workspace_conflict');
  assert.deepEqual(await (await fetch(origin+'/api/workspace',{headers:{Cookie:cookie}})).json(),store.readWorkspace());
  assert.equal(store.jobs().length,0);
});

test('API shares session establishment across concurrent callers and exposes structured save conflicts',async()=>{
  let sessions=0;
  const api=createLiveApi(async path=>{
    if(path==='/api/session'){sessions++;await Promise.resolve();return {ok:true,json:async()=>({csrf:'token'})};}
    return {ok:false,status:409,json:async()=>({code:'workspace_conflict',error:'Newer saved workspace'})};
  });
  const results=await Promise.allSettled([api('/api/workspace',{}),api('/api/workspace',{})]);
  assert.equal(sessions,1);for(const result of results){assert.equal(result.status,'rejected');assert.equal(result.reason.code,'workspace_conflict');assert.equal(result.reason.status,409);}
});

test('pending database writes warn on unload, freeze form/navigation controls and restore original disabled states',()=>{
  const guard=createUnsavedChangesGuard({addEventListener(){},removeEventListener(){}}),status={textContent:''};
  const controls=[{disabled:false,isConnected:true,value:'Unsaved text'},{disabled:true,isConnected:true}],events={};
  const root={querySelectorAll:()=>controls,addEventListener:(name,fn)=>{events[name]=fn;}};
  const ui=mountWorkspaceStatus({unsavedChanges:guard,root,status});
  assert.equal(guard.isDirty(),false);ui.saving(true);assert.equal(guard.isDirty(),true);
  assert.ok(controls.every(control=>control.disabled));assert.match(status.textContent,/Saving/);
  let prevented=false;events.cancel({preventDefault(){prevented=true;}});assert.equal(prevented,true);
  ui.saving(false);assert.equal(controls[0].disabled,false);assert.equal(controls[1].disabled,true);
  assert.equal(controls[0].value,'Unsaved text');assert.equal(guard.isDirty(),false);guard.dispose();
});

test('app composition loads the backend workspace and waits for template saves; rejected saves retain the open form',async t=>{
  const {store}=fixture(t),workspace=sample();store.writeWorkspace(workspace,0);
  const previous={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch,setInterval:globalThis.setInterval,localStorage:globalThis.localStorage};
  const elements=new Map(),nodes=new Set(),variables=new Map();let finishSave;
  function parse(html){for(const match of html.matchAll(/id="([^"]+)"/g)){const node=element();node.id=match[1];elements.set(node.id,node);}}
  function element(){
    const node={id:'',disabled:false,isConnected:true,value:'',textContent:'',open:false,hidden:false,
      addEventListener(){},setAttribute(){},before(){},showModal(){this.open=true;},close(){this.open=false;},
      querySelectorAll(){return [];},querySelector(selector){this.children??=new Map();if(!this.children.has(selector))this.children.set(selector,element());return this.children.get(selector);},
      set innerHTML(html){this.html=html;parse(html);}};
    nodes.add(node);return node;
  }
  parse(readFileSync(new URL('../app/index.html',import.meta.url),'utf8'));
  const document={getElementById:id=>elements.get(id),createElement:element,addEventListener(){},querySelectorAll:()=>[...nodes],
    querySelector:selector=>variables.get(selector),body:{append(node){if(node.id)elements.set(node.id,node);}}};
  try{
    globalThis.document=document;globalThis.window={addEventListener(){},removeEventListener(){}};globalThis.setInterval=()=>0;
    globalThis.localStorage={getItem(){throw Error('Backend workspace must take precedence');}};
    globalThis.fetch=async(path,options)=>{
      let data;
      if(path==='/api/session')data={csrf:'test'};
      else if(path==='/api/sending')data={account:null,allowance:null,settings:{delaySeconds:0},serverTime:new Date().toISOString()};
      else if(path==='/api/workspace'){
        if(options.method==='POST')return new Promise((resolve,reject)=>{finishSave=(succeed=false)=>{
          if(!succeed)return reject(Error('Backend unavailable'));
          const value=JSON.parse(options.body),result=store.writeWorkspace(value.workspace,value.revision);
          resolve({ok:true,json:async()=>result});
        };});
        data=store.readWorkspace();
      }else throw Error('Unexpected API route: '+path);
      return {ok:true,json:async()=>data};
    };
    await import('../app/app.js?workspace-composition-test');
    assert.equal(elements.get('dataset-title').textContent,'My saved workspace');assert.equal(elements.get('total').textContent,'1');
    assert.match(elements.get('workspace-status').textContent,/Saved to the local backend/);
    elements.get('templates').onclick();
    for(const [index,name] of ['General','Other'].entries()){
      variables.set(`[data-subject="${index}"]`,{value:workspace.datasets[0].templates[name].subject});
      variables.set(`[data-body="${index}"]`,{value:workspace.datasets[0].templates[name].body});
    }
    variables.get('[data-body="0"]').value='Unsaved template text';
    const pending=elements.get('save-templates').onclick();
    assert.equal(elements.get('templates-dialog').open,true);assert.equal(elements.get('save-templates').disabled,true);
    assert.match(elements.get('workspace-status').textContent,/Saving/);finishSave();await pending;
    assert.equal(elements.get('templates-dialog').open,true);assert.equal(elements.get('save-templates').disabled,false);
    assert.equal(variables.get('[data-body="0"]').value,'Unsaved template text');
    assert.match(elements.get('template-error').textContent,/Unable to confirm/);
    assert.deepEqual(store.readWorkspace().workspace,workspace);
    const retry=elements.get('save-templates').onclick();assert.equal(elements.get('templates-dialog').open,true);
    finishSave(true);await retry;
    assert.equal(elements.get('templates-dialog').open,false);assert.match(elements.get('notice').textContent,/Templates saved/);
    const saved=store.readWorkspace();assert.equal(saved.revision,2);
    assert.equal(saved.workspace.datasets[0].templates.General.body,'Unsaved template text');
    assert.deepEqual(saved.workspace.datasets[0].leads[0].drafts,workspace.datasets[0].leads[0].drafts);
  }finally{Object.assign(globalThis,previous);}
});
