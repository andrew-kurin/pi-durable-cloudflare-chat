import {test} from 'node:test';import assert from 'node:assert/strict';import {redactErrorText,technicalError,logSavedFailure,logTechnicalError} from '../src/error-log';
test('error log preserves technical detail while redacting credentials and request data',()=>{
 const raw='400: '+JSON.stringify({error:{message:'Invalid function_call_output: No tool call found for call_id call_123',code:'invalid_request_error',param:'input[3].call_id',authorization:'Bearer PRIVATE_AUTH',access_token:'PRIVATE_ACCESS',email:'owner@private.example',request:{input:'PRIVATE_PROMPT',headers:{cookie:'PRIVATE_COOKIE'}},arguments:['PRIVATE_ARGUMENTS'],output:'PRIVATE_OUTPUT'}});
 const data=technicalError(raw);assert.equal(data.status,400);assert.equal(data.code,'invalid_request_error');assert.match(data.message,/Invalid function_call_output.*call_123/);assert.match(data.message,/input\[3\].call_id/);assert.ok(!JSON.stringify(data).includes('PRIVATE'));assert.ok(!JSON.stringify(data).includes('owner@private'));
 const error=Object.assign(new TypeError('invalid schema https://user:PRIVATE@api.example.test/route?key=PRIVATE Bearer PRIVATE_AUTH ghp_PRIVATE_TOKEN owner@private.example'),{status:422,code:'invalid_schema'});error.stack='TypeError: bad schema\n at f (/Users/andrew/private/app.ts:17:5)\n at f (https://api.example.test/file.js?token=PRIVATE:5:6)';const logged=technicalError(error);assert.equal(logged.status,422);assert.match(logged.stack!,/app.ts:17:5/);assert.ok(!JSON.stringify(logged).includes('PRIVATE'));assert.ok(!JSON.stringify(logged).includes('/Users/andrew'));
 assert.match(redactErrorText('access_token="PRIVATE" token=PRIVATE Cookie: PRIVATE'),/redacted/);assert.ok(!redactErrorText('access_token="PRIVATE" token=PRIVATE Cookie: PRIVATE').includes('PRIVATE'));assert.ok(redactErrorText('x'.repeat(20000)).length<1900);
});
test('saved diagnostic distinguishes missing from unknown and atomically deduplicates captures without reading prompts or results',async()=>{
 const data=new Map<string,any>();let chain=Promise.resolve();const tx={get:async(k:string)=>data.get(k),put:async(k:string,v:any)=>{data.set(k,v)}};const store={...tx,transaction:<T>(fn:any):Promise<T>=>{const p=chain.then(()=>fn(tx));chain=p.catch(()=>{});return p}};const logs:any[]=[];const entry=(id:string,errorMessage?:string)=>({id,kind:'pi.assistant',model:[{role:'assistant',content:[{type:'thinking',thinking:'PRIVATE_THINKING'}],stopReason:'error',...(errorMessage===undefined?{}:{errorMessage})}]} as never);
 const entries=[{id:'u',kind:'pi.user',model:[{role:'user',content:'PRIVATE_PROMPT'}]} as never,{id:'t',kind:'pi.tool-result',model:[{role:'toolResult',content:[{type:'text',text:'PRIVATE_OUTPUT'}]}]} as never,entry('failure','An unfamiliar technical error')];
 await Promise.all([logSavedFailure(entries,store,'1','capture',r=>logs.push(r)),logSavedFailure(entries,store,'1','capture',r=>logs.push(r))]);assert.equal(logs.length,1);assert.equal(logs[0].stage,'saved_model_response');assert.equal(logs[0].message,'An unfamiliar technical error');assert.equal(logs[0].errorMessagePresent,true);assert.match(logs[0].correlation,/^[a-f0-9]{24}$/);assert.ok(!JSON.stringify(logs).includes('PRIVATE'));
 await logSavedFailure([entry('missing')],store,'1','capture',r=>logs.push(r));assert.equal(logs[1].errorMessagePresent,false);assert.equal(logs[1].errorMessageLength,0);assert.equal(logs[1].message,'[error text unavailable]');assert.equal(await logSavedFailure(entries,store,'1','capture',r=>logs.push(r)),false);
 assert.equal(await logSavedFailure([{id:'success',kind:'pi.assistant',model:[{role:'assistant',content:[{type:'text',text:'PRIVATE_REPLY'}],stopReason:'stop'}]} as never],store,'1','capture',r=>logs.push(r)),false);assert.equal(logs.length,2);
 for(let i=0;i<40;i++)await logSavedFailure([entry('failure-'+i,'technical')],store,'1','capture',()=>{});assert.equal(data.get('diagnostic:saved-error:1').length,32);
});

test('cookie lines, unknown provider fields and malformed request input stay out of logs; logging failures are inert',()=>{
 const cookies=redactErrorText('Cookie: sid=PRIVATE_ONE; session=PRIVATE_TWO\nSet-Cookie: auth=PRIVATE_THREE; Secure; HttpOnly');assert.ok(!cookies.includes('PRIVATE'));
 const body=redactErrorText('400: '+JSON.stringify({error:{message:'Invalid schema',code:'bad_schema',conversation:'PRIVATE_CHAT',payload:'PRIVATE_PAYLOAD',content:'PRIVATE_FILE'}}));assert.match(body,/Invalid schema/);assert.ok(!body.includes('PRIVATE'));
 const logs:any[]=[];logTechnicalError('request',new SyntaxError('Unexpected token PRIVATE_PROMPT'),'correlation',{},r=>logs.push(r));assert.ok(!JSON.stringify(logs).includes('PRIVATE_PROMPT'));assert.match(logs[0].message,/raw input omitted/);assert.doesNotThrow(()=>logTechnicalError('model_dispatch',new Error('technical'),'correlation',{},()=>{throw Error('logger failure')}));
});

test('provider code extraction ignores codes in omitted request context',()=>{const data=technicalError('400: '+JSON.stringify({request:{code:'private_context_identifier'}}));assert.equal(data.code,undefined);assert.ok(!JSON.stringify(data).includes('private_context_identifier'));assert.equal(technicalError('400: '+JSON.stringify({error:{code:'invalid_request_error',request:{code:'private_context_identifier'}}})).code,'invalid_request_error');});

test('oversized provider bodies are not parsed for codes',()=>{assert.equal(technicalError('400: '+JSON.stringify({padding:'x'.repeat(9000),error:{code:'invalid_request_error'}})).code,undefined);});


test('failed saved-error emission leaves the capture retryable, then deduplicates a successful retry',async()=>{
 const data=new Map<string,any>();const tx={get:async(k:string)=>data.get(k),put:async(k:string,v:any)=>{data.set(k,v)}};const store={...tx,transaction:async<T>(fn:(tx:typeof tx)=>Promise<T>)=>fn(tx)};
 const entries=[{id:'failure',kind:'pi.assistant',model:[{role:'assistant',stopReason:'error',errorMessage:'Technical failure Bearer PRIVATE_TOKEN'}]}] as never;
 assert.equal(await logSavedFailure(entries,store,'session','capture',()=>{throw Error('emitter unavailable')}),false);
 assert.equal(data.has('diagnostic:saved-error:session'),false);
 const logs:any[]=[];assert.equal(await logSavedFailure(entries,store,'session','capture',r=>logs.push(r)),true);
 assert.equal(await logSavedFailure(entries,store,'session','capture',r=>logs.push(r)),false);
 assert.equal(logs.length,1);assert.equal(data.get('diagnostic:saved-error:session').length,1);assert.ok(!JSON.stringify(logs).includes('PRIVATE_TOKEN'));
});
