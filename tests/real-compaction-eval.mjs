// Opt-in real Sol/Spark eval. No arguments prints a zero-call plan.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {Harness,createRegistry,defineExtension,defineTool,watchEvents} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {Type} from '@earendil-works/pi-ai';
import {createWorkerRunnerProvider} from '../src/model-runner-worker.ts';
import {createChatModels} from '../src/provider-sessions.ts';
import {guardModels} from '../src/model-guard.ts';
import {compactionLogs,COMPACTION_POLICY} from '../src/compaction.ts';
import {fullHistorySnapshot} from '../src/history-snapshot.ts';
import {ChatProjection} from '../src/projector.ts';
import {technicalError} from '../src/error-log.ts';
export const FACTS={codename:'Cedar Lantern',region:'eu-west-2',retention:'17 days',gate:'ticket ASH-42',artifact:'pkg-ash-47',checksum:'8c9e47b2'};
export const POLICY={enabled:true,reserveTokens:2048,keepRecentTokens:1024,backgroundTokens:0};
export const PLAN={model:'gpt-6.1-sol',endpoint:'https://pi-runner.andrewkurin.com/v1/responses',maxRequests:4,maxRequestBytes:100000,maxResponseBytes:160000,maxInputTokens:50000,maxOutputTokens:8000,requestMs:90000,runMs:240000,contextWindow:8192,policy:POLICY,productionPolicy:COMPACTION_POLICY,coverage:'native Pi automatic blocking compaction; synthetic history; local SQLite reopen; signed production Spark transport',limits:'Not a hard token/billing ceiling: SIWC strips output tuning; stopping delivery does not guarantee backend computation stops.'};
const usage={input:0,output:0,cacheRead:0};
export async function runCompactionEval({directory,transport,key='07'.repeat(32),endpoint=PLAN.endpoint}={}){
 directory??=await mkdtemp(path.join(tmpdir(),'pi-compaction-eval-'));
 const report={status:'running',plan:PLAN,directory,rounds:[],usage:{...usage},checks:{},toolExecutions:0};
 const namespace='compaction-eval-'+randomUUID(),fresh='probe-'+randomUUID();
 const records=new Map(),store={transaction:async fn=>fn({get:async k=>records.get(k),put:async(k,v)=>{records.set(k,v);}})};
 let admission=0,allowDispatch=true,harness;
 const started=Date.now(),deadline=new AbortController();
 const timer=setTimeout(()=>deadline.abort(Error('Eval total deadline')),PLAN.runMs);
 const fetcher=async request=>{
  assert.ok(allowDispatch,'Reload unexpectedly attempted inference');assert.ok(report.rounds.length<PLAN.maxRequests,'Eval dispatch cap');
  assert.ok(report.usage.input<PLAN.maxInputTokens&&report.usage.output<PLAN.maxOutputTokens,'Eval usage cap');
  const body=await request.clone().text();assert.ok(Buffer.byteLength(body)<=PLAN.maxRequestBytes,'Eval input byte cap');
  const row={roundId:request.headers.get('x-pi-round-id'),kind:request.headers.get('x-pi-task-kind'),model:JSON.parse(body).model,bodyBytes:Buffer.byteLength(body),startedAt:new Date().toISOString()};report.rounds.push(row);
  const start=Date.now(),signal=AbortSignal.any([request.signal,deadline.signal,AbortSignal.timeout(PLAN.requestMs)]);
  try{
   const response=await (transport??globalThis.fetch)(new Request(request,{signal}));row.httpStatus=response.status;
   let pending='',bytes=0;const decoder=new TextDecoder();
   const inspect=frame=>{for(const line of frame.split('\n'))if(line.startsWith('data: ')){
    const raw=line.slice(6);if(raw==='[DONE]')continue;const event=JSON.parse(raw);
    if(event.type==='response.completed'){
     const u=event.response?.usage;if(u){row.usage={input_tokens:u.input_tokens,output_tokens:u.output_tokens,cached_tokens:u.input_tokens_details?.cached_tokens??0};report.usage.input+=u.input_tokens??0;report.usage.output+=u.output_tokens??0;report.usage.cacheRead+=u.input_tokens_details?.cached_tokens??0;}
     row.completed=true;
    }
   }};
   return new Response(response.body?.pipeThrough(new TransformStream({transform(chunk,out){
    bytes+=chunk.byteLength;assert.ok(bytes<=PLAN.maxResponseBytes,'Eval response byte cap');
    pending=(pending+decoder.decode(chunk,{stream:true})).replace(/\r\n/g,'\n');let split;
    while((split=pending.indexOf('\n\n'))>=0){inspect(pending.slice(0,split));pending=pending.slice(split+2);}out.enqueue(chunk);
   },flush(){if(pending.trim())inspect(pending);row.durationMs=Date.now()-start;row.responseBytes=bytes;}})),{status:response.status,headers:response.headers});
  }catch(error){row.error=technicalError(error);row.durationMs=Date.now()-start;throw error;}
 };
 const provider=createWorkerRunnerProvider({ENABLE_MODEL_RUNNER:'true',MODEL_RUNNER_ENDPOINT:endpoint,MODEL_RUNNER_TRANSPORT_KEY:key},store,namespace,fetcher);
 const getModels=provider.getModels.bind(provider);provider.getModels=()=>getModels().map(m=>({...m,contextWindow:PLAN.contextWindow}));
 const models=guardModels(createChatModels({read:async()=>undefined,list:async()=>[],modify:async()=>{throw Error('Eval has no OAuth credential store');}},provider),async()=>{assert.ok(++admission<=PLAN.maxRequests,'Eval quota cap');});
 const registry=createRegistry();registry.install(compactionLogs());registry.install(defineExtension({name:'compaction-eval',tools:[defineTool({name:'eval_probe',description:'Get the fresh synthetic continuation proof. Call exactly once when instructed.',parameters:Type.Object({}),replay:'safe',execute:async()=>{report.toolExecutions++;return {content:[{type:'text',text:fresh}]};}})]}));
 const open=async()=>Harness.open(await openNodeSqliteStorage(path.join(directory,'harness.sqlite')),{models,registry,settings:{compaction:POLICY,retry:{enabled:false}}},context);
 const visible=async root=>{const events=await watchEvents(harness,root.id,context);try{const projection=new ChatProjection();projection.apply(await fullHistorySnapshot({conversation:async()=>root},'eval',events.snapshot));return projection.view().messages;}finally{await events.stop();}};
 try{
  harness=await open();let root=await harness.root(context,{agent:{model:{provider:'model-runner-siwc',modelId:PLAN.model}}});
  const write=async(id,kind,model)=>{const done=await(await root.submit({type:'write',requestId:id,entry:{kind,model}},context)).wait(context);assert.equal(done.status,'done');};
  await write('facts','pi.user',[{role:'user',content:'Synthetic evaluation: preserve these exact project facts and decisions for later continuation: '+JSON.stringify(Object.fromEntries(Object.entries(FACTS).filter(([k])=>!['artifact','checksum'].includes(k))))+'. The latest saved artifact/checksum tool evidence is authoritative. All following archive-padding lines are irrelevant historical filler.',timestamp:1}]);
  const blankUsage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  await write('saved-call','pi.assistant',[{role:'assistant',api:'openai-responses',provider:'model-runner-siwc',model:PLAN.model,usage:blankUsage,content:[{type:'toolCall',id:'call_saved',name:'saved_artifact',arguments:{}}],stopReason:'toolUse',timestamp:2}]);
  await write('saved-result','pi.tool-result',[{role:'toolResult',toolCallId:'call_saved',toolName:'saved_artifact',content:[{type:'text',text:JSON.stringify({artifact:FACTS.artifact,checksum:FACTS.checksum})}],isError:false,timestamp:3}]);
  for(let i=0;i<12;i++)await write('padding-'+i,'pi.user',[{role:'user',content:('Archive padding '+i+': irrelevant historical detail; preserve earlier project decisions and tool evidence. ').repeat(32),timestamp:4+i}]);
  await write('recent','pi.user',[{role:'user',content:'Continue the synthetic project after the checkpoint. Use the saved facts, and call eval_probe when the next request asks for fresh proof.',timestamp:20}]);
  const before=await visible(root),prior=await root.context(context);
  const result=await(await root.submit({type:'input',requestId:'continue',content:'Call eval_probe exactly once. Then return one concise JSON object with codename, region, retention, gate, artifact, checksum, and freshProof. Use the saved project decisions and saved tool evidence for the first six fields, and the actual eval_probe result for freshProof. Do not invent or run other tools.'},context)).wait(context);
  report.outcome=result;assert.equal(result.status,'done',JSON.stringify(result));
  const entries=await root.entries({order:'ascending'},100,undefined,context);const compactions=entries.items.filter(e=>e.kind==='pi.compaction');
  assert.equal(compactions.length,1,'Expected one native automatic compaction');assert.equal(report.rounds[0].kind,'compaction');
  const afterContext=await root.context(context),summary=JSON.stringify(compactions[0].model);
  assert.ok(!JSON.stringify(afterContext.messages).includes('Archive padding 0:'),'Old padding remained in active context');
  report.checks.oldPrefixReplaced=true;
  report.checks.summaryFacts=Object.fromEntries(Object.entries(FACTS).map(([k,v])=>[k,summary.includes(v)]));
  assert.ok(Object.values(report.checks.summaryFacts).every(Boolean),'Summary lost required old-prefix facts');
  const after=await visible(root),answer=after.filter(m=>m.role==='assistant').at(-1)?.text??'';
  const parsedAnswer=JSON.parse(answer);
  report.checks.answerFacts=Object.fromEntries(Object.entries({...FACTS,freshProof:fresh}).map(([k,v])=>[k,parsedAnswer[k]===v]));
  assert.ok(Object.values(report.checks.answerFacts).every(Boolean),'Continuation lost facts or fresh tool proof');assert.equal(report.toolExecutions,1);
  assert.deepEqual(after.slice(0,before.length),before);report.checks.originalHistoryPreserved=true;
  report.context={beforeMessages:prior.messages.length,afterMessages:afterContext.messages.length,summary,answer};
  const calls=report.rounds.length;await harness.close(context);harness=undefined;allowDispatch=false;
  harness=await open();root=await harness.root(context);assert.deepEqual(await visible(root),after);assert.deepEqual((await root.context(context)).messages,afterContext.messages);assert.equal(report.rounds.length,calls);
  report.checks.sqliteReloadPreserved=true;report.checks.noReloadInference=true;report.status='passed';
 }catch(error){report.status='failed';report.error=technicalError(error);}
 finally{deadline.abort();clearTimeout(timer);await harness?.close(context);report.durationMs=Date.now()-started;report.usage.complete=report.rounds.length>0&&report.rounds.every(row=>row.completed&&row.usage);await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 if(!args.includes('--run'))console.log(JSON.stringify(PLAN,null,2));
 else{
  assert.ok(args.includes('--allow-subscription-usage'),'Approved subscription usage requires explicit flag');
  const keyPath=args[args.indexOf('--transport-key-file')+1];assert.ok(args.includes('--transport-key-file')&&keyPath,'Existing transport key file required');
  assert.equal((await stat(keyPath)).mode&0o077,0,'Private transport key file required');const key=(await readFile(keyPath,'utf8')).trim();assert.match(key,/^[a-f0-9]{64}$/);
  const report=await runCompactionEval({key});console.log(JSON.stringify({status:report.status,requests:report.rounds.length,usage:report.usage,durationMs:report.durationMs,checks:report.checks,report:path.join(report.directory,'report.json'),error:report.error}));if(report.status!=='passed')process.exitCode=1;
 }
}
