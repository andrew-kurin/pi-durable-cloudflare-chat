import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';import {ContainerWorkspaceAdapter,EXPORT_SCRIPT,FILE_OPERATION,LOG_OPERATION,PROCESS_RUN,PROCESS_STATUS} from '../src/workspace-adapter';
import {WorkspaceFileError,workspaceFileError} from '../src/workspace-error';
test('file helper edits once, creates new files and rejects traversal',async()=>{const dir=await mkdtemp(join(tmpdir(),'pi-workspace-files-'));const script=FILE_OPERATION.replace("root='/workspace/project'",'root='+JSON.stringify(await realpath(dir)));try{await writeFile(join(dir,'file.txt'),'old\n');execFileSync('python3',['-c',script,'edit','file.txt'],{input:JSON.stringify({oldText:'old',newText:'new'})});assert.equal(await readFile(join(dir,'file.txt'),'utf8'),'new\n');assert.equal(execFileSync('python3',['-c',script,'read','file.txt']).toString(),'new\n');assert.throws(()=>execFileSync('python3',['-c',script,'edit','file.txt'],{input:JSON.stringify({oldText:'missing',newText:'new'}),stdio:['pipe','pipe','pipe']}));execFileSync('python3',['-c',script,'edit','created.txt'],{input:'{"oldText":"","newText":"created"}'});assert.equal(await readFile(join(dir,'created.txt'),'utf8'),'created');assert.throws(()=>execFileSync('python3',['-c',script,'read','../outside'],{stdio:'pipe'}));}finally{await rm(dir,{recursive:true,force:true})}});
test('Sandbox 1.0 adapter dispatch does not await command completion; subsequent requests inspect pid/boot records',async()=>{const calls:any[]=[];let starts:any;const container={running:false,images:{},start:(opts:any)=>{starts=opts;container.running=true},setInactivityTimeout:async()=>{},destroy:async()=>{container.running=false},signal:()=>{},exec:async(argv:string[],opts:any)=>{calls.push({argv,opts});let text='';if(argv.includes('rev-parse'))text='a'.repeat(40);if(argv[0]==='realpath')text='/workspace/project';if(argv.includes(PROCESS_STATUS))text='running';return {stdin:null,stdout:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(text));c.close()}}),stderr:new ReadableStream({start(c){c.close()}}),exitCode:argv.includes(PROCESS_RUN)?new Promise(()=>{}):Promise.resolve(0),kill:()=>{}}}} as unknown as Container;
 const adapter=new ContainerWorkspaceAdapter(container,'test-image');const signal=new AbortController().signal;assert.equal(await adapter.open('owner/project',signal),'a'.repeat(40));assert.deepEqual(starts.env,{GIT_TERMINAL_PROMPT:'0'});await adapter.dispatch('a'.repeat(64),['npm','test'],'.',signal);assert.equal((await adapter.status('a'.repeat(64),signal)).state,'running');const command=calls.find(c=>c.argv.includes(PROCESS_RUN));assert.equal(command.opts.stdout,'ignore');assert.ok(command.argv.includes('npm'));assert.match(PROCESS_RUN,/start_new_session=True/);assert.match(PROCESS_STATUS,/boot/);await adapter.stop();assert.equal(container.running,false);
});
test('whole-guest forced signal is sent even when destroy confirmation hangs',async()=>{let killed=false;const container={running:true,signal:(s:number)=>{assert.equal(s,9);killed=true},destroy:()=>new Promise(()=>{})} as unknown as Container;const adapter=new ContainerWorkspaceAdapter(container,'test-image');void adapter.stop();assert.equal(killed,true)});

test('only exact allowlisted helper diagnostics become actionable file errors',async()=>{
 const stream=(text:string)=>new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(text));c.close()}});
 for(const [stderr,expected] of [
  ['{"workspaceFileError":"permission_denied"}','permission_denied'],
  ['Traceback: api_key=synthetic-private-value','file_operation_failed'],
  ['{"workspaceFileError":"unknown-private-value"}','file_operation_failed'],
  ['{"workspaceFileError":"file_not_found","details":"api_key=synthetic-private-value"}','file_operation_failed'],
 ] as const){
  const adapter=new ContainerWorkspaceAdapter({running:true,exec:async()=>({stdout:stream(''),stderr:stream(stderr),exitCode:Promise.resolve(2),kill:()=>{}})} as unknown as Container,'fixture');
  await assert.rejects(adapter.read('source.ts',new AbortController().signal),(error:any)=>{
   assert.ok(error instanceof WorkspaceFileError);assert.equal(error.code,expected);assert.ok(error.nextStep.length>20);assert.doesNotMatch(error.message+error.nextStep,/synthetic-private-value|unknown-private-value|Traceback|api_key/);return true;
  });
 }
 assert.equal(workspaceFileError('{"workspaceFileError":"__proto__"}'),undefined);
});

test('exports preserve log text and add the same retention metadata without claiming missing output',async()=>{
 const stream=(text:string)=>new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(text));c.close()}});
 const metadata={retention:'tail',limitBytes:16384,retainedBytes:4,totalBytes:20000,droppedBytes:19996,truncated:true,available:true,notice:'Discarded bytes are unavailable.'};
 const container={running:true,exec:async(argv:string[])=>{
  const record=argv[2]===LOG_OPERATION?(argv.at(-1)==='stdout'?{text:'tail',...metadata}:{text:'',retention:'tail',limitBytes:16384,retainedBytes:0,totalBytes:null,droppedBytes:null,truncated:null,available:false,notice:'Recorded log is unavailable.'}):undefined;
  return {stdout:stream(record?JSON.stringify(record):argv.includes(EXPORT_SCRIPT)?'c'.repeat(40)+'\npatch':'patch'),stderr:stream(''),exitCode:Promise.resolve(0),kill:()=>{}};
 }} as unknown as Container;
 const run='a'.repeat(64),result=await new ContainerWorkspaceAdapter(container,'fixture').collect('b'.repeat(40),[run],new AbortController().signal);
 assert.equal(result.patch,'patch');assert.equal(result.logs[run+'/stdout'],'tail');assert.deepEqual(result.logMetadata![run+'/stdout'],metadata);
 assert.equal(result.logMetadata![run+'/stderr'].available,false);assert.ok(result.gaps.includes('Log unavailable: '+run+'/stderr'));assert.match(result.gaps.at(-1)!,/discarded bytes are unavailable/);
});
