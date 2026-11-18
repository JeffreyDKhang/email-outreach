import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gmailProvider} from '../server/providers/gmail.mjs';
import {checkGoogleConnectivity} from '../server/google-connectivity.mjs';
import {createQueue} from '../server/sending.mjs';
import {mountAccounts} from '../app/ui/accounts-ui.mjs';
import {mountSendingStatus} from '../app/ui/sending-status-ui.mjs';

const message={id:'message',sender:'sender@company.test',recipient:'test@company.test',subject:'Test',body:'Message'};
function fixture(failure){
  const data=new Map([['google-config',{clientId:'fake',clientSecret:'private-secret-marker'}],['gmail-account',{id:'account',email:message.sender,tokens:{refresh_token:'private-token-marker'}}]]);
  const store={get:key=>data.get(key),set:(key,value)=>data.set(key,value),remove:key=>data.delete(key)};
  let sent=0;
  const auth={setCredentials(){},on(){},getAccessToken:async()=>{if(failure)throw failure;return {token:'private-access-marker'};},request:async()=>{sent++;return {data:{id:'accepted-id'}};}};
  return {store,auth,make:()=>gmailProvider({store,redirectUri:'http://127.0.0.1/oauth/google/callback',clientFactory:()=>auth}),sent:()=>sent};
}

test('refresh diagnostics distinguish network, TLS, expired grants and unknown errors without sending or leaking',async()=>{
  const failures=[
    [{cause:{cause:{code:'ECONNREFUSED'}},message:'private-secret-marker'},'network_error'],
    [{code:'SELF_SIGNED_CERT_IN_CHAIN',message:'private-token-marker'},'certificate_error'],
    [{response:{data:{error:'invalid_grant',error_description:'private-token-marker'}}},'authorization_expired'],
    [new Error('private-token-marker'),'token_refresh_failed'],
  ];
  for(const [failure,code] of failures){
    const f=fixture(failure),provider=f.make();
    await assert.rejects(provider.sendMessage(message),error=>{
      assert.equal(error.connectionCode,code);assert.equal(error.uncertain,false);assert.equal(error.pauseQueue,true);
      assert.doesNotMatch(error.message,/private-/);return true;
    });
    assert.equal(f.sent(),0);
    const status=provider.getConnectionHealth();assert.equal(status.status,'needs_attention');assert.equal(status.code,code);
    assert.doesNotMatch(JSON.stringify(status),/private-/);
    assert.equal(f.make().getConnectionHealth().code,code);
    if(code==='network_error')assert.doesNotMatch(status.error,/authorization expired/i);
  }
});

test('refresh failure pauses the queue without retrying, and a later valid authorization clears health only',async()=>{
  const f=fixture({code:'ECONNREFUSED'}),provider=f.make();let state='queued',result;
  f.store.jobs=()=>[{id:'job',created:'2026-01-01',status:state,payload:message}];
  f.store.update=(id,status,value)=>{state=status;result=value;};
  const queue=createQueue({store:f.store,provider});await queue.tick();await queue.tick();
  assert.equal(state,'failed');assert.equal(result.code,'network_error');assert.ok(f.store.get('sending-pause'));assert.equal(f.sent(),0);
  f.auth.getAccessToken=async()=>({token:'fake'});
  await provider.sendMessage(message);assert.equal(provider.getConnectionHealth().status,'ready');
  assert.ok(f.store.get('sending-pause')); // Account health never resumes sending by itself.
});

