import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isRetryableAssistantError} from '@earendil-works/pi-ai/utils/retry';
import type {AssistantMessage} from '@earendil-works/pi-ai';
const html='<html><style>.logo{font-weight:500}</style><svg data-path="502 504 524"></svg><p>Unable to load site</p></html>';
function message(errorMessage:string,status?:number):AssistantMessage{
 return {role:'assistant',content:[],api:'openai-codex-responses',provider:'openai-codex',model:'gpt-6-sol',stopReason:'error',errorMessage,timestamp:0,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},...(status?{diagnostics:[{type:'provider_http_response',timestamp:0,details:{status}}]}:{})};
}
test('403 HTML incidental numbers cannot cause a retry; error and diagnostics stay intact',()=>{
 const failure=message(html,403);const before=JSON.stringify(failure);assert.equal(isRetryableAssistantError(failure),false);assert.equal(JSON.stringify(failure),before);
 for(const status of [400,401,404,409,422,501,505])assert.equal(isRetryableAssistantError(message(html,status)),false);
});
test('actual transient HTTP statuses retry without misleading text, while quota remains terminal',()=>{
 for(const status of [408,429,500,502,503,504,520,524])assert.equal(isRetryableAssistantError(message('Upstream request unavailable',status)),true);
 assert.equal(isRetryableAssistantError(message('insufficient_quota',429)),false);
 assert.equal(isRetryableAssistantError(message('Monthly usage limit reached',429)),false);
});
test('pre-response network errors and failures within HTTP200 streams keep existing classification',()=>{
 assert.equal(isRetryableAssistantError(message('fetch failed')),true);assert.equal(isRetryableAssistantError(message('stream ended before a terminal response event',200)),true);assert.equal(isRetryableAssistantError(message('Unsupported request',200)),false);
});
test('latest response determines classification, malformed diagnostic status is ignored',()=>{
 const failure=message(html,502);failure.diagnostics!.push({type:'provider_http_response',timestamp:1,details:{status:403}});assert.equal(isRetryableAssistantError(failure),false);
 const reverse=message('Unavailable',403);reverse.diagnostics!.push({type:'provider_http_response',timestamp:1,details:{status:503}});assert.equal(isRetryableAssistantError(reverse),true);
 const invalid=message('fetch failed');invalid.diagnostics=[{type:'provider_http_response',timestamp:1,details:{status:'403'}}];assert.equal(isRetryableAssistantError(invalid),true);
});
