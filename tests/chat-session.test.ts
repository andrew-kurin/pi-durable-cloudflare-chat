import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createChatSession} from '../public/chat-session.js';
const deferred = () => { let resolve!: (value?: any) => void, reject!: (error: Error) => void; const promise = new Promise<any>((yes,no) => {resolve=yes;reject=no;});return {promise,resolve,reject}; };
const flush = () => new Promise<void>(r => setImmediate(r));
function fixture(options: any = {}) {
 let rows = [{id:'1',title:'First'},{id:'2',title:'Second'}], next = 3;
 const saved = new Map<string,string>([['pi:last-chat:v1','2']]), calls: any[] = [], changes: any[] = [];
 let transport: any;
 const platform = {crypto, get localStorage() { if(options.blocked)throw Error('blocked');return {
  getItem:(k:string)=>saved.get(k)??null,setItem:(k:string,v:string)=>saved.set(k,v),removeItem:(k:string)=>saved.delete(k),
 };}};
 const api = (path: string, body?: any): Promise<any> => {
  calls.push({path,body}); if(transport)return transport(path,body);
  if(path==='/api/sessions'&&!body)return Promise.resolve(rows.map(x=>({...x})));
  if(path==='/api/sessions'){const row={id:String(next++),title:'New'};rows.push(row);return Promise.resolve(row);}
  if(path.startsWith('/api/session-trash')) {const id=new URL(path,'https://example.test').searchParams.get('session');if(body.action==='delete')rows=rows.filter(x=>x.id!==id);else rows.push({id:id!,title:'Restored'});return Promise.resolve({});}
  return Promise.resolve({accepted:true});
 };
 const session=createChatSession({api,platform,requestedId:options.requestedId,onChange:(state:any,change:any)=>changes.push({state,change})});
 return {session,calls,saved,changes,setTransport:(fn:any)=>{transport=fn},setRows:(value:any)=>{rows=value}};
}
for(const [options,want] of [[{},'2'],[{requestedId:'1'},'1'],[{requestedId:'999'},'1'],[{blocked:true},'1']] as const)
 test('selection precedence/fallback '+JSON.stringify(options),async()=>{const f=fixture(options);await f.session.refresh();assert.equal(f.session.state().sessionId,want);});
test('empty catalog stays empty without creating a chat or submission',async()=>{
 const f=fixture();f.setRows([]);await f.session.refresh();await f.session.submit();assert.equal(f.session.state().sessionId,null);assert.equal(f.saved.has('pi:last-chat:v1'),false);assert.equal(f.calls.length,1);
});
test('drafts survive switching, snapshots cannot mutate controller state',async()=>{
 const f=fixture();await f.session.refresh();f.session.editDraft('second');f.session.select('1');f.session.editDraft('first');f.session.select('2');assert.equal(f.session.state().draft,'second');const state=f.session.state();state.chats[0].title='wrong';assert.notEqual(f.session.state().chats[0].title,'wrong');f.session.select('1');assert.equal(f.session.state().draft,'first');
});
test('duplicate submits share one operation; successful receipt clears only the original unedited draft across switches',async()=>{
 const f=fixture();await f.session.refresh();const post=deferred();f.setTransport(()=>post.promise);f.session.editDraft('second');const first=f.session.submit();assert.equal(f.session.submit(),first);assert.equal(f.session.state().submitting,true);f.session.select('1');f.session.editDraft('first');await f.session.submit();assert.equal(f.calls.filter(x=>x.path.includes('/submit')).length,1);post.resolve({});await first;assert.equal(f.session.state().draft,'first');f.session.select('2');assert.equal(f.session.state().draft,'');
});
test('receipt cannot clear a newer draft even after editing back to identical text or switching away and back',async()=>{
 for(const mode of ['edited','edited-back','switch-back']){
  const f=fixture();await f.session.refresh();const post=deferred();f.setTransport(()=>post.promise);f.session.editDraft('original');const work=f.session.submit();
  f.session.editDraft('newer');if(mode==='edited-back')f.session.editDraft('original');if(mode==='switch-back'){f.session.select('1');f.session.editDraft('other');f.session.select('2');}
  post.resolve({});await work;assert.equal(f.session.state().draft,mode==='edited-back'?'original':'newer');
 }
});
test('same failed text retains its operation ID across navigation; changed text gets a new ID',async()=>{
 const f=fixture();await f.session.refresh();f.setTransport(async()=>{throw Error('ambiguous transport');});f.session.editDraft('  hello  ');await assert.rejects(f.session.submit());f.session.select('1');f.session.select('2');await assert.rejects(f.session.submit());f.session.editDraft('new message');await assert.rejects(f.session.submit());const ops=f.calls.filter(x=>x.path.includes('/submit')).map(x=>x.body);assert.equal(ops[0].operationId,ops[1].operationId);assert.equal(ops[0].text,'hello');assert.notEqual(ops[1].operationId,ops[2].operationId);
});
test('an old catalog response cannot replace a newer refresh or selection',async()=>{
 const f=fixture();await f.session.refresh();const old=deferred(),fresh=deferred();let n=0;f.setTransport(()=>++n===1?old.promise:fresh.promise);const a=f.session.refresh(),b=f.session.refresh();fresh.resolve([{id:'1',title:'current'},{id:'2'}]);await b;f.session.select('1');f.session.editDraft('keep');old.resolve([{id:'2',title:'old'}]);await a;assert.equal(f.session.state().sessionId,'1');assert.equal(f.session.state().draft,'keep');assert.equal(f.session.state().chats.find(c=>c.id==='1')!.title,'current');
});
for(const operation of ['create','restore'])test('delayed '+operation+' cannot override later user selection/draft',async()=>{
 const f=fixture();await f.session.refresh();const action=deferred();f.setTransport((path:string,body:any)=>body?action.promise:Promise.resolve([{id:'1'},{id:'2'},{id:'3'}]));const work=operation==='create'?f.session.create():f.session.restore('3',true);await flush();f.session.select('1');f.session.editDraft('keep');action.resolve({id:'3'});await work;assert.equal(f.session.state().sessionId,'1');assert.equal(f.session.state().draft,'keep');
});
test('delete completion reconciles membership without overriding a later valid selection',async()=>{
 const f=fixture();await f.session.refresh();const action=deferred();f.setTransport((path:string,body:any)=>body?action.promise:Promise.resolve([{id:'1'}]));const work=f.session.trash('2');await flush();f.session.select('1');f.session.editDraft('keep');action.resolve({});const result=await work;assert.deepEqual(result,{id:'2',wasActive:false});assert.equal(f.session.state().sessionId,'1');assert.equal(f.session.state().draft,'keep');
});
test('create and restore select their new chat only when navigation has not changed',async()=>{
 const f=fixture();await f.session.refresh();await f.session.create();assert.equal(f.session.state().sessionId,'3');const removed=await f.session.trash('3');assert.equal(removed!.wasActive,true);await f.session.restore('3',true);assert.equal(f.session.state().sessionId,'3');
});
