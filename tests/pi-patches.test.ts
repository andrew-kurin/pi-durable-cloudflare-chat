import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

for(const [script,pkg,files] of [
 ['patch-pi-retry.mjs','pi-ai',['dist/utils/retry.js']],
 ['patch-pi-runner-identity.mjs','pi-durable',['dist/harness/generation.js','dist/harness/compaction.js']]
] as const)test(`${script} is idempotent and rejects unreviewed versions and changed boundaries`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi55-patches-'));const root=join(dir,'node_modules/@earendil-works',pkg);
 try{
  await mkdir(join(dir,'scripts'),{recursive:true});await cp('scripts/'+script,join(dir,'scripts',script));
  await mkdir(root,{recursive:true});await cp(`node_modules/@earendil-works/${pkg}/package.json`,join(root,'package.json'));
  for(const file of files){await mkdir(join(root,file,'..'),{recursive:true});await cp(`node_modules/@earendil-works/${pkg}/${file}`,join(root,file));}
  const before=await Promise.all(files.map(file=>readFile(join(root,file),'utf8'))),run=()=>execFileSync(process.execPath,[join(dir,'scripts',script)],{encoding:'utf8',stdio:'pipe'});
  assert.match(run(),/already applied/);assert.match(run(),/already applied/);
  assert.deepEqual(await Promise.all(files.map(file=>readFile(join(root,file),'utf8'))),before);
  const metadata=JSON.parse(await readFile(join(root,'package.json'),'utf8'));await writeFile(join(root,'package.json'),JSON.stringify({...metadata,version:'1.3.1'}));assert.throws(run,/Review/);
  await writeFile(join(root,'package.json'),JSON.stringify(metadata));
  for(let i=0;i<files.length;i++){
   const changed=before[i].replaceAll('const options = {','const options = /* changed upstream */ {').replaceAll('export function isRetryableAssistantError(message) {','export function isRetryableAssistantError(message) { /* changed upstream */');
   await writeFile(join(root,files[i]),changed);assert.throws(run,/Unexpected Pi/);assert.equal(await readFile(join(root,files[i]),'utf8'),changed);await writeFile(join(root,files[i]),before[i]);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
