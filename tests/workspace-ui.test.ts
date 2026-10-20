import {test} from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';import {readFile} from 'node:fs/promises';import {workspacePanel} from '../public/workspace.js';
import {WorkspaceController,DEFAULT_WORKSPACE_LIMITS,type WorkspaceAdapter} from '../src/workspace';
test('owner panel is off by default, retries the same workspace ID and exposes explicit extension/export/cancel',async()=>{
 const dom=new JSDOM(await readFile('public/index.html','utf8'),{url:'https://chat.example.test'}),d=dom.window.document;const requests:any[]=[];let currentId:any,openFails=true;const state={id:'a'.repeat(36),phase:'ready',runs:{},gaps:['<img onerror=attack>'],deadline:100};
 const api=async(path:string,body:any)=>{requests.push({path,body});if(body?.workspaceId){if(openFails){openFails=false;throw Error('Temporary failure')}currentId=body.workspaceId;return {...state,id:currentId}}if(body?.action==='export')return {url:'/api/workspaces/'+currentId+'/artifact?export='+body.operationId};if(body)return {...state,id:currentId};if(path==='/api/workspaces?session=1')return {workspaceId:currentId};return {...state,id:currentId}};
 const panel=workspacePanel({document:d,api,currentSession:()=> '1'});try{await panel.configure({workspaceEnabled:false});assert.equal(requests.length,0);assert.equal(d.querySelector('#workspace-panel')!.hidden,true);await panel.configure({workspaceEnabled:true,workspaceRepository:'owner/project'});await (d.getElementById('workspace-open') as any).onclick();await (d.getElementById('workspace-open') as any).onclick();const opens=requests.filter(r=>r.body?.workspaceId);assert.equal(opens[0].body.workspaceId,opens[1].body.workspaceId);assert.equal(d.querySelector('img'),null);await (d.getElementById('workspace-extend-task') as any).onclick();assert.deepEqual(requests.at(-1).body,{target:'task',minutes:30});await (d.getElementById('workspace-export') as any).onclick();assert.equal(d.getElementById('workspace-artifact')!.hidden,false);await (d.getElementById('workspace-cancel') as any).onclick();assert.equal(requests.at(-1).body.action,'cancel');}finally{dom.window.dispatchEvent(new dom.window.Event('pagehide'));dom.window.close()}
});
test('Cancel is usable while setup is pending and an early mapping race retries the same operation',async()=>{
 const dom=new JSDOM(await readFile('public/index.html','utf8'),{url:'https://chat.example.test'}),d=dom.window.document;let release:any,workspaceId:any;const cancels:any[]=[];
 const api=async(_path:string,body:any)=>{if(body?.workspaceId){workspaceId=body.workspaceId;return new Promise(resolve=>release=()=>resolve({id:workspaceId,phase:'closed',runs:{},gaps:[]}))}if(body?.action==='cancel'){cancels.push(body);if(cancels.length===1)throw Error('Workspace not found');release();return {id:workspaceId,phase:'closed',runs:{},gaps:[]}}return {}};
 const panel=workspacePanel({document:d,api,currentSession:()=> '1'});try{await panel.configure({workspaceEnabled:true,workspaceRepository:'owner/project'});const opening=(d.getElementById('workspace-open') as any).onclick();assert.equal((d.getElementById('workspace-cancel') as HTMLButtonElement).disabled,false);await (d.getElementById('workspace-cancel') as any).onclick();await opening;assert.equal(cancels.length,2);assert.equal(cancels[0].operationId,cancels[1].operationId);assert.match(d.getElementById('workspace-state')!.textContent!,/Closed/)}finally{dom.window.dispatchEvent(new dom.window.Event('pagehide'));dom.window.close()}
});

