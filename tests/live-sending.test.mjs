import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store.mjs';
import {gmailProvider,mimeMessage,gmailScopes} from '../server/providers/gmail.mjs';
import {mockProvider} from '../server/providers/mock.mjs';
import {SendError,requireProvider} from '../server/providers/interface.mjs';
import {prepareLiveBatch,createQueue} from '../server/sending.mjs';
import {generateDraft,approveDraft,editDraft} from '../app/domain/outreach.mjs';
import {defaults} from '../app/domain/scoring.mjs';
import {acquireServerLock} from '../server/lock.mjs';

function fixture(t){const dir=mkdtempSync(join(tmpdir(),'officepantry-test-'));const store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {dir,store};}
const account={id:'google-one',email:'sender@company.test',provider:'gmail'};
const lead=()=>approveDraft(generateDraft({lead_id:'real-one',first_name:'Alex',company:'Real company',email:'contact@company.test',job_title:'Office Manager',city:'Toronto',avg_daily_onsite:20}));
test('live preview validates current approval, real contacts and duplicate recipients',()=>{
  const preview=prepareLiveBatch([lead()],defaults,account,[]);assert.equal(preview.items[0].sender,account.email);assert.equal(preview.items[0].body,lead().draft.body);
  assert.throws(()=>prepareLiveBatch([{...lead(),data_origin:'synthetic'}],defaults,account,[]));
  assert.throws(()=>prepareLiveBatch([{...lead(),email:'a@example.com'}],defaults,account,[]));
  assert.throws(()=>prepareLiveBatch([editDraft(lead(),'Edit','Body')],defaults,account,[]));
  assert.throws(()=>prepareLiveBatch([lead(),lead()],defaults,account,[]));
  assert.throws(()=>prepareLiveBatch([lead()],defaults,account,[{account:account.id,recipient:'contact@company.test'}]));
  assert.throws(()=>prepareLiveBatch([lead()],defaults,null,[]));
  assert.throws(()=>prepareLiveBatch([lead()],defaults,account,Array.from({length:500},(_,i)=>({account:account.id,recipient:i+'@company.test',created:new Date().toISOString()}))));
});
test('private store encrypts credentials, atomically deduplicates jobs, and resumes conservatively',t=>{
  const {dir,store}=fixture(t);store.set('google-config',{clientSecret:'top-secret-marker'});assert.equal(store.get('google-config').clientSecret,'top-secret-marker');
  const unlock=acquireServerLock(dir);assert.throws(()=>acquireServerLock(dir),/already using/);unlock();
  const raw=store.db.prepare('SELECT value FROM settings').get().value;assert.ok(!raw.includes('top-secret-marker'));
  const preview=prepareLiveBatch([lead()],defaults,account,[]);store.enqueue(preview.items);assert.throws(()=>store.enqueue(preview.items));assert.equal(store.jobs().length,1);
  store.update(preview.items[0].id,'sending');
  const second=openStore(dir);try{assert.equal(second.jobs()[0].status,'unknown');}finally{second.close();}
  assert.equal(readFileSync(join(dir,'key')).length,32);
});
test('shared queue handles mock provider, known failure and unknown outcome without retries',async t=>{
  const {store}=fixture(t);const items=prepareLiveBatch([lead()],defaults,account,[]).items;store.enqueue(items);
  await createQueue({store,provider:mockProvider(account.email)}).tick();assert.equal(store.jobs()[0].status,'simulated');
  for(const [id,uncertain] of [['failed',false],['unknown',true]]){
    const item={...items[0],id,recipient:id+'@company.test'};store.enqueue([item]);let calls=0;
    const queue=createQueue({store,provider:{async sendMessage(){calls++;throw new SendError('test outcome',uncertain);}}});
    await queue.tick();await queue.tick();assert.equal(calls,1);assert.equal(store.jobs().find(r=>r.id===id).status,id);
  }
});
test('MIME encodes Unicode and prevents header injection',()=>{
  const raw=mimeMessage({id:'id',sender:account.email,recipient:'a@company.test',subject:'Hello café',body:'Hello 世界'});
  assert.match(raw,/Content-Transfer-Encoding: base64/);assert.match(raw,/Subject: =\?UTF-8\?B\?/);
  assert.throws(()=>mimeMessage({sender:account.email,recipient:'a@company.test\r\nBcc:x@y.test',subject:'Hi',body:'x'}));
  assert.throws(()=>mimeMessage({sender:account.email,recipient:'a@company.test',subject:'Hi\r\nBcc:x@y.test',body:'x'}));
  assert.throws(()=>requireProvider({}));
});
test('Gmail adapter uses send-only consent, verified identity and provider acceptance',async t=>{
  const {store}=fixture(t);store.set('google-config',{clientId:'client',clientSecret:'secret'});let sent;
  const auth={generateCodeVerifierAsync:async()=>({codeVerifier:'verifier',codeChallenge:'challenge'}),generateAuthUrl:options=>{assert.deepEqual(options.scope,gmailScopes);assert.equal(options.code_challenge_method,'S256');return 'https://accounts.google.com/test';},getToken:async()=>({tokens:{id_token:'id',refresh_token:'refresh',access_token:'access',scope:gmailScopes.join(' ')}}),verifyIdToken:async()=>({getPayload:()=>({sub:account.id,email:account.email,email_verified:true})}),setCredentials(){},on(){},getAccessToken:async()=>({token:'access'}),request:async options=>{sent=options;return {data:{id:'gmail-message-id'}};},revokeToken:async()=>{}};
  const provider=gmailProvider({store,redirectUri:'http://127.0.0.1:8765/oauth/google/callback',clientFactory:()=>auth});
  const authorization=await provider.authorize('state');assert.equal(authorization.verifier,'verifier');await provider.connect('code','verifier');
  assert.equal(provider.getAccount().email,account.email);
  const result=await provider.sendMessage({id:'x',sender:account.email,recipient:'a@company.test',subject:'Hi',body:'Body'});assert.equal(result.status,'accepted');assert.equal(sent.retry,false);assert.match(Buffer.from(sent.data.raw,'base64url').toString(),/To: a@company.test/);
  auth.request=async()=>{const error=Error('private-provider-details');error.response={status:429};throw error;};
  await assert.rejects(()=>provider.sendMessage({id:'throttled',sender:account.email,recipient:'a@company.test',subject:'Hi',body:'Body'}),error=>error.pauseQueue===true&&error.uncertain===false&&!error.message.includes('private-provider-details'));
  await provider.disconnect();assert.equal(provider.getAccount(),null);
});
test('queue preserves unknown outcome when persisting a successful provider response fails',async()=>{
  let state='queued',calls=0;
  const store={jobs:()=>[{id:'job',status:state,payload:{},created:'2026-01-01'}],update(id,next){if(next==='accepted')throw Error('Disk error');state=next;}};
  const queue=createQueue({store,provider:{async sendMessage(){calls++;return {status:'accepted',messageId:'id'};}}});
  await queue.tick();await queue.tick();assert.equal(state,'unknown');assert.equal(calls,1);
});

test('queue retains uncertainty and pause flags from structured provider failures',async()=>{
  let state='queued',calls=0,paused=null,recorded;
  const store={
    jobs:()=>[{id:'job',account:'fake',status:state,payload:{},created:'2026-01-01'}],
    get:name=>name==='sending-pause'?paused:null,
    set(name,value){assert.equal(name,'sending-pause');paused=value;},
    update(id,next,result){state=next;recorded=result;},
  };
  const queue=createQueue({store,provider:{async sendMessage(){
    calls++;
    throw {message:'Unknown provider outcome',uncertain:true,pauseQueue:true,connectionCode:'network_error',connectionStage:'connectivity'};
  }}});
  await queue.tick();await queue.tick();
  assert.equal(state,'unknown');assert.equal(calls,1);assert.ok(paused);
  assert.equal(recorded.error,'Unknown provider outcome');assert.equal(recorded.code,'network_error');
  assert.equal(recorded.stage,'connectivity');
});
