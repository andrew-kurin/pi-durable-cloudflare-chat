import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { prepareSiwc, SIWC, type LocalSiwcCredential } from '../services/model-runner/siwc-auth';
import { runLocalSiwcCheck } from '../services/model-runner/siwc-check';
import { MemoryRoundJournal } from '../services/model-runner/core';
import { fakeBackend } from '../services/model-runner/fake-backend';
const host = 'urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const credential: LocalSiwcCredential = { clientId: 'oaiapp_fixture', subject: 'fixture-subject', hostId: host, idToken: 'FAKE-ID', access: 'FAKE-ACCESS', refresh: 'FAKE-REFRESH', expires: Date.now()+3600000, scopes: SIWC.scopes.split(' ') };
function callback(p: ReturnType<typeof prepareSiwc>, extra = '') { return p.redirect+'?state='+new URL(p.url).searchParams.get('state')+'&code=FAKE-CODE&client_id=oaiapp_fixture'+extra; }
test('new/returning SIWC registration has exact scopes, resource and local callback; no client secret', () => {
 const p = prepareSiwc(host, 12345), u = new URL(p.url); assert.equal(u.origin+u.pathname, SIWC.authorize); assert.equal(u.searchParams.get('scope'), SIWC.scopes); assert.equal(u.searchParams.get('resource'), SIWC.resource); assert.equal(u.searchParams.get('client_id'),'dynamic_agent_client'); assert.equal(u.searchParams.get('code_challenge_method'),'S256');
 const exchange = p.exchange(callback(p)); assert.equal(exchange.clientId, 'oaiapp_fixture'); assert.equal(exchange.body.get('redirect_uri'), p.redirect); assert.equal(exchange.body.has('client_secret'), false); assert.throws(() => p.exchange(callback(p)));
 const returning = new URL(prepareSiwc(host, 12345, credential).url); assert.equal(returning.searchParams.get('client_id'), credential.clientId); assert.equal(returning.searchParams.has('agent_name_hint'), false); assert.equal(returning.searchParams.has('id_token_hint'), false);
});
test('callback rejects wrong state/origin/client and denial without exchanging credentials', () => {
 const p = prepareSiwc(host, 12345); assert.throws(() => p.exchange(callback(p).replace('state=', 'other='))); assert.throws(() => p.exchange(callback(p).replace('127.0.0.1','localhost'))); assert.throws(() => p.exchange(callback(p).replace('oaiapp_fixture','dynamic_agent_client')));
 const returning = prepareSiwc(host, 12345, credential); assert.throws(() => returning.exchange(callback(returning).replace('oaiapp_fixture','oaiapp_other')));
 const denial = prepareSiwc(host, 12345); assert.throws(() => denial.exchange(callback(denial)+'&error=access_denied'), /declined/);
});
for (const mode of ['valid','nonce','issuer','audience','expired','subject','scope','signature']) test('ID-token signature/identity/consent validation '+mode, async () => {
 const {privateKey,publicKey} = await generateKeyPair('RS256'), p = prepareSiwc(host, 12345, credential), exchange = p.exchange(callback(p));
 const key = mode === 'signature' ? (await generateKeyPair('RS256')).privateKey : privateKey;
 const id = await new SignJWT({ nonce: mode === 'nonce' ? 'wrong' : new URL(p.url).searchParams.get('nonce') }).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer(mode === 'issuer' ? 'https://wrong.example' : SIWC.issuer).setAudience(mode === 'audience' ? 'wrong' : exchange.clientId).setSubject(mode === 'subject' ? 'wrong' : credential.subject).setIssuedAt().setExpirationTime(mode === 'expired' ? '-30s' : '5m').sign(key);
 const tokens = { token_type: 'Bearer', id_token: id, access_token: credential.access, refresh_token: credential.refresh, expires_in: 3600, scope: mode === 'scope' ? 'openid profile email' : SIWC.scopes };
 const verify = p.validate(tokens, exchange.clientId, createLocalJWKSet({ keys: [{...await exportJWK(publicKey),kid:'fixture'}] }));
 if (mode === 'valid') { const record = await verify; assert.equal(record.subject, credential.subject); assert.equal(record.clientId, exchange.clientId); assert.equal(record.idToken,id); }
 else await assert.rejects(verify);
});
function transport(mode = 'success') { const requests: {url:string;body?:any}[]=[]; return { requests, fetch: (async (input,init) => {
 const url = String(input); assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer '+credential.access); assert.equal(init?.redirect,'error'); requests.push({url});
 if (url === 'https://api.openai.com/v1/models') return Response.json({models:mode === 'missing' ? [{slug:'different-model',display_name:'Actual account model',visibility:'list'}] : ['gpt-6.1-sol','gpt-6-luna'].map(slug=>({slug,display_name:slug,visibility:'list'}))});
 assert.equal(url,'https://api.openai.com/v1/responses'); const body=JSON.parse(init!.body as string); requests.at(-1)!.body=body;
 assert.equal(body.store,false); assert.equal(body.stream,true); for(const field of ['max_output_tokens','temperature','tools','previous_response_id','prompt_cache_retention','metadata','top_p']) assert.equal(field in body,false);
 if(body.model==='gpt-6.1-sol') assert.ok(body.input.some((x:any)=>x.type==='additional_tools'&&x.tools[0].name==='test_status'));
 if(mode==='fail')return new Response('do not retain '+credential.access,{status:403});
 return fakeBackend(body.model==='gpt-6-luna'?{...body,input:[{type:'function_call_output'}]}:body,'FAKE',init!.signal!);
 }) as typeof fetch }; }