test('slow status refresh is not invalidated by polling and shows loading and error feedback',async()=>{
 const dom=new JSDOM(await readFile('public/index.html','utf8'),{url:'https://chat.example.test'}),d=dom.window.document;let poll:any,release:any,fail=false,calls=0;
 dom.window.setInterval=((fn:any)=>{poll=fn;return 1}) as any;
 const api=async(path:string)=>{calls++;if(fail)throw Error('Request unavailable');if(path==='/api/workspaces?session=1')return {workspaceId:'a'.repeat(36)};return new Promise(resolve=>release=()=>resolve({id:'a'.repeat(36),phase:'ready',runs:{},gaps:[]}))};
 const panel=workspacePanel({document:d,api,currentSession:()=> '1'});try{const loading=panel.configure({workspaceEnabled:true,workspaceRepository:'owner/project'});await new Promise(r=>setTimeout(r,0));assert.equal(d.getElementById('workspace-state')!.textContent,'Checking…');assert.equal((d.getElementById('workspace-refresh') as HTMLButtonElement).disabled,true);poll();poll();assert.equal(calls,2,'polling must share the outstanding refresh');release();await loading;assert.equal(d.getElementById('workspace-state')!.textContent,'Ready');assert.equal((d.getElementById('workspace-refresh') as HTMLButtonElement).disabled,false);fail=true;await panel.refresh();assert.equal(d.getElementById('workspace-state')!.textContent,'Workspace status unavailable');assert.equal(d.getElementById('workspace-warning')!.textContent,'Request unavailable');assert.equal(d.getElementById('workspace-refresh')!.getAttribute('aria-busy'),'false');}finally{dom.window.dispatchEvent(new dom.window.Event('pagehide'));dom.window.close()}
});

test('delayed status cannot overwrite a newer owner cancellation',async()=>{
 const dom=new JSDOM(await readFile('public/index.html','utf8'),{url:'https://chat.example.test'}),d=dom.window.document;const id='a'.repeat(36),ready={id,phase:'ready',runs:{},gaps:[]};let delay=false,release:any;
 const api=async(path:string,body:any)=>{if(body?.action==='cancel')return {...ready,phase:'closed'};if(path==='/api/workspaces?session=1')return {workspaceId:id};if(delay)return new Promise(resolve=>release=()=>resolve(ready));return ready};
 const panel=workspacePanel({document:d,api,currentSession:()=> '1'});try{await panel.configure({workspaceEnabled:true,workspaceRepository:'owner/project'});delay=true;const loading=panel.refresh();await new Promise(r=>setTimeout(r,0));await (d.getElementById('workspace-cancel') as any).onclick();assert.equal(d.getElementById('workspace-state')!.textContent,'Closed');release();await loading;assert.equal(d.getElementById('workspace-state')!.textContent,'Closed');assert.equal((d.getElementById('workspace-open') as HTMLButtonElement).disabled,false);}finally{dom.window.dispatchEvent(new dom.window.Event('pagehide'));dom.window.close()}
});

test('polling during slow export does not discard its saved download link',async()=>{
 const dom=new JSDOM(await readFile('public/index.html','utf8'),{url:'https://chat.example.test'}),d=dom.window.document;const id='a'.repeat(36),ready={id,phase:'ready',runs:{},gaps:[]};let poll:any,release:any;dom.window.setInterval=((fn:any)=>{poll=fn;return 1}) as any;
 const api=async(path:string,body:any)=>{if(body?.action==='export')return new Promise(resolve=>release=()=>resolve({url:'/saved-artifact'}));if(path==='/api/workspaces?session=1')return {workspaceId:id};return ready};
 const panel=workspacePanel({document:d,api,currentSession:()=> '1'});try{await panel.configure({workspaceEnabled:true,workspaceRepository:'owner/project'});const exporting=(d.getElementById('workspace-export') as any).onclick();await new Promise(r=>setTimeout(r,0));poll();await new Promise(r=>setTimeout(r,0));release();await exporting;assert.equal(d.getElementById('workspace-artifact')!.hidden,false);assert.equal(d.getElementById('workspace-artifact')!.getAttribute('href'),'/saved-artifact');}finally{dom.window.dispatchEvent(new dom.window.Event('pagehide'));dom.window.close()}
});

