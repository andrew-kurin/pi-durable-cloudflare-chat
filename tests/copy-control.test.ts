import {test} from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';
import {copyControl,toolClipboardText} from '../public/copy-control.js';import {toolActivity} from '../public/tool-activity.js';
const tick=()=>new Promise(r=>setTimeout(r,0));
test('copy uses exact canonical text, coalesces pending clicks, survives rerender and reports streaming versions honestly',async()=>{
 const dom=new JSDOM('<main></main>'),d=dom.window.document,w=dom.window;let release!:()=>void;const writes:string[]=[];
 Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async(text:string)=>{writes.push(text);await new Promise<void>(r=>release=r);}}});
 const text='## Result\n\n```js\nconst n = 1;\n```\n';let node=copyControl(d,'response',text,'Copy assistant response');d.body.append(node);const b=node.querySelector('button')!;b.focus();b.click();b.click();assert.deepEqual(writes,[text]);assert.equal(b.getAttribute('aria-disabled'),'true');assert.equal(d.activeElement,b);
 node=copyControl(d,'response',text+'More','Copy response so far');d.body.replaceChildren(node);release();await tick();assert.equal(node.querySelector('[role=status]')!.textContent,'Copied earlier version');assert.equal(node.querySelector('button')!.getAttribute('aria-busy'),'false');
 node.querySelector('button')!.click();assert.equal(writes[1],text+'More');release();await tick();assert.equal(node.querySelector('[role=status]')!.textContent,'Copied');dom.window.close();
});
test('clipboard rejection and missing API give actionable failure without selecting text or claiming success',async()=>{
 const dom=new JSDOM('<p>Existing selection</p>'),d=dom.window.document;const range=d.createRange();range.selectNodeContents(d.querySelector('p')!);d.getSelection()!.addRange(range);
 const missing=copyControl(d,'missing','text','Copy assistant response');d.body.append(missing);missing.querySelector('button')!.click();assert.match(missing.textContent!,/Clipboard unavailable/);assert.equal(d.getSelection()!.toString(),'Existing selection');
 Object.defineProperty(dom.window.navigator,'clipboard',{value:{writeText:async()=>{throw Error('denied');}}});const rejected=copyControl(d,'rejected','text','Copy assistant response');d.body.append(rejected);rejected.querySelector('button')!.click();await tick();assert.match(rejected.textContent!,/Couldn’t copy/);assert.equal(rejected.dataset.copyState,'error');assert.equal(d.getSelection()!.toString(),'Existing selection');dom.window.close();
});
test('tool debugging copies full available evidence, not compact previews, and never toggles disclosure',async()=>{
 const dom=new JSDOM(),d=dom.window.document;const writes:string[]=[];Object.defineProperty(dom.window.navigator,'clipboard',{value:{writeText:async(text:string)=>{writes.push(text);}}});
 const id='0123456789abcdef'.repeat(4),tool={id:'call',name:'workspace_exec',label:'Start command',state:'error',context:id,input:'x'.repeat(5000),output:'y'.repeat(13000),detail:'Failed. useful diagnostic',outputTruncated:true};
 let toggles=0;d.body.append(toolActivity(d,[tool],new Set(['call']),()=>toggles++));const row=d.querySelector('details')!;await tick();toggles=0;row.querySelector('button')!.click();await tick();assert.equal(row.open,true);assert.equal(toggles,0);assert.equal(writes[0],toolClipboardText(tool));assert.ok(writes[0].includes(id));assert.ok(writes[0].includes(tool.input));assert.ok(writes[0].includes(tool.output));assert.match(writes[0],/Result was truncated in recorded history/);assert.match(writes[0],/workspace_exec/);assert.equal(d.querySelector('.tool-input')!.textContent!.length,4000);dom.window.close();
});
