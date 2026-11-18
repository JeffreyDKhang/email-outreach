import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OAuthConnectionError,classifyOAuthError,publicOAuthError} from '../server/oauth-errors.mjs';
import {gmailProvider,gmailScopes} from '../server/providers/gmail.mjs';

function fixture(overrides={}){
  const data=new Map([['google-config',{clientId:'client',clientSecret:'fake-secret-marker'}]]);
  const store={get:key=>data.get(key),set:(key,value)=>data.set(key,value)};
  const auth={getToken:async()=>({tokens:{id_token:'fake-id-marker',refresh_token:'fake-refresh-marker',access_token:'fake-access-marker',scope:gmailScopes.join(' ')}}),verifyIdToken:async()=>({getPayload:()=>({sub:'one',email:'a@company.test',email_verified:true})}),...overrides};
  return {store,provider:gmailProvider({store,redirectUri:'http://127.0.0.1:8765/oauth/google/callback',clientFactory:()=>auth})};
}
test('OAuth diagnostics expose only fixed allowlisted error messages and stages',()=>{
  const raw={response:{data:{error:'invalid_client',error_description:'fake-secret-marker'},config:{body:'fake-refresh-marker'}},message:'fake-id-marker'};
  const result=publicOAuthError(classifyOAuthError(raw,'token_exchange'));
  assert.equal(result.code,'invalid_client');assert.equal(result.stage,'token_exchange');assert.doesNotMatch(JSON.stringify(result),/fake-/);
  assert.equal(publicOAuthError(new Error('fake-secret-marker')).code,'connection_failed');
  assert.equal(classifyOAuthError({cause:{code:'ECONNRESET'}},'token_exchange').code,'network_error');
  assert.equal(classifyOAuthError({code:'SELF_SIGNED_CERT_IN_CHAIN'},'identity_verification').code,'certificate_error');
});
test('missing scope field is verified through token info rather than rejected',async()=>{
  let checked=false;
  const {store,provider}=fixture({getToken:async()=>({tokens:{id_token:'id',refresh_token:'refresh',access_token:'access'}}),getTokenInfo:async access=>{assert.equal(access,'access');checked=true;return {scopes:[gmailScopes[2]]};}});
  await provider.connect('code','verifier');assert.ok(checked);assert.equal(store.get('gmail-account').email,'a@company.test');
});
test('connection errors identify exchange, identity, permission and storage failures safely',async()=>{
  const scenarios=[
    [{getToken:async()=>{throw {response:{data:{error:'invalid_grant',error_description:'fake-secret-marker'}}};}},'invalid_grant','token_exchange'],
    [{getToken:async()=>({tokens:{id_token:'id'}})},'missing_refresh_token','token_exchange'],
    [{verifyIdToken:async()=>{throw Error('fake-id-marker');}},'identity_verification_failed','identity_verification'],
    [{getToken:async()=>({tokens:{id_token:'id',refresh_token:'refresh',scope:'openid email'}})},'gmail_permission_missing','permission_check'],
  ];
  for(const [overrides,code,stage] of scenarios){const {store,provider}=fixture(overrides);await assert.rejects(provider.connect('code','verifier'),error=>{const safe=publicOAuthError(error);assert.equal(safe.code,code);assert.equal(safe.stage,stage);assert.doesNotMatch(JSON.stringify(safe),/fake-/);return true;});assert.equal(store.get('gmail-account'),undefined);}
  const {store,provider}=fixture();store.set=()=>{throw Error('private database path');};await assert.rejects(provider.connect('code','verifier'),error=>error instanceof OAuthConnectionError&&error.code==='credential_store_failed');
});