test('Export waits for dispatching and running commands, then becomes available after completion',async()=>{
 const dom=new JSDOM(await readFile('public/index.html','utf8'),{url:'https://chat.example.test'}),d=dom.window.document;
 let state:any={id:'a'.repeat(36),phase:'ready',active:'run',runs:{run:{state:'dispatching',deadline:100}},gaps:[]},exports=0;
 const panel=workspacePanel({document:d,currentSession:()=> '1',api:async(path:string,body:any)=>{if(body?.action==='export'){exports++;return {url:'/saved-artifact'}}return path==='/api/workspaces?session=1'?{workspaceId:state.id}:state;}});
 try{await panel.configure({workspaceEnabled:true});const button=d.getElementById('workspace-export') as HTMLButtonElement;
  for(const runState of ['dispatching','running']){state.runs.run.state=runState;await panel.refresh();assert.equal(button.disabled,true);assert.match(button.title,/Wait for the command/);assert.match(d.getElementById('workspace-warning')!.textContent!,/Wait for the command/);button.click();assert.equal(exports,0);}
  state={...state,active:undefined,runs:{run:{state:'done',exitCode:0}}};await panel.refresh();assert.equal(button.disabled,false);assert.doesNotMatch(d.getElementById('workspace-warning')!.textContent!,/Wait for the command/);assert.doesNotMatch(button.title,/Wait for the command/);
  await (button as any).onclick();assert.equal(exports,1);assert.equal(d.getElementById('workspace-artifact')!.getAttribute('href'),'/saved-artifact');
 }finally{dom.window.dispatchEvent(new dom.window.Event('pagehide'));dom.window.close();}
});

test('stale panel export rejection retains its ID across refresh and succeeds against the controller after the command exits',async()=>{
 const dom=new JSDOM(await readFile('public/index.html','utf8'),{url:'https://chat.example.test'}),d=dom.window.document,id='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',data=new Map<string,any>();let exited=false,captures=0;const exports:any[]=[];
 const adapter:WorkspaceAdapter={open:async()=> 'a'.repeat(40),read:async()=>'',edit:async()=>{},dispatch:async()=>{},status:async()=>({state:exited?'exited':'running',exitCode:exited?0:undefined}),logs:async()=> 'test output',terminate:async()=>{},collect:async()=>{captures++;return {base:'a'.repeat(40),patch:'saved patch',logs:{test:'test output'},gaps:[]}},stop:async()=>{},keepAlive:async()=>{}};
 const controller=new WorkspaceController({get:async<T>(key:string)=>structuredClone(data.get(key)) as T|undefined,put:async(key,value)=>{data.set(key,structuredClone(value))},setAlarm:async()=>{},deleteAlarm:async()=>{}},adapter,DEFAULT_WORKSPACE_LIMITS,()=>0);
 await controller.open(id,'1','owner/project');
 const panel=workspacePanel({document:d,currentSession:()=> '1',api:async(path:string,body:any)=>{if(path==='/api/workspaces?session=1')return {workspaceId:id};if(body?.action==='export')exports.push({...body});return controller.request({workspaceId:id,...(body??{action:'status',operationId:'f'.repeat(64)})});}});
 try{await panel.configure({workspaceEnabled:true});const button=d.getElementById('workspace-export') as HTMLButtonElement;assert.equal(button.disabled,false);
  await controller.request({workspaceId:id,action:'exec',argv:['npm','test'],operationId:'1'.repeat(64)});
  await (button as any).onclick();assert.match(d.getElementById('workspace-warning')!.textContent!,/Wait for the command before exporting/);assert.equal(exports.length,1);assert.equal(captures,0);
  await panel.refresh();assert.equal(button.disabled,true);exited=true;await panel.refresh();assert.equal(button.disabled,false);
  await (button as any).onclick();assert.equal(exports.length,2);assert.equal(exports[0].operationId,exports[1].operationId);assert.equal(captures,1);assert.equal(d.getElementById('workspace-artifact')!.hidden,false);assert.match(d.getElementById('workspace-artifact')!.getAttribute('href')!,new RegExp('export='+exports[0].operationId));
 }finally{dom.window.dispatchEvent(new dom.window.Event('pagehide'));dom.window.close();}
});

test('cached page restoration resumes one workspace polling timer and refreshes immediately',async()=>{
 const dom=new JSDOM(await readFile('public/index.html','utf8'),{url:'https://chat.example.test'});const w=dom.window;const timers=new Map<number,()=>void>();let next=0,reads=0;
 w.setInterval=((fn:()=>void)=>{timers.set(++next,fn);return next;}) as any;w.clearInterval=((id:number)=>timers.delete(id)) as any;
 const panel=workspacePanel({document:w.document,api:async()=>{reads++;return {};},currentSession:()=> '1'});
 try{await panel.configure({workspaceEnabled:true});assert.equal(timers.size,1);w.dispatchEvent(new w.PageTransitionEvent('pagehide',{persisted:true}));assert.equal(timers.size,0);const before=reads;w.dispatchEvent(new w.PageTransitionEvent('pageshow',{persisted:true}));await new Promise(r=>setTimeout(r,0));assert.equal(timers.size,1);assert.ok(reads>before);w.dispatchEvent(new w.PageTransitionEvent('pageshow',{persisted:true}));assert.equal(timers.size,1);}finally{w.dispatchEvent(new w.Event('pagehide'));dom.window.close();}
});

