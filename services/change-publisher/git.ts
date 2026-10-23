import {CandidateFailure} from './errors';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HARNESS_REPOSITORY,type PublicationInput} from '../../src/change-contract';
export interface FileChanges {additions:{path:string;contents:string}[];deletions:{path:string}[]}
/** Runs Git only, never repository scripts, hooks, package installs or tests.
 * The subprocess environment deliberately contains no publisher credentials. */
type GitRead=(args:string[],stdin?:string|Uint8Array)=>Promise<Buffer>;
export async function prepareCandidate(input:PublicationInput,loadBase?:(git:GitRead)=>Promise<string|void>):Promise<FileChanges>{
 const root=await mkdtemp(join(tmpdir(),'pi-change-')),repo=join(root,'repo');await mkdir(join(root,'home'),{mode:0o700});await mkdir(repo);
 const env={PATH:'/usr/bin:/bin:/usr/local/bin',HOME:join(root,'home'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_ALLOW_PROTOCOL:'https',GIT_TERMINAL_PROMPT:'0'};
 const git=(args:string[],stdin?:string|Uint8Array)=>new Promise<Buffer>((resolve,reject)=>{const child=execFile('git',args,{cwd:repo,env,encoding:'buffer',timeout:30000,maxBuffer:2000000},(error,stdout)=>error?reject(new CandidateFailure('git_validation_failed')):resolve(Buffer.from(stdout)));if(stdin!==undefined)child.stdin!.end(stdin);});
 try{
  await git(['init','--quiet']);await git(['remote','add','origin','https://github.com/'+HARNESS_REPOSITORY+'.git']);
  let loadedRef:string|void=undefined;if(loadBase)loadedRef=await loadBase(git);else await git(['fetch','--no-tags','--depth=1','origin',input.source.baseRevision]);
  if((await git(['rev-parse',loadedRef||'FETCH_HEAD'])).toString().trim()!==input.source.baseRevision)throw new CandidateFailure('source_base_mismatch');
  await git(['checkout','--detach','--quiet',input.source.baseRevision]);
  await git(['apply','--index','--binary','--whitespace=nowarn','-'],input.patch);
  if((await git(['write-tree'])).toString().trim()!==input.source.treeSha)throw new CandidateFailure('candidate_tree_mismatch');
  const names=(await git(['diff','--name-only','--no-renames','-z',input.source.baseRevision,input.source.treeSha])).toString('utf8').split('\0').filter(Boolean);
  if(!names.length||names.length>50)throw new CandidateFailure('candidate_too_large');
  const result:FileChanges={additions:[],deletions:[]};let contentBytes=0;
  for(const path of names){
   // First milestone excludes executable release/configuration surfaces and this bridge.
   if(!/^(src|public|tests|docs)\//.test(path)||path.split('/').some(x=>x==='..'||x==='.git')||/[\x00-\x1f\\]/.test(path)||path.startsWith('src/change-')||path==='src/publication-protocol.ts')throw new CandidateFailure('unsupported_path');
   const previous=(await git(['ls-tree',input.source.baseRevision,'--',path])).toString();if(previous&&!previous.startsWith('100644 blob '))throw new CandidateFailure('unsupported_file_type');
   const entry=(await git(['ls-tree',input.source.treeSha,'--',path])).toString();
   if(!entry){result.deletions.push({path});continue;}
   if(!entry.startsWith('100644 blob '))throw new CandidateFailure('unsupported_file_type');
   const bytes=await git(['show',input.source.treeSha+':'+path]);let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new CandidateFailure('unsupported_file_type');}
   if(text.includes('\0'))throw new CandidateFailure('unsupported_file_type');
   if(bytes.length>128000)throw new CandidateFailure('candidate_too_large');
   contentBytes+=bytes.length;if(contentBytes>512000)throw new CandidateFailure('candidate_too_large');
   result.additions.push({path,contents:bytes.toString('base64')});
  }
  return result;
 }finally{await rm(root,{recursive:true,force:true});}
}
