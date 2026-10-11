import {test} from 'node:test';import assert from 'node:assert/strict';import {generateKeyPair,SignJWT,createLocalJWKSet,exportJWK} from 'jose';import {authorize} from '../src/auth';
const env={ACCESS_TEAM_DOMAIN:'https://owner.cloudflareaccess.com',ACCESS_AUD:'private-aud',OWNER_EMAIL:'owner@example.test',APP_ORIGIN:'https://chat.example.test'};
const {privateKey,publicKey}=await generateKeyPair('RS256');const keys=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'test'}]});
async function token(email=env.OWNER_EMAIL,aud=env.ACCESS_AUD,expiry='5m'){return new SignJWT({email}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(env.ACCESS_TEAM_DOMAIN).setAudience(aud).setSubject('owner').setIssuedAt().setExpirationTime(expiry).sign(privateKey)}
function req(t?:string,method='GET',origin?:string){return new Request(env.APP_ORIGIN+'/api/submit',{method,headers:{...(t?{'Cf-Access-Jwt-Assertion':t}:{}),...(origin?{origin,'Content-Type':'application/json'}:{})}})}
test('rejects missing config and absent token',async()=>{await assert.rejects(authorize(req(),env,keys));await assert.rejects(authorize(req(await token()),{...env,OWNER_EMAIL:''},keys))});
test('accepts owner signed JWT',async()=>assert.equal((await authorize(req(await token()),env,keys)).email,env.OWNER_EMAIL));
test('rejects wrong owner, audience, expired token and forgery',async()=>{for(const t of [await token('other@example.test'),await token(env.OWNER_EMAIL,'other'),await token(env.OWNER_EMAIL,env.ACCESS_AUD,'-1m'),'fake'])await assert.rejects(authorize(req(t),env,keys))});
test('requires same-origin JSON mutation',async()=>{const t=await token();await assert.rejects(authorize(req(t,'POST'),env,keys));await assert.rejects(authorize(req(t,'POST','https://evil.test'),env,keys));await authorize(req(t,'POST',env.APP_ORIGIN),env,keys)});

const plural={...env,OWNER_EMAILS:'owner@example.test, alternate@example.test'};
test('accepts either exact owner email and rejects all other identities',async()=>{
 for(const email of ['owner@example.test','alternate@example.test','ALTERNATE@example.test']) assert.equal((await authorize(req(await token(email)),plural,keys)).email,email);
 for(const email of ['other@example.test','alternate+other@example.test','prefixowner@example.test']) await assert.rejects(authorize(req(await token(email)),plural,keys));
});
test('malformed plural allowlists fail closed and do not fall back to singleton',async()=>{
 for(const OWNER_EMAILS of ['*','owner@example.test,','owner@example.test,*.test','not-an-email']) await assert.rejects(authorize(req(await token()),{...env,OWNER_EMAILS},keys));
 await assert.rejects(authorize(req(await token()),{...env,OWNER_EMAIL:undefined,OWNER_EMAILS:''},keys));
 await assert.rejects(authorize(req(await token()),{...env,OWNER_EMAILS:'alternate@example.test'},keys));
});
