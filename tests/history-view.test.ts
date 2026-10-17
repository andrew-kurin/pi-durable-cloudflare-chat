import {test} from 'node:test';import assert from 'node:assert/strict';
import {historyPresentation} from '../public/history-view.js';
import {ChatProjection} from '../src/projector';
const legacy='Sol could not finish this response. Saved tool results remain available; check workspace status before retrying commands. Diagnostic hint: rate or usage limit. Reported HTTP 429.';
test('old saved transcript projects structured failure state and safe diagnostics on reload',()=>{
 const p=new ChatProjection();p.apply({type:'snapshot',entries:[{id:'old',kind:'pi.assistant',model:[{role:'assistant',content:[],stopReason:'error',errorMessage:'429: private raw token'}]}],tools:[],inbox:[],agent:{},usage:{},compactions:[]} as never);
 const result=historyPresentation(p.view());assert.deepEqual(result.failureState,{kind:'model',recoveryAction:'check-status'});assert.equal(result.messages[0].failure.diagnostic.httpStatus,'429');assert.equal(result.activity,'');assert.ok(!JSON.stringify(result).includes('private raw token'));
});
test('modern failure signals and actions survive arbitrary presentation-copy changes',()=>{
 const failure={kind:'model',diagnostic:{category:'tool response protocol'},recoveryAction:'check-status'};
 const result=historyPresentation({failureState:{kind:'model'},activity:'Changed copy',messages:[{role:'assistant',text:'Entirely different wording',failure}]});assert.equal(result.messages[0].failure,failure);assert.equal(result.activity,'');
});
test('modern normal prose and activity never become failure controls by matching legacy wording',()=>{
 const result=historyPresentation({failureState:null,messages:[{role:'assistant',text:legacy}],activity:legacy});assert.equal(result.messages[0].failure,undefined);assert.equal(result.activity,legacy);
});
test('legacy projected views retain message diagnostics and activity-only interruptions explicitly',()=>{
 const result=historyPresentation({messages:[{role:'assistant',text:legacy}],activity:legacy});assert.match(result.messages[0].failure.legacyHint,/Reported HTTP 429/);assert.equal(result.activity,'');assert.equal(historyPresentation({messages:[],activity:legacy}).activity,'Response interrupted · saved work retained.');
});
test('structured message failure takes precedence over legacy text and preserves evidence links/tools',()=>{
 const message={id:'saved',role:'assistant',text:legacy,failure:{kind:'model',diagnostic:{category:'structured'},recoveryAction:'check-status'},tools:[{id:'command',label:'Workspace status'}]};const result=historyPresentation({messages:[message],activity:''});assert.equal(result.messages[0],message);assert.equal(result.messages[0].failure.diagnostic.category,'structured');assert.equal(result.messages[0].tools[0].id,'command');
});
