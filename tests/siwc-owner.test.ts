import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, writeFile, readFile, rm, stat, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, SignJWT } from 'jose';
import { openSiwcOwner, readProtected, type OwnedCredential } from '../services/model-runner/siwc-owner';
import { SIWC } from '../services/model-runner/siwc-auth';
const pair = await generateKeyPair('ES256');
const identity = { clientId: 'synthetic-client', subject: 'synthetic-subject', hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001' };
const now = Date.now();
const credential: OwnedCredential = { ...identity, access: 'SYNTHETIC-OLD-ACCESS', refresh: 'SYNTHETIC-OLD-REFRESH', idToken: 'SYNTHETIC-OLD-ID', scopes: SIWC.scopes.split(' '), expires: now-1 };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(value = credential) {
 const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-siwc-owner-'))); await chmod(dir, 0o700); const path = join(dir, 'credentials.json'); await writeFile(path, JSON.stringify(value), {mode:0o600});
 let calls=0; const jwt = await new SignJWT({}).setProtectedHeader({alg:'ES256'}).setSubject(identity.subject).setIssuer(SIWC.issuer).setAudience(identity.clientId).setIssuedAt(Math.floor(now/1000)).setExpirationTime(Math.floor(now/1000)+3600).sign(pair.privateKey);
 const tokens = {token_type:'Bearer',access_token:'SYNTHETIC-NEW-ACCESS',refresh_token:'SYNTHETIC-NEW-REFRESH',id_token:jwt,expires_in:3600,scope:SIWC.scopes,earliest_refresh_at:Math.floor(now/1000)+1800};
 const transport = (async(url:any,init:any) => { calls++;assert.equal(url,SIWC.token);assert.equal(init.redirect,'error');const form=init.body as URLSearchParams;assert.equal(form.get('grant_type'),'refresh_token');assert.equal(form.get('client_id'),identity.clientId);assert.equal(form.get('refresh_token'),credential.refresh);assert.equal(form.get('resource'),SIWC.resource);assert.equal(form.has('scope'),false);assert.match(await readFile(path+'.refreshing','utf8'),/may have been dispatched/);return Response.json(tokens); }) as typeof fetch;
 const options = {path,expected:identity,fetch:transport,keys:async()=>pair.publicKey,now:()=>now};
 return {dir,path,tokens,options,calls:()=>calls,dispose:()=>rm(dir,{recursive:true,force:true})};
}
test('fresh grant reads locally; concurrent expiry has one owner and durable rotated tokens',async()=>{
 const fresh=await fixture({...credential,expires:now+60000});try{const owner=await openSiwcOwner(fresh.options);assert.equal(await owner.access(),credential.access);assert.equal(fresh.calls(),0);await owner.close();}finally{await fresh.dispose();}
 const f=await fixture(),gate=deferred<void>(),entered=deferred<void>();const transport=f.options.fetch;
 try{
  const owner=await openSiwcOwner({...f.options,fetch:async(u,i)=>{entered.resolve();await gate.promise;return transport(u,i);}});
  await assert.rejects(openSiwcOwner(f.options),/EEXIST/);
  const requests=[owner.access(),owner.access(),owner.access()];await entered.promise;gate.resolve();assert.deepEqual(await Promise.all(requests),Array(3).fill('SYNTHETIC-NEW-ACCESS'));assert.equal(f.calls(),1);
  const stored=JSON.parse(await readProtected(f.path));assert.equal(stored.refresh,'SYNTHETIC-NEW-REFRESH');assert.equal(stored.hostId,identity.hostId);assert.equal(stored.clientId,identity.clientId);assert.equal((await stat(f.path)).mode&0o777,0o600);await assert.rejects(access(f.path+'.refreshing'));await owner.close();
  const restarted=await openSiwcOwner(f.options);assert.equal(await restarted.access(),'SYNTHETIC-NEW-ACCESS');assert.equal(f.calls(),1);await restarted.close();
 }finally{gate.resolve();await f.dispose();}
});
for(const mode of ['network','http','malformed','wrong-subject','wrong-scope','timeout','persistence'] as const)test('ambiguous refresh '+mode+' stays locked across restart without replay',async()=>{
 const f=await fixture();let attempts=0;let owner:Awaited<ReturnType<typeof openSiwcOwner>>|undefined;
 try{
  const wrongJwt=await new SignJWT({}).setProtectedHeader({alg:'ES256'}).setSubject('wrong').setIssuer(SIWC.issuer).setAudience(identity.clientId).setIssuedAt(Math.floor(now/1000)).setExpirationTime(Math.floor(now/1000)+3600).sign(pair.privateKey);
  owner=await openSiwcOwner({...f.options,refreshTimeoutMs:15,fetch:async()=>{
   attempts++;if(mode==='network')throw Error('SENSITIVE');if(mode==='timeout')return new Promise(()=>{});if(mode==='http')return new Response('SENSITIVE',{status:500});if(mode==='malformed')return Response.json({bad:'SENSITIVE'});
   if(mode==='persistence'){await rm(f.path);// Trigger atomic target replacement failure inside fixture only.
    await import('node:fs/promises').then(fs=>fs.mkdir(f.path));}
   return Response.json({...f.tokens,...(mode==='wrong-subject'?{id_token:wrongJwt}:{}),...(mode==='wrong-scope'?{scope:'openid'}:{})});
  }});
  await assert.rejects(owner.access(),/siwc_refresh_resolution_required/);await assert.rejects(owner.access(),/siwc_refresh_resolution_required/);assert.equal(attempts,1);assert.ok(await stat(f.path+'.refreshing'));await owner.close();owner=undefined;
  if(mode==='persistence'){await rm(f.path,{recursive:true});await writeFile(f.path,JSON.stringify(credential),{mode:0o600});}
  await assert.rejects(openSiwcOwner(f.options),/siwc_refresh_resolution_required/);assert.equal(attempts,1);
 }finally{await owner?.close().catch(()=>{});await f.dispose();}
});
test('refresh response body and headers deadlines are bounded, including late response cancellation',async()=>{
 const f=await fixture(),gate=deferred<Response>();let canceled=0;
 try{const owner=await openSiwcOwner({...f.options,refreshTimeoutMs:15,fetch:()=>gate.promise});await assert.rejects(owner.access(),/resolution/);gate.resolve(new Response(new ReadableStream({cancel(){canceled++;}})));await new Promise(ok=>setImmediate(ok));assert.equal(canceled,1);await owner.close();}finally{await f.dispose();}
 const g=await fixture();try{let canceled=0;const owner=await openSiwcOwner({...g.options,refreshTimeoutMs:15,fetch:async()=>new Response(new ReadableStream({cancel(){canceled++;}}))});await assert.rejects(owner.access(),/resolution/);assert.equal(canceled,1);await owner.close();}finally{await g.dispose();}
});
test('protected credentials reject symlinks, loose modes, identity mismatch and unexpired earliest-refresh window',async()=>{
 const f=await fixture();try{
  await chmod(f.path,0o644);await assert.rejects(openSiwcOwner(f.options),/Protected file/);await chmod(f.path,0o600);
  const alias=join(f.dir,'alias');await symlink(f.path,alias);await assert.rejects(openSiwcOwner({...f.options,path:alias}));
  await assert.rejects(openSiwcOwner({...f.options,expected:{...identity,subject:'other'}}),/invalid/);
  await chmod(f.dir,0o755);await assert.rejects(openSiwcOwner(f.options),/Protected directory/);await chmod(f.dir,0o700);
  await writeFile(f.path,JSON.stringify({...credential,earliestRefreshAt:now+30000}));const owner=await openSiwcOwner(f.options);await assert.rejects(owner.access(),/refresh_deferred/);assert.equal(f.calls(),0);await assert.rejects(access(f.path+'.refreshing'));await owner.close();
 }finally{await f.dispose();}
});
test('malformed credential JSON never exposes parser snippets and releases only its own lock',async()=>{
 const f=await fixture();try{await writeFile(f.path,'{"access":"SYNTHETIC-SECRET-DO-NOT-PRINT",');await assert.rejects(openSiwcOwner(f.options),e=>{assert.equal((e as Error).message,'siwc_credential_invalid');assert.ok(!String((e as Error).stack).includes('DO-NOT-PRINT'));return true;});await assert.rejects(access(f.path+'.owner'));assert.equal(f.calls(),0);}finally{await f.dispose();}
});