test('connectivity probes are bounded unauthenticated GETs; network/TLS failures are safe and do not clear account warnings',async()=>{
  const calls=[];
  const result=await checkGoogleConnectivity(async options=>{
    calls.push(options);assert.equal(options.method,'GET');assert.equal(options.retry,false);assert.equal(options.timeout,8000);
    assert.equal(options.headers,undefined);assert.equal(options.data,undefined);
    return {status:options.url.includes('oauth2')?404:401};
  });
  assert.equal(calls.length,2);assert.equal(result.ok,true);
  assert.ok(calls.every(call=>!call.url.includes('messages/send')));
  const failed=await checkGoogleConnectivity(async options=>{throw {cause:{code:options.url.includes('oauth2')?'ENOTFOUND':'CERT_HAS_EXPIRED'},message:'private-token-marker'};});
  assert.equal(failed.ok,false);assert.deepEqual(failed.checks.map(check=>check.code),['network_error','certificate_error']);
  assert.doesNotMatch(JSON.stringify(failed),/private-/);
  const unexpected=await checkGoogleConnectivity(async()=>({status:407}));assert.equal(unexpected.ok,false);
  const f=fixture({code:'ECONNREFUSED'});await assert.rejects(f.make().sendMessage(message));
  const provider=gmailProvider({store:f.store,redirectUri:'http://127.0.0.1',clientFactory:()=>{throw Error('Must not use account credentials');},connectivityRequest:async options=>({status:options.url.includes('oauth2')?404:401})});
  assert.equal((await provider.checkConnectivity()).ok,true);assert.equal(provider.getConnectionHealth().status,'needs_attention');
});

function mockDOM(ids){
  const previous=globalThis.document,elements=new Map();
  function element(){return {value:'',textContent:'',disabled:false,hidden:false,listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},showModal(){},close(){},set innerHTML(html){for(const match of html.matchAll(/id="([^"]+)"/g))elements.set(match[1],element());}};}
  for(const id of ids)elements.set(id,element());
  globalThis.document={getElementById:id=>elements.get(id),createElement:element,body:{append(){}}};
  return {elements,restore:()=>{globalThis.document=previous;}};
}

test('account dialog shows attention and offers a no-send connectivity check without confusing it with authorization',async()=>{
  const {elements,restore}=mockDOM(['accounts']);const calls=[];
  let status='needs_attention';
  try{
    mountAccounts({escape:String,api:async(path)=>{
      calls.push(path);
      if(path==='/api/account')return {configured:true,account:{email:message.sender},redirectUri:'http://127.0.0.1',connection:{status,error:'Backend cannot reach Google.'}};
      if(path==='/api/google/check')return {ok:true,checks:[{name:'Google authorization',reachable:true}]};
      throw Error('Unexpected mutation');
    }});
    await elements.get('accounts').onclick();
    assert.match(elements.get('account-state').textContent,/Connection needs attention/);
    assert.equal(elements.get('account-connection-warning').hidden,false);
    await elements.get('check-google-connectivity').onclick();
    assert.match(elements.get('google-connectivity-result').textContent,/does not verify your Gmail authorization/);
    assert.match(elements.get('account-state').textContent,/Connection needs attention/);
    assert.deepEqual(calls,['/api/account','/api/google/check','/api/account']);
    status='unchecked';await elements.get('accounts').onclick();
    assert.match(elements.get('account-state').textContent,/has not been checked/);
    status='ready';await elements.get('accounts').onclick();
    assert.match(elements.get('account-state').textContent,/Connected:/);assert.equal(elements.get('account-connection-warning').hidden,true);
  }finally{restore();}
});

test('Outbox status exposes the persisted connection warning in the sidebar and allowance view',async()=>{
  const {elements,restore}=mockDOM(['accounts','app-allowance','queue-allowance','outbox-dialog','sending-controls']);
  const previous=globalThis.setInterval;globalThis.setInterval=()=>0;
  try{
    const status=mountSendingStatus({api:async()=>({connection:{status:'needs_attention',error:'Backend cannot reach Google.'},serverTime:new Date().toISOString(),settings:{delaySeconds:0},allowance:{used:0,limit:500,remaining:500}})});
    await new Promise(resolve=>setImmediate(resolve));await status.open();
    assert.match(elements.get('accounts').textContent,/Needs attention/);
    assert.match(elements.get('queue-allowance').textContent,/Backend cannot reach Google/);
  }finally{globalThis.setInterval=previous;restore();}
});
