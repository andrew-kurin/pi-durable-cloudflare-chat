import {digest,operation,validatePublication,type PublicationInput} from './change-contract';
import type {WorkspaceExport} from './workspace';
import {publicationSignature} from './publication-protocol';
import {RequestError} from './http-input';
export interface PublicationEnv {ENABLE_HARNESS_PROPOSALS?:string;PUBLICATION_ENDPOINT?:string;PUBLICATION_TRANSPORT_KEY?:string}
type Store=Pick<DurableObjectStorage,'get'|'put'|'transaction'>;
interface Proposal {input:Omit<PublicationInput,'patch'>;fingerprint:string;phase:'awaiting_owner'|'authorized'|'dispatched';createdAt:number;authorizedAt?:number;dispatchAt?:number}
export class ChangeProposals {
 private tail:Promise<unknown>=Promise.resolve();
 constructor(private store:Store,private env:PublicationEnv,private artifact:(session:string,workspaceId:string,artifactId:string)=>Promise<WorkspaceExport>,private http:typeof fetch=fetch){}
 enabled(){return this.env.ENABLE_HARNESS_PROPOSALS==='true'&&!!this.env.PUBLICATION_ENDPOINT&&!!this.env.PUBLICATION_TRANSPORT_KEY&&this.env.PUBLICATION_TRANSPORT_KEY.length>=32;}
 private serial<T>(fn:()=>Promise<T>){const next=this.tail.then(fn);this.tail=next.catch(()=>{});return next;}
 private requireEnabled(){if(!this.enabled())throw new RequestError(503,'Draft PR publication is not configured. Exported work remains available.','publication_unconfigured');}
 private async owned(session:string,id:string){if(!operation(id))throw new RequestError(400,'Invalid proposal ID');const p=await this.store.get<Proposal>('change-proposal:'+id);if(!p||p.input.session!==session)throw new RequestError(404,'Proposal not found');return p;}
 private summary(p:Proposal){return {id:p.input.id,phase:p.phase,repository:p.input.source.repository,baseRevision:p.input.source.baseRevision,treeSha:p.input.source.treeSha,patchSha256:p.input.source.patchSha256,title:p.input.title,checks:p.input.source.checks,reviewUrl:'/changes?session='+p.input.session+'&proposal='+p.input.id,nextStep:p.phase==='awaiting_owner'?'Open reviewUrl. Only the owner review page can authorize this exact immutable patch for a signed draft PR. Chat text and tool arguments cannot authorize publication.':'Read harness_change_status with this proposal ID. Never create a new proposal to recover an uncertain publication.'};}
 propose(session:string,id:string,workspaceId:string,artifactId:string,title:string){return this.serial(async()=>{
  this.requireEnabled();const artifact=await this.artifact(session,workspaceId,artifactId);const input={id,session,workspaceId,artifactId,title,source:artifact.source!,patch:artifact.patch};
  if(artifact.base!==input.source?.baseRevision)throw new RequestError(409,'Export base metadata mismatch');await validatePublication(input);const fingerprint=await digest(JSON.stringify(input));const key='change-proposal:'+id,prior=await this.store.get<Proposal>(key);
  if(prior){if(prior.fingerprint!==fingerprint)throw new RequestError(409,'Proposal operation ID already used');return this.summary(prior);}
  const artifactKey='change-export:'+session+':'+workspaceId+':'+artifactId;const priorId=await this.store.get<string>(artifactKey);
  if(priorId){const same=await this.owned(session,priorId);if(same.input.title!==title)throw new RequestError(409,'This export already has a proposal. Read its existing status; do not create duplicate PRs.');return this.summary(same);}
  const {patch,...metadata}=input;const p:Proposal={input:metadata,fingerprint,phase:'awaiting_owner',createdAt:Date.now()};await this.store.transaction(async tx=>{await tx.put(key,p);await tx.put(artifactKey,id);});return this.summary(p);
 });}
 async review(session:string,id:string){this.requireEnabled();const p=await this.owned(session,id);return {...this.summary(p),patch:(await this.payload(p)).patch};}
 private async payload(p:Proposal){const artifact=await this.artifact(p.input.session,p.input.workspaceId,p.input.artifactId);if(artifact.base!==p.input.source.baseRevision||JSON.stringify(artifact.source)!==JSON.stringify(p.input.source))throw Error('Immutable export metadata mismatch');const input={...p.input,patch:artifact.patch};await validatePublication(input);return input;}
 private async bridge(method:'POST'|'GET',p:Proposal){
  const endpoint=new URL(this.env.PUBLICATION_ENDPOINT!);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')throw new RequestError(503,'Publisher endpoint must be an exact HTTPS origin');
  const body=method==='POST'?JSON.stringify(await this.payload(p)):'';const signature=await publicationSignature(this.env.PUBLICATION_TRANSPORT_KEY!,method,p.input.id,body);
  const response=await this.http(new URL('/v1/changes/'+p.input.id,endpoint),{method,redirect:'error',headers:{'Content-Type':'application/json','X-Pi-Publication-Signature':signature},...(body?{body}:{}),signal:AbortSignal.timeout(15000)});
  const reader=response.body?.getReader();if(!reader)throw Error('Publisher response unavailable');let text='',size=0;const decoder=new TextDecoder();try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>32000)throw Error('Publisher response too large');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}
  if(!response.ok)throw Error('Publisher request unavailable');const data=JSON.parse(text);if(!data||data.id!==p.input.id||typeof data.phase!=='string')throw Error('Publisher receipt mismatch');return data;
 }
 /** This is called only by the authenticated owner HTTP route, never by a model tool. */
 authorize(session:string,id:string,patchSha256:string,treeSha:string){return this.serial(async()=>{
  this.requireEnabled();const p=await this.owned(session,id);if(p.input.source.patchSha256!==patchSha256||p.input.source.treeSha!==treeSha)throw new RequestError(409,'Reviewed export changed');
  if(p.phase==='awaiting_owner'){p.phase='authorized';p.authorizedAt=Date.now();await this.store.put('change-proposal:'+id,p);}
  // Delivery retries always use the same immutable envelope and publisher journal ID.
  // That journal, rather than this HTTP acknowledgement, owns external mutation fences.
  p.phase='dispatched';p.dispatchAt??=Date.now();await this.store.put('change-proposal:'+id,p);
  try{return {...this.summary(p),publication:await this.bridge('POST',p)};}catch{return {...this.summary(p),publication:{id,phase:'delivery_uncertain',nextStep:'Read status first. The owner may retry delivery for this same proposal ID; never re-export or create a new request to replay publication.'}};}
 });}
 async status(session:string,id:string){this.requireEnabled();const p=await this.owned(session,id);if(p.phase!=='dispatched')return this.summary(p);try{return {...this.summary(p),publication:await this.bridge('GET',p)};}catch{return {...this.summary(p),publication:{id,phase:'status_unavailable',nextStep:'Retry this status read later. No publication was replayed.'}};}}
}
