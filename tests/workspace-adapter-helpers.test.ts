import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,realpath,stat,readdir,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {PROCESS_RUN,PROCESS_STATUS,FILE_OPERATION,ContainerWorkspaceAdapter} from '../src/workspace-adapter';
import {Readable} from 'node:stream';

async function fixture(run:(dir:string)=>Promise<void>){
 const temporary=await mkdtemp(join(tmpdir(),'pi-adapter-integration-'));
 try{await run(await realpath(temporary));}finally{await rm(temporary,{recursive:true,force:true});}
}
async function until(check:()=>Promise<boolean>){
 const deadline=Date.now()+10000;
 while(!await check()){if(Date.now()>deadline)throw Error('Helper did not finish');await new Promise(r=>setTimeout(r,20));}
}
async function exists(path:string){try{await stat(path);return true;}catch{return false;}}
async function supervise(dir:string,command:string|string[],run:(done:Promise<number|null>)=>Promise<void>){
 const boot=join(dir,'boot');await writeFile(boot,'fixture-boot');
 const helper=PROCESS_RUN.replace('/proc/sys/kernel/random/boot_id',boot);
 const child=spawn('python3',['-c',helper,dir,...(typeof command==='string'?['python3','-c',command]:command)],{cwd:dir,stdio:['ignore','ignore','pipe']});
 let errors='';child.stderr.on('data',chunk=>errors+=chunk);
 const done=new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
 let timer:ReturnType<typeof setTimeout>;
 const bounded=Promise.race([done,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Supervisor timed out')),10000);})]);
 try{await run(bounded);assert.equal(await bounded,0,errors);}
 finally{
  clearTimeout(timer!);
  try{const pid=Number((await readFile(join(dir,'pid'),'utf8')).split(' ')[0]);process.kill(-pid,'SIGKILL');}catch{}
  child.kill('SIGKILL');await done;
 }
}
function edit(dir:string,path:string,oldText:string,newText:string,script=FILE_OPERATION){
 execFileSync('python3',['-c',script.replace("root='/workspace/project'",'root='+JSON.stringify(dir)),'edit',path],{input:JSON.stringify({oldText,newText}),stdio:['pipe','pipe','pipe']});
}

test('real supervisor permits a quiet 40 MiB project file and records a nonzero command exit',async()=>fixture(async dir=>{
 await supervise(dir,`from pathlib import Path
import sys
with open('large.bin','wb') as f:
 for _ in range(40):f.write(b'x'*1048576)
sys.exit(23)`,async done=>{
  await done;
  assert.equal((await stat(join(dir,'large.bin'))).size,40*1048576);
  assert.equal(await readFile(join(dir,'exit-code'),'utf8'),'23');
 });
}));

test('real supervisor drains noisy stdout and stderr and retains only their last 16 KiB',async()=>fixture(async dir=>{
 await supervise(dir,`import os,time
from pathlib import Path
for _ in range(64):
 os.write(1,b'o'*65536);os.write(2,b'e'*65536)
os.write(1,b'OUT-END');os.write(2,b'ERR-END')
Path(${JSON.stringify(join('/PLACEHOLDER','ready'))}).touch()
while not Path(${JSON.stringify(join('/PLACEHOLDER','release'))}).exists():time.sleep(.01)`.replaceAll('/PLACEHOLDER',dir),async done=>{
  await until(()=>exists(join(dir,'ready')));
  await until(async()=> (await readFile(join(dir,'stdout.log'),'utf8')).endsWith('OUT-END')&&(await readFile(join(dir,'stderr.log'),'utf8')).endsWith('ERR-END'));
  for(const stream of ['stdout','stderr'])assert.equal((await stat(join(dir,stream+'.log'))).size,16384);
  await writeFile(join(dir,'release'),'');await done;
  assert.equal(await readFile(join(dir,'exit-code'),'utf8'),'0');
 });
}));

test('real supervisor preserves process-group cancellation and signal exit status',async()=>fixture(async dir=>{
 await supervise(dir,`import subprocess,signal,os,time
from pathlib import Path
child=subprocess.Popen(['python3','-c','import time;time.sleep(60)'])
def stop(signum,frame):
 child.wait(timeout=3)
 signal.signal(signal.SIGTERM,signal.SIG_DFL);os.kill(os.getpid(),signal.SIGTERM)
signal.signal(signal.SIGTERM,stop)
Path(${JSON.stringify('/PLACEHOLDER/ready')}).write_text(str(child.pid))
while True:time.sleep(.01)`.replaceAll('/PLACEHOLDER',dir),async done=>{
  await until(()=>exists(join(dir,'ready')));
  const pid=Number((await readFile(join(dir,'pid'),'utf8')).split(' ')[0]);
  const descendant=Number(await readFile(join(dir,'ready'),'utf8'));
  assert.equal(execFileSync('sh',['-c',PROCESS_STATUS.replaceAll('/proc/sys/kernel/random/boot_id',join(dir,'boot')),'sh',dir]).toString().trim(),'running');
  process.kill(-pid,'SIGTERM');await done;
  assert.equal(await readFile(join(dir,'exit-code'),'utf8'),'143');
  assert.throws(()=>process.kill(descendant,0));
 });
}));

test('real supervisor records failed executable launches instead of leaving them starting',async()=>fixture(async dir=>{
 for(const [argv,code] of [[['missing-pi-fixture-executable'],127],[[join(dir,'not-executable')],126]] as const){
  await writeFile(join(dir,'not-executable'),'no execute permission',{mode:0o600});
  await supervise(dir,[...argv],async done=>{
   await done;assert.equal(await readFile(join(dir,'exit-code'),'utf8'),String(code));
   assert.ok((await stat(join(dir,'stderr.log'))).size>0);
  });
 }
}));

test('atomic edits preserve 0755 and 0600, new-file exclusivity, and clean failed replacements',async()=>fixture(async dir=>{
 for(const [name,mode] of [['executable',0o755],['private',0o600]] as const){
  await writeFile(join(dir,name),'old');await chmod(join(dir,name),mode);
  edit(dir,name,'old','new');assert.equal((await stat(join(dir,name))).mode&0o7777,mode);assert.equal(await readFile(join(dir,name),'utf8'),'new');
 }
 edit(dir,'new-file','','new');assert.throws(()=>edit(dir,'new-file','','overwrite'));assert.equal(await readFile(join(dir,'new-file'),'utf8'),'new');
 const broken=FILE_OPERATION.replace('   os.replace(temporary,target)',"   raise OSError('injected replacement failure')");
 assert.throws(()=>edit(dir,'executable','new','failed',broken));assert.equal(await readFile(join(dir,'executable'),'utf8'),'new');
 assert.equal((await stat(join(dir,'executable'))).mode&0o7777,0o755);
 assert.ok(!(await readdir(dir)).some(name=>name.startsWith('.pi-edit-')));
}));

test('actual export keeps an edited executable executable in the patch',async()=>fixture(async dir=>{
 const git=(...args:string[])=>execFileSync('git',args,{cwd:dir}).toString().trim();
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','core.filemode','true');
 await writeFile(join(dir,'script.sh'),'#!/bin/sh\necho old\n');await chmod(join(dir,'script.sh'),0o755);
 git('add','script.sh');git('-c','commit.gpgsign=false','commit','-qm','fixture');const base=git('rev-parse','HEAD');
 edit(dir,'script.sh','old','new');
 const container={running:true,exec:async(argv:string[])=>{
  const args=argv.map(arg=>arg.replaceAll('/tmp/pi-export-index',join(dir,'.git','pi-export-index')));
  const child=spawn(args[0],args.slice(1),{cwd:dir,stdio:['ignore','pipe','pipe']});
  return {stdout:Readable.toWeb(child.stdout),stderr:Readable.toWeb(child.stderr),exitCode:new Promise(resolve=>child.on('exit',resolve)),kill:()=>child.kill()};
 }} as unknown as Container;
 const exported=await new ContainerWorkspaceAdapter(container,'fixture').collect(base,[],new AbortController().signal);
 assert.match(exported.patch,/index [a-f0-9]+\.\.[a-f0-9]+ 100755/);assert.doesNotMatch(exported.patch,/old mode|new mode/);assert.match(exported.patch,/\+echo new/);
}));
