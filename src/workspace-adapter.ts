import {DEFAULT_WORKSPACE_LIMITS,projectPath,type WorkspaceAdapter,type WorkspaceExport} from './workspace';
const ROOT='/workspace/project',PROCESSES='/var/lib/pi-processes';
// Request-independent supervisor; only captured logs are bounded, never command files.
export const PROCESS_RUN=`import os,sys,subprocess,selectors,signal
from pathlib import Path
directory=Path(sys.argv[1]); limit=16384
for name in ('stdout','stderr'): (directory/(name+'.log')).write_bytes(b'')
def record_exit(code):
 (directory/'exit-code.tmp').write_text(str(code)); os.replace(directory/'exit-code.tmp',directory/'exit-code')
try:process=subprocess.Popen(sys.argv[2:],stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
except OSError as error:
 (directory/'stderr.log').write_bytes(str(error).encode()[-limit:])
 record_exit(127 if isinstance(error,FileNotFoundError) else 126); sys.exit(0)
try:
 (directory/'pid').write_text(str(process.pid)+' '+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+'\\n')
 selector=selectors.DefaultSelector(); tails={}
 for name,stream in (('stdout',process.stdout),('stderr',process.stderr)):
  selector.register(stream,selectors.EVENT_READ,name); tails[name]=b''
 while selector.get_map():
  for key,_ in selector.select():
   chunk=os.read(key.fd,65536)
   if not chunk:
    selector.unregister(key.fileobj); key.fileobj.close(); continue
   name=key.data; tails[name]=(tails[name]+chunk)[-limit:]
   temporary=directory/(name+'.log.tmp'); temporary.write_bytes(tails[name]); os.replace(temporary,directory/(name+'.log'))
 selector.close()
 code=process.wait(); code=code if code>=0 else 128-code
 record_exit(code)
finally:
 if process.poll() is None:
  os.killpg(process.pid,signal.SIGKILL); process.wait()
`;
const CURRENT=`current() { read -r pid boot 2>/dev/null <"$1/pid" && [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ]; }`;
export const PROCESS_STATUS=`${CURRENT}
dir=$1
if [ ! -d "$dir" ]; then echo lost
elif [ -e "$dir/exit-code" ]; then echo "exited $(cat "$dir/exit-code")"
elif [ ! -e "$dir/pid" ]; then echo starting
elif current "$dir" && kill -0 "$pid" 2>/dev/null; then echo running
else echo lost; fi`;
// Simple relative-path and resolved-path check; no hostile-repository policy layer.
export const FILE_OPERATION=`import os,sys,json,stat,tempfile
root='/workspace/project'; action,path=sys.argv[1:3]; target=os.path.realpath(os.path.join(root,path))
if os.path.commonpath([root,target])!=root: raise Exception('Path outside project')
if action=='read':
 if os.path.getsize(target)>64000: raise Exception('File too large')
 with open(target,encoding='utf8') as f: print(f.read(),end='')
else:
 payload=json.load(sys.stdin); old,new=payload['oldText'],payload['newText']
 if len(new.encode())>64000: raise Exception('Edit too large')
 if old=='':
  with open(target,'x',encoding='utf8') as f:f.write(new)
 else:
  if os.path.getsize(target)>64000:raise Exception('File too large')
  with open(target,encoding='utf8') as f:text=f.read()
  if text.count(old)!=1:raise Exception('Expected one exact match')
  mode=stat.S_IMODE(os.stat(target).st_mode)
  fd,temporary=tempfile.mkstemp(prefix='.pi-edit-',dir=os.path.dirname(target))
  try:
   with os.fdopen(fd,'w',encoding='utf8') as f:
    f.write(text.replace(old,new,1)); f.flush(); os.fchmod(f.fileno(),mode)
   os.replace(temporary,target)
  finally:
   if os.path.exists(temporary):os.unlink(temporary)
`;
export class ContainerWorkspaceAdapter implements WorkspaceAdapter {
 constructor(private container:Container,private image:string){}
 private async run(argv:string[],signal:AbortSignal,cwd=ROOT,input?:string,cap=512000){
  if(!this.container.running)throw Error('Container lost');
  const p=await this.container.exec(argv,{cwd,signal,...(input===undefined?{}:{stdin:'pipe'})});
  if(input!==undefined){const w=p.stdin!.getWriter();await w.write(new TextEncoder().encode(input));await w.close();}
  const take=async(stream:ReadableStream|null)=>{if(!stream)return '';const reader=stream.getReader();const chunks:Uint8Array[]=[];let count=0;try{while(true){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>cap){p.kill();throw Error('Workspace output limit reached')}chunks.push(value)}}finally{reader.releaseLock()}const bytes=new Uint8Array(count);let at=0;for(const part of chunks){bytes.set(part,at);at+=part.length}return new TextDecoder().decode(bytes)};
  const [stdout,,exitCode]=await Promise.all([take(p.stdout),take(p.stderr),p.exitCode]);if(exitCode!==0)throw Error('Workspace command failed');return stdout;
 }
 async open(repo:string,signal:AbortSignal){
  if(this.container.running)throw Error('Refusing to reuse an unknown running guest');
  this.container.start({image:this.image,entrypoint:['sleep','infinity'],enableInternet:true,env:{GIT_TERMINAL_PROMPT:'0'},instance:'standard-1'});
  await this.container.setInactivityTimeout(DEFAULT_WORKSPACE_LIMITS.idleMs);
  await this.run(['mkdir','-p','/workspace',PROCESSES],signal,'/');
  await this.run(['git','clone','--','https://github.com/'+repo+'.git',ROOT],signal,'/workspace');
  const base=(await this.run(['git','rev-parse','HEAD'],signal)).trim();if(!/^[a-f0-9]{40}$/.test(base))throw Error('Invalid base');return base;
 }
 async read(path:string,signal:AbortSignal){return this.run(['python3','-c',FILE_OPERATION,'read',projectPath(path)],signal,ROOT,undefined,64000)}
 async edit(path:string,oldText:string,newText:string,signal:AbortSignal){if(oldText.length>64000||newText.length>64000)throw Error('Edit too large');await this.run(['python3','-c',FILE_OPERATION,'edit',projectPath(path)],signal,ROOT,JSON.stringify({oldText,newText}));}
 async dispatch(id:string,argv:string[],cwd:string,signal:AbortSignal){
  const dir=PROCESSES+'/'+id;await this.run(['mkdir',dir],signal);
  // Refuse paths that resolve outside the cloned tree, including symlinks.
  const resolved=(await this.run(['realpath','-e',ROOT+'/'+projectPath(cwd)],signal)).trim();if(resolved!==ROOT&&!resolved.startsWith(ROOT+'/'))throw Error('Command cwd outside project');
  const p=await this.container.exec(['python3','-c',PROCESS_RUN,dir,...argv],{cwd:resolved,signal,stdout:'ignore',stderr:'ignore'});
  // Do not await this request-owned handle. Later requests use persisted guest files.
  void p.exitCode.catch(()=>{});
 }
 async status(id:string,signal:AbortSignal):ReturnType<WorkspaceAdapter['status']>{if(!this.container.running)return {state:'lost' as const};const text=(await this.run(['sh','-c',PROCESS_STATUS,'sh',PROCESSES+'/'+id],signal)).trim();const [state,code]=text.split(' ');if(state==='exited'){const exitCode=Number(code);return Number.isInteger(exitCode)&&exitCode>=0&&exitCode<=255?{state,exitCode}:{state:'lost'};}if(state==='running'||state==='starting')return {state};return {state:'lost' as const}}
 async logs(id:string,stream:'stdout'|'stderr',signal:AbortSignal){return this.run(['tail','-c','16384',PROCESSES+'/'+id+'/'+stream+'.log'],signal,ROOT,undefined,16384)}
 async terminate(id:string,signal:AbortSignal){await this.run(['sh','-c',`${CURRENT}\ncurrent "$1" && kill -s TERM -- "-$pid"`,'sh',PROCESSES+'/'+id],signal)}
 async collect(base:string,ids:string[],signal:AbortSignal):Promise<WorkspaceExport>{
  if(!/^[a-f0-9]{40}$/.test(base))throw Error('Invalid base');
  // Dedicated temporary index includes new/untracked files without changing the real index.
  const patch=await this.run(['sh','-c','export GIT_INDEX_FILE=/tmp/pi-export-index; rm -f "$GIT_INDEX_FILE"; git read-tree "$1" && git add -A && git diff --cached --binary "$1"; rc=$?; rm -f "$GIT_INDEX_FILE"; exit "$rc"','sh',base],signal);
  const logs:Record<string,string>={},gaps:string[]=[];for(const id of ids)for(const stream of ['stdout','stderr'] as const)try{logs[id+'/'+stream]=await this.logs(id,stream,signal)}catch{gaps.push('Log unavailable: '+id+'/'+stream)}
  if(ids.length)gaps.push('Logs contain only the last 16 KiB of each stream.');return {base,patch,logs,gaps};
 }
 async stop(){try{if(this.container.running)this.container.signal(9)}finally{await this.container.destroy()}}
 async keepAlive(idleMs:number){if(!this.container.running)throw Error('Container lost');await this.container.setInactivityTimeout(idleMs)}
}
