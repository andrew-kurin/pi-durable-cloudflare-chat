import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {resultSummary,toolLabel} from '../src/tool-activity';
import {toolActivity} from '../public/tool-activity.js';
const result=(name:string,data:unknown)=>resultSummary({model:[{role:'toolResult',toolCallId:'x',toolName:name,isError:false,content:[{type:'text',text:JSON.stringify({data})}]}]} as any,name)!;
test('successful status checks distinguish running, exited, missing and ambiguous commands from invocation completion',()=>{
 for(const [process,expected] of [
  [{state:'running'},/Command running/],
  [{state:'dispatching'},/Command accepted; starting/],
  [{state:'done',exitCode:0},/Command completed \(exit 0\)/],
  [{state:'done',exitCode:23},/Command exited with code 23/],
  [{state:'done'},/exit code unavailable/],
  [{state:'interrupted'},/completion unconfirmed/],
  [{state:'not_found'},/Requested command not found/],
  [{state:'none'},/No active command/],
 ] as const){
  const value=result('workspace_status',{phase:'ready',process,activation:{mode:'automatic'}});
  assert.equal(value.state,'success');assert.match(value.summary!,expected);
  const dom=new JSDOM();dom.window.document.body.append(toolActivity(dom.window.document,[{id:'x',label:toolLabel('workspace_status'),...value}],new Set(),()=>{}));
  assert.equal(dom.window.document.querySelector('.tool-state')!.textContent,'Status checked');dom.window.close();
 }
 const active=result('workspace_status',{phase:'ready',process:{state:'none'},active:'run',runs:{run:{state:'running'}}});assert.match(active.summary!,/Command running/);assert.doesNotMatch(active.summary!,/No active/);
 const missing=result('workspace_status',{phase:'ready',process:{state:'not_found'},active:'other',runs:{other:{state:'running'}}});assert.match(missing.summary!,/Requested command not found/);
});
test('command dispatch acceptance never claims completion and wait reflects actual terminal outcome',()=>{
 const exec=result('workspace_exec',{phase:'ready',active:'run',runs:{run:{state:'running'}}});assert.match(exec.summary!,/Command running/);
 const ambiguous=result('workspace_exec',{phase:'stopping',active:'run',runs:{run:{state:'interrupted'}}});assert.match(ambiguous.summary!,/completion unconfirmed/);
 const dom=new JSDOM();dom.window.document.body.append(toolActivity(dom.window.document,[{id:'x',label:'Start command',...exec}],new Set(),()=>{}));assert.equal(dom.window.document.querySelector('.tool-state')!.textContent,'Request accepted');dom.window.close();
 assert.match(result('workspace_wait',{outcome:'completed'}).summary!,/Command completed/);assert.match(result('workspace_wait',{outcome:'failed'}).summary!,/Command failed/);assert.match(result('workspace_wait',{outcome:'still_running'}).summary!,/still running/);
});
test('expanded details omit duplicate prose and absent-output noise but preserve technical evidence',()=>{
 const dom=new JSDOM(),d=dom.window.document;
 d.body.append(toolActivity(d,[
  {id:'legacy',label:'Process status',state:'success',summary:'Command running.',detail:'Command running.'},
  {id:'evidence',label:'Start command',state:'error',summary:'Command failed.',detail:'Failed. Duration: 1.2s.',input:'npm ci --prefix /workspace/project',output:'EFBIG: /workspace/project/node_modules/large.bin\nexit 23'},
  {id:'empty',label:'Read file',state:'success',summary:'Empty file.',detail:'Completed.',output:''},
 ],new Set(['legacy','evidence','empty']),()=>{}));
 const rows=d.querySelectorAll('.tool-row');assert.equal(rows[0].querySelector('.tool-evidence')!.textContent,'');assert.equal(rows[2].querySelector('.tool-evidence')!.textContent,'');
 assert.match(rows[1].querySelector('.tool-input')!.textContent!,/npm ci --prefix \/workspace\/project/);assert.match(rows[1].querySelector('.tool-output')!.textContent!,/EFBIG.*node_modules\/large.bin\nexit 23/);assert.equal(rows[1].querySelector('.tool-detail')!.textContent,'Duration: 1.2s.');
 assert.match(result('workspace_read',{text:''}).summary!,/Empty file/);dom.window.close();
});
