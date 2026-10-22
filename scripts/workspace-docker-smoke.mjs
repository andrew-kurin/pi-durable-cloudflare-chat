// Local Docker smoke runner. No registry upload, Cloudflare calls, model, host mounts or guest network.
// Run after the owner independently makes Docker available:
// node --import tsx scripts/workspace-docker-smoke.mjs
import {spawn,execFileSync} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContainerWorkspaceAdapter} from '../src/workspace-adapter.ts';
const image='pi-workspace-smoke:local',name='pi-smoke-'+randomUUID();
let dockerOptions=[];
let dockerEnv=process.env;
const cli=(args,options={})=>execFileSync('docker',[...dockerOptions,...args],{encoding:'utf8',timeout:120000,env:dockerEnv,...options});
if(process.argv.includes('--help')){console.log('With local Docker already running: node --import tsx scripts/workspace-docker-smoke.mjs\nRejects remote Docker endpoints, builds the local Dockerfile, runs an isolated synthetic project with no guest network/host mounts, and removes the guest in finally. No upload or deployment.');process.exit(0)}
let endpoint;
try{endpoint=process.env.DOCKER_CONTEXT?cli(['context','inspect',process.env.DOCKER_CONTEXT,'--format','{{.Endpoints.docker.Host}}']).trim():process.env.DOCKER_HOST||cli(['context','inspect','--format','{{.Endpoints.docker.Host}}']).trim();}catch{console.error('BLOCKED: local Docker endpoint could not be inspected.');process.exit(2)}
if(!/^(unix|npipe):\/\//.test(endpoint)){console.error('BLOCKED: smoke runner requires a local Unix/npipe Docker endpoint; remote TCP/SSH contexts are not authorized.');process.exit(2)}
dockerOptions=['--host',endpoint];
dockerEnv={...process.env};delete dockerEnv.DOCKER_CONTEXT;delete dockerEnv.DOCKER_HOST;
try{cli(['version','--format','{{.Server.Version}}'])}catch{console.error('BLOCKED: installed Docker cannot reach its daemon. Start/authorize Docker separately; this script does not start software or change permissions.');process.exit(2)}
// Public base images need no stored account credentials or credential-helper prompt.
const buildConfig=mkdtempSync(join(tmpdir(),'pi-docker-anonymous-'));
try{cli(['build','--tag',image,'--file','workspace/Dockerfile','workspace'],{timeout:10*60000,stdio:'inherit',env:{...dockerEnv,DOCKER_CONFIG:buildConfig}})}finally{rmSync(buildConfig,{recursive:true,force:true})}
let running=false;const container={
 get running(){return running},images:{},
 start(){cli(['run','--detach','--name',name,'--network','none','--memory','512m','--cpus','1',image]);running=true},
 setInactivityTimeout:async()=>{}, // Docker has no DO inactivity timer; controller timing is tested offline separately.
 async exec(argv,options={}){
  const args=['exec',...(options.stdout==='ignore'?['--detach']:['--interactive']),...(options.cwd?['--workdir',options.cwd]:[]),name,...argv];
  const child=spawn('docker',[...dockerOptions,...args],{stdio:['pipe','pipe','pipe'],signal:options.signal,env:dockerEnv});
  const exitCode=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(code??(signal?137:1)))});
  if(options.stdout==='ignore'){const code=await exitCode;if(code!==0)throw Error('Docker detached exec failed');return {stdin:null,stdout:null,stderr:null,exitCode:Promise.resolve(0),kill(){}}}
  return {stdin:Writable.toWeb(child.stdin),stdout:Readable.toWeb(child.stdout),stderr:Readable.toWeb(child.stderr),exitCode,kill(){child.kill('SIGKILL')}};
 },
 signal(){try{cli(['kill',name])}catch{}running=false},
 async destroy(){cli(['rm','--force',name]);running=false},
};
const adapter=new ContainerWorkspaceAdapter(container,image),signal=new AbortController().signal;
const wait=async(test)=>{const until=Date.now()+10000;while(Date.now()<until){if(await test())return;await new Promise(r=>setTimeout(r,100))}throw Error('Local process observation timed out')};
try{
 container.start();
 cli(['exec',name,'sh','-c',"mkdir -p /workspace/project /var/lib/pi-processes; cd /workspace/project; git init -q; printf 'old\\n' > README.md; git add README.md; git -c user.name=Synthetic -c user.email=fixture@example.test -c commit.gpgsign=false commit -qm base"]);
 const base=cli(['exec','--workdir','/workspace/project',name,'git','rev-parse','HEAD']).trim();
 assert.equal(await adapter.read('README.md',signal),'old\n');
 await adapter.edit('README.md','old','new',signal);await adapter.edit('created.txt','','created\n',signal);
 assert.equal(await adapter.read('README.md',signal),'new\n');
 const completed='a'.repeat(64);await adapter.dispatch(completed,['node','-e',"console.log('PASS local synthetic test'); console.error('stderr captured');"],'.',signal);
 await wait(async()=> (await adapter.status(completed,signal)).state==='exited');
 assert.equal((await adapter.status(completed,signal)).exitCode,0);assert.match((await adapter.logs(completed,'stdout',signal)).text,/PASS local/);assert.match((await adapter.logs(completed,'stderr',signal)).text,/stderr captured/);
 const artifact=await adapter.collect(base,[completed],signal);assert.equal(artifact.base,base);assert.match(artifact.patch,/README.md/);assert.match(artifact.patch,/created.txt/);assert.match(artifact.logs[completed+'/stdout'],/PASS local/);
 assert.equal(cli(['exec','--workdir','/workspace/project',name,'git','diff','--cached']).trim(),'','Export must preserve the real Git index');
 const cancelled='b'.repeat(64);await adapter.dispatch(cancelled,['sh','-c','sleep 120 & wait'],'.',signal);
 await wait(async()=> (await adapter.status(cancelled,signal)).state==='running');await adapter.terminate(cancelled,signal);
 await wait(async()=> (await adapter.status(cancelled,signal)).state!=='running');
 cli(['exec',name,'python3','-c',"import glob\nfor p in glob.glob('/proc/[0-9]*/cmdline'):\n try:\n  with open(p,'rb') as f: assert f.read()!=b'sleep\\x00120\\x00', 'Cancellation must stop the child process too'\n except FileNotFoundError: pass"]);
 await adapter.stop();assert.equal(running,false);
 const containers=cli(['ps','--all','--filter','name=^/'+name+'$','--format','{{.Names}}']).trim();assert.equal(containers,'');
 console.log('PASS real local Docker: image build, file/edit, serial process status/logs, base-relative new-file patch, process-group cancel and guest cleanup. Cloudflare APIs/lifecycle remain untested.');
}finally{try{cli(['rm','--force',name],{stdio:'ignore'})}catch{}running=false}