test('workspace stop and deadline controls name their scope and only extend an active command',async()=>{
 const dom=new JSDOM(await readFile('public/index.html','utf8'),{url:'https://chat.example.test'}),d=dom.window.document;
 let state:any={id:'a'.repeat(36),phase:'ready',active:'run',deadline:Date.UTC(2026,9,20,18),runs:{run:{state:'running',deadline:Date.UTC(2026,9,20,17,30)}},gaps:[]};
 const calls:any[]=[];const panel=workspacePanel({document:d,currentSession:()=> '1',api:async(path:string,body:any)=>{calls.push({path,body});return path==='/api/workspaces?session=1'?{workspaceId:state.id}:state;}});
 try{
  await panel.configure({workspaceEnabled:true,workspaceRepository:'owner/project'});
  assert.match(d.getElementById('workspace-cancel')!.textContent!,/Stop workspace/);assert.match(d.getElementById('workspace-cancel')!.title,/active command/);
  assert.match(d.getElementById('workspace-deadline')!.textContent!,/^Workspace stops at/);assert.match(d.getElementById('workspace-run')!.textContent!,/^Command running · stops at/);
  assert.notEqual(d.getElementById('workspace-deadline')!.textContent!.split('at ')[1],d.getElementById('workspace-run')!.textContent!.split('at ')[1]);
  assert.match(d.getElementById('workspace-extend-task')!.textContent!,/Workspace \+30 min/);assert.match(d.getElementById('workspace-extend-task')!.title,/command deadline is unchanged/);
  assert.equal((d.getElementById('workspace-extend-command') as HTMLButtonElement).disabled,false);await (d.getElementById('workspace-extend-command') as any).onclick();assert.deepEqual(calls.at(-1).body,{target:'command',minutes:30});
  state={...state,active:undefined,runs:{run:{state:'done',exitCode:0}}};await panel.refresh();assert.equal((d.getElementById('workspace-extend-command') as HTMLButtonElement).disabled,true);assert.match(d.getElementById('workspace-extend-command')!.title,/No active command/);
 }finally{dom.window.dispatchEvent(new dom.window.Event('pagehide'));dom.window.close();}
});

test('durable activation block overrides a stale ready phase and refresh/reload agree with new work',async()=>{
 const html=await readFile('public/index.html','utf8');let state:any={id:'a'.repeat(36),phase:'ready',runs:{},gaps:[],activation:{mode:'owner_open'}};
 for(let reload=0;reload<2;reload++){
  const dom=new JSDOM(html,{url:'https://chat.example.test'}),d=dom.window.document;
  const panel=workspacePanel({document:d,currentSession:()=> '1',api:async(path:string)=>path==='/api/workspaces?session=1'?{workspaceId:state.id}:state});
  try{await panel.configure({workspaceEnabled:true});assert.equal(d.getElementById('workspace-state')!.textContent,'Stopped');assert.match(d.getElementById('workspace-warning')!.textContent!,/Send a new project-work request/);assert.equal((d.getElementById('workspace-extend-task') as HTMLButtonElement).disabled,true);
   state={...state,phase:'closed',activation:{mode:'automatic'}};await panel.refresh();assert.equal(d.getElementById('workspace-state')!.textContent,'Closed');assert.match(d.getElementById('workspace-warning')!.textContent!,/automatically.*Old edits are not restored/);
   state={...state,phase:'ready',activation:{mode:'ready'}};await panel.refresh();assert.equal(d.getElementById('workspace-state')!.textContent,'Ready');assert.equal(d.getElementById('workspace-warning')!.textContent,'');
  }finally{dom.window.dispatchEvent(new dom.window.Event('pagehide'));dom.window.close();state={...state,activation:{mode:'owner_open'}};}
 }
});
