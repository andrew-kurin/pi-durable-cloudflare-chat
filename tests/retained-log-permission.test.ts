import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probe } from '../scripts/probe-retained-log-permission.mjs';
test('fixed permission probe discards private logs, preserves status only and never retries',async()=>{
 for(const status of [200,403,500]) {
  let calls=0,cancelled=0;
  const result=await probe(async(url:any,init:any)=>{calls++;assert.equal(url,'https://api.cloudflare.com/client/v4/accounts/'+ 'a'.repeat(32)+'/workers/observability/telemetry/query');assert.equal(init.redirect,'error');const q=JSON.parse(init.body);assert.equal(q.dry,true);assert.equal(q.limit,1);assert.equal(q.parameters.filters[0].value,'pi-private-chat');return new Response(new ReadableStream({cancel(){cancelled++;}}),{status});},'SYNTHETIC-SECRET','a'.repeat(32));
  assert.equal(result.authorized,status===200);assert.equal(result.httpStatus,status);assert.equal(calls,1);assert.equal(cancelled,1);assert.ok(!JSON.stringify(result).includes('SYNTHETIC-SECRET'));
 }
});
test('missing CI credential and transport errors cannot expose values or create a query',async()=>{
 const fail=async()=>{throw Error('SYNTHETIC-SECRET')};const result=await probe(fail,'SYNTHETIC-SECRET','a'.repeat(32));assert.equal(result.authorized,false);assert.ok(!JSON.stringify(result).includes('SYNTHETIC-SECRET'));
 assert.equal((await probe(async()=>{throw Error('Must not run')},'',undefined)).authorized,false);
});
