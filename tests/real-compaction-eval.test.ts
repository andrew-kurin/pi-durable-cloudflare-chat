import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {runCompactionEval,FACTS} from './real-compaction-eval.mjs';
function response(items:any[]){return new Response([{type:'response.created',response:{id:'resp_eval'}},...items.flatMap((item,output_index)=>[{type:'response.output_item.added',output_index,item},{type:'response.output_item.done',output_index,item}]),{type:'response.completed',response:{id:'resp_eval',status:'completed',output:items,usage:{input_tokens:20,output_tokens:10}}}].map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});}
const text=(value:string)=>({type:'message',id:'msg_eval',role:'assistant',content:[{type:'output_text',text:value,annotations:[]}]});
function fixtureTransport(omitChecksum=false){return async(request:Request)=>{
  const body=await request.json() as any;const id=request.headers.get('x-pi-round-id')!;let result;
  if(request.headers.get('x-pi-task-kind')==='compaction')result=response([text('Summary: '+JSON.stringify({...FACTS,...(omitChecksum?{checksum:'LOST'}:{})}))]);
  else{const output=body.input.filter((item:any)=>item.type==='function_call_output').at(-1);
   result=output?response([text(JSON.stringify({...FACTS,freshProof:typeof output.output==='string'?output.output:output.output[0].text}))]):response([{type:'function_call',id:'fc_probe',call_id:'call_probe',name:'eval_probe',arguments:'{}'}]);
  }
  result.headers.set('x-pi-round-id',id);return result;
 };}
test('opt-in compaction eval rehearses native summary, fresh tool use and SQLite reload with zero real calls',async()=>{
 const report=await runCompactionEval({transport:fixtureTransport()});
 try{assert.equal(report.status,'passed',JSON.stringify(report));assert.equal(report.rounds.length,3);assert.equal(report.toolExecutions,1);assert.equal(report.checks.sqliteReloadPreserved,true);}finally{await rm(report.directory,{recursive:true,force:true});}
});

test('compaction eval rejects a summary that loses old tool evidence even if the final answer is correct',async()=>{
 const report=await runCompactionEval({transport:fixtureTransport(true)});
 try{assert.equal(report.status,'failed');assert.equal(report.checks.summaryFacts.checksum,false);}finally{await rm(report.directory,{recursive:true,force:true});}
});
