import {CandidateFailure,candidateMessages} from './errors';
import {digest,sha1,validatePublication,type PublicationInput} from '../../src/change-contract';
import type {FileChanges} from './git';
import type {GitHub,PullRequest} from './github';
export interface Record {version:number;input:PublicationInput;fingerprint:string;phase:'queued'|'branch_dispatch'|'branch_ready'|'commit_dispatch'|'commit_ready'|'pr_dispatch'|'published'|'uncertain'|'rejected';stage?:'branch'|'commit'|'pr';head?:string;pr?:PullRequest;code?:string}
export interface Journal {get(id:string):Record|undefined;reserve(record:Record):Record;put(record:Record):boolean}
/** One durable fence before each external mutation. Uncertain stages reconcile
 * by reads only; they are never blindly dispatched again after a restart. */
export class ChangePublisher {
 private active=new Map<string,Promise<unknown>>();
 constructor(private journal:Journal,private github:GitHub,private prepare:(input:PublicationInput)=>Promise<FileChanges>){}
 private branch(r:Record){return 'pi-self-change/'+r.input.id;}
 private marker(r:Record){return '<!-- pi-harness-change:'+r.input.id+':'+r.fingerprint+' -->';}
 private message(r:Record){return r.input.title+' [pi-change:'+r.input.id+':'+r.fingerprint+']';}
 private save(r:Record){if(!this.journal.put(r))throw Error('Publication journal changed; reconcile current status');}
 private async verifyCommit(r:Record,head:string){if(!sha1(head))throw Error('Invalid commit ID');const c=await this.github.getCommit(head);if(c.sha!==head||!c.verified||c.tree!==r.input.source.treeSha||c.parents.length!==1||c.parents[0]!==r.input.source.baseRevision||c.message!==this.message(r))throw Error('Commit signature, tree, parent or identity mismatch');r.head=head;}
 private verifyPr(r:Record,pr:PullRequest){if(pr.head!==r.head||pr.base!=='main'||!Number.isSafeInteger(pr.number)||pr.number<1||pr.url!=='https://github.com/andrew-kurin/pi-durable-cloudflare-chat/pull/'+pr.number||!pr.body.includes(this.marker(r)))throw Error('PR identity mismatch');r.pr=pr;r.phase='published';delete r.code;}
 private async reconcile(r:Record){
  const stage=r.phase==='uncertain'?r.stage:r.phase==='branch_dispatch'?'branch':r.phase==='commit_dispatch'?'commit':r.phase==='pr_dispatch'?'pr':undefined;if(!stage)return;
  try{
   if(stage==='branch'){const head=await this.github.branch(this.branch(r));if(head===r.input.source.baseRevision){r.phase='branch_ready';delete r.code;}else if(head)throw Error('Unexpected branch head');}
   if(stage==='commit'){const head=await this.github.branch(this.branch(r));if(head&&head!==r.input.source.baseRevision){await this.verifyCommit(r,head);r.phase='commit_ready';delete r.code;}}
   if(stage==='pr'){const pr=await this.github.findPullRequest(this.branch(r));if(pr)this.verifyPr(r,pr);}
   this.save(r);
  }catch{if(this.journal.get(r.input.id)?.version!==r.version)return;r.phase='uncertain';r.stage=stage;r.code='reconciliation_unavailable';this.save(r);}
 }
 private async mutate(r:Record,stage:'branch'|'commit'|'pr',work:()=>Promise<void>){r.phase=(stage+'_dispatch') as Record['phase'];r.stage=stage;this.save(r);try{await work();}catch{r.phase='uncertain';r.code='external_outcome_uncertain';this.save(r);return false;}return true;}
 private async run(r:Record){
  await this.reconcile(r);if(['uncertain','branch_dispatch','commit_dispatch','pr_dispatch','published','rejected'].includes(r.phase))return;
  let files:FileChanges;try{files=await this.prepare(r.input);}catch(error){r.phase='rejected';r.code=error instanceof CandidateFailure?error.code:'git_validation_failed';this.save(r);return;}
  if(r.phase==='queued'){
   // A pre-existing branch without our durable dispatch fence is not adopted.
   if(await this.github.branch(this.branch(r))){r.phase='rejected';r.code='branch_already_exists';this.save(r);return;}
   if(!await this.mutate(r,'branch',()=>this.github.createBranch(this.branch(r),r.input.source.baseRevision)))return;
   r.phase='branch_ready';this.save(r);
  }
  if(r.phase==='branch_ready'){
   if(await this.github.branch(this.branch(r))!==r.input.source.baseRevision){r.phase='rejected';r.code='branch_head_changed';this.save(r);return;}
   if(!await this.mutate(r,'commit',async()=>{const head=await this.github.commit(this.branch(r),r.input.source.baseRevision,this.message(r),files);await this.verifyCommit(r,head);}))return;
   r.phase='commit_ready';this.save(r);
  }
  if(r.phase==='commit_ready'){
   if(await this.github.branch(this.branch(r))!==r.head){r.phase='rejected';r.code='branch_head_changed';this.save(r);return;}
   const existing=await this.github.findPullRequest(this.branch(r));
   if(existing){this.verifyPr(r,existing);this.save(r);return;}
   if(!await this.mutate(r,'pr',async()=>{const pr=await this.github.createPullRequest(this.branch(r),r.input,this.marker(r));if(!pr.draft)throw Error('New PR is not draft');this.verifyPr(r,pr);}))return;
   this.save(r);
  }
 }
 async publish(input:PublicationInput){
  await validatePublication(input);const fingerprint=await digest(JSON.stringify(input));const r=this.journal.reserve({version:0,input,fingerprint,phase:'queued'});
  if(r.fingerprint!==fingerprint)throw Error('Publication operation ID already used');
  let active=this.active.get(input.id);if(!active){active=this.run(r).catch(()=>{/* Read failures leave the saved stage/fence for read-only reconciliation. */}).finally(()=>this.active.delete(input.id));this.active.set(input.id,active);}await active;return this.status(input.id);
 }
 async status(id:string){let r=this.journal.get(id);if(!r)return {id,phase:'not_received',nextStep:'No publisher receipt is available. The owner may retry delivery of the same authorized proposal ID.'};
  if(!this.active.has(id))await this.reconcile(r);r=this.journal.get(id)!;
  const result:{[key:string]:unknown}={id,phase:r.phase,code:r.code,...(r.code&&Object.hasOwn(candidateMessages,r.code)?{error:candidateMessages[r.code as keyof typeof candidateMessages]}:{}),branch:this.branch(r),baseRevision:r.input.source.baseRevision,treeSha:r.input.source.treeSha,headSha:r.head??null,pr:r.pr?{number:r.pr.number,url:r.pr.url,draft:r.pr.draft,state:r.pr.state}:null,nextStep:r.phase==='published'?'Inspect exact-head CI and independently review the PR. Its current draft/state is reported by CI status; merge and deployment remain external.':r.phase==='uncertain'||r.phase.endsWith('_dispatch')?'Read status to reconcile the existing operation. If no matching result appears, retain this fence for operator inspection; do not create another proposal to replay it.':r.phase==='rejected'?'Candidate or branch validation failed. Inspect the immutable export and branch; no failed mutation is automatically replayed.':'The owner may retry delivery for this same proposal ID to continue only undispatched stages.'};
  if(r.pr&&r.head){try{result.ci=await this.github.status(r.pr,r.head);}catch{result.ci={unavailable:true,nextStep:'Retry this status read later; do not republish.'};}}
  return result;
 }
}