test('fixed local test discovers exact catalog, completes Sol tool follow-up and Luna text with at most three requests', async () => {
 const f=transport(), journal=new MemoryRoundJournal(), r=await runLocalSiwcCheck(credential,f.fetch,journal,true);
 assert.deepEqual(r.catalog.map(x=>x.slug),['gpt-6.1-sol','gpt-6-luna']); assert.deepEqual(r.checks.map(x=>[x.status,x.requests,x.toolCalls]),[['passed',2,1],['passed',1,0]]); assert.ok(!JSON.stringify(r).includes(credential.access)); assert.equal(f.requests.length,4); await assert.rejects(runLocalSiwcCheck(credential,f.fetch,journal,true),/reserved/); assert.equal(f.requests.length,4);
});
test('unavailable models are reported rather than inferred from Pi catalog', async () => {const f=transport('missing'),r=await runLocalSiwcCheck(credential,f.fetch,new MemoryRoundJournal(),true);assert.deepEqual(r.catalog.map(x=>x.slug),['different-model']);assert.ok(r.checks.every(x=>x.status==='unavailable'&&x.requests===0));assert.equal(f.requests.length,1);});
test('HTTP rejection does not retry, leak credentials, start followup, refresh or opt into billing', async () => {const f=transport('fail'),r=await runLocalSiwcCheck(credential,f.fetch,new MemoryRoundJournal(),true);assert.ok(r.checks.every(x=>x.status==='failed'&&x.requests===1));assert.equal(f.requests.length,3);assert.ok(!JSON.stringify(r).includes(credential.access));});
test('approval, expired credentials, missing scope and API keys fail before any network', async () => {let n=0;const fetcher=(async()=>{n++;throw Error('Network forbidden');}) as typeof fetch;for(const [value,approved] of [[credential,false],[{...credential,expires:0},true],[{...credential,scopes:[]},true],[{...credential,access:'sk-PAID-KEY'},true]] as const)await assert.rejects(runLocalSiwcCheck(value,fetcher,new MemoryRoundJournal(),approved));assert.equal(n,0);});

test('displayed returning authorization URL contains no stored token values',()=>{const p=prepareSiwc(host,12345,credential);for(const secret of [credential.access,credential.refresh,credential.idToken])assert.ok(!p.url.includes(secret));});
test('catalog visibility is fixed metadata, never arbitrary reflected credentials',async()=>{const f=transport('missing');const adapted=(async(input,init)=>String(input).endsWith('/models')?Response.json({models:[{slug:'different-model',display_name:'Actual account model',visibility:credential.access}]}):f.fetch(input,init)) as typeof fetch;const r=await runLocalSiwcCheck(credential,adapted,new MemoryRoundJournal(),true);assert.ok(!JSON.stringify(r).includes(credential.access));assert.equal('visibility' in r.catalog[0],false);});
test('CLI default/plan and unapproved actions create no state, expose no tokens and perform no auth',()=>{const script=new URL('../services/model-runner/local-siwc.ts',import.meta.url).pathname;const state=new URL('../.runtime/local-siwc/',import.meta.url);const before=existsSync(state);for(const args of [[],['--plan']]){const out=execFileSync(process.execPath,['--import','tsx',script,...args],{encoding:'utf8'});assert.match(out,/chatgpt.tokens.use.direct/);assert.ok(!out.includes('id_token_hint='));}for(const action of ['--sign-in','--check']){const result=spawnSync(process.execPath,['--import','tsx',script,action],{encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stderr,/approval required/);}assert.equal(existsSync(state),before);});

for(const terminal of ['response.failed','response.incomplete','missing'])test('local diagnostic requires completed inference: '+terminal,async()=>{const f=transport();const rejected=(async(input,init)=>String(input).endsWith('/models')?f.fetch(input,init):new Response('data: '+JSON.stringify({type:terminal==='missing'?'response.created':terminal,response:{id:'resp_aaaaaaaa',status:terminal==='response.failed'?'failed':'incomplete',error:{code:'subscription_sharing_usage_unavailable',message:'fixture'},incomplete_details:{reason:'max_output_tokens'},output:[]}})+'\n\n',{headers:{'content-type':'text/event-stream'}})) as typeof fetch;const r=await runLocalSiwcCheck(credential,rejected,new MemoryRoundJournal(),true);assert.ok(r.checks.every(x=>x.status==='failed'&&x.requests===1&&x.toolCalls===0));});
