import {redactErrorText} from '../../src/error-log';
import {HARNESS_REPOSITORY,type PublicationInput} from '../../src/change-contract';
import type {FileChanges} from './git';
export interface Commit {sha:string;tree:string;parents:string[];message:string;verified:boolean}
export interface PullRequest {number:number;url:string;head:string;base:string;draft:boolean;state:string;body:string}
export interface GitHub {
 branch(name:string):Promise<string|null>;createBranch(name:string,base:string):Promise<void>;
 commit(name:string,base:string,message:string,files:FileChanges):Promise<string>;getCommit(sha:string):Promise<Commit>;
 findPullRequest(branch:string):Promise<PullRequest|null>;createPullRequest(branch:string,input:PublicationInput,marker:string):Promise<PullRequest>;
 status(pr:PullRequest,expectedHead:string):Promise<unknown>;
}
const clip=(s:unknown,n:number)=>typeof s==='string'?redactErrorText(s,n):'';
const safeUrl=(s:unknown)=>typeof s==='string'&&/^https:\/\/github\.com\//.test(s)?s.slice(0,1000):null;
export class GitHubApi implements GitHub {
 constructor(private token:string,private http:typeof fetch=fetch){}
 private async request(path:string,body?:unknown){
  const r=await this.http('https://api.github.com'+path,{method:body?'POST':'GET',redirect:'error',headers:{Authorization:'Bearer '+this.token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'pi-harness-change-publisher','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  if(r.status===404&&!body)return null;if(!r.ok)throw Error('GitHub request rejected or unavailable');
  const reader=r.body?.getReader();if(!reader)throw Error('GitHub body unavailable');let text='',size=0;const decoder=new TextDecoder();try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1000000)throw Error('GitHub body limit');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}return JSON.parse(text);
 }
 async branch(name:string){const r=await this.request('/repos/'+HARNESS_REPOSITORY+'/git/ref/heads/'+name);return r?.object?.sha??null;}
 async createBranch(name:string,base:string){await this.request('/repos/'+HARNESS_REPOSITORY+'/git/refs',{ref:'refs/heads/'+name,sha:base});}
 async commit(name:string,base:string,message:string,files:FileChanges){const r=await this.request('/graphql',{query:'mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}',variables:{input:{branch:{repositoryNameWithOwner:HARNESS_REPOSITORY,branchName:name},expectedHeadOid:base,message:{headline:message},fileChanges:files}}});if(r?.errors||!r?.data?.createCommitOnBranch?.commit?.oid)throw Error('Signed commit acknowledgement unavailable');return r.data.createCommitOnBranch.commit.oid as string;}
 async getCommit(sha:string){const r=await this.request('/repos/'+HARNESS_REPOSITORY+'/git/commits/'+sha);if(!r)throw Error('Commit unavailable');return {sha:r.sha,tree:r.tree?.sha,parents:(r.parents||[]).map((p:any)=>p.sha),message:r.message,verified:r.verification?.verified===true};}
 private pr(r:any):PullRequest{return {number:r.number,url:r.html_url,head:r.head?.sha,base:r.base?.ref,draft:r.draft===true,state:r.state,body:r.body??''};}
 async findPullRequest(branch:string){const rows=await this.request('/repos/'+HARNESS_REPOSITORY+'/pulls?state=all&head='+encodeURIComponent('andrew-kurin:'+branch)+'&base=main&per_page=2');if(!Array.isArray(rows)||rows.length>1)throw Error('PR identity is ambiguous');return rows.length?this.pr(rows[0]):null;}
 async createPullRequest(branch:string,input:PublicationInput,marker:string){return this.pr(await this.request('/repos/'+HARNESS_REPOSITORY+'/pulls',{title:input.title,head:branch,base:'main',draft:true,body:'Owner-authorized Pi source proposal. Merge and deployment remain separate.\n\nBase: `'+input.source.baseRevision+'`\nTree: `'+input.source.treeSha+'`\nPatch SHA-256: `'+input.source.patchSha256+'`\n\nWorkspace observed npm test, npm run typecheck and npm run build exiting successfully on an unchanged tree. These receipts do not establish test quality; review hosted CI and independently review the change.\n\n'+marker}));}
 async status(pr:PullRequest,expectedHead:string){
  const current=await this.request('/repos/'+HARNESS_REPOSITORY+'/pulls/'+pr.number);if(!current)throw Error('PR unavailable');
  const actual=this.pr(current);if(actual.head!==expectedHead)return {headSha:actual.head,expectedHeadSha:expectedHead,headChanged:true,draft:actual.draft,state:actual.state,nextStep:'The PR head changed externally. These checks do not describe the authorized published commit; inspect the PR before further action.'};
  const root='/repos/'+HARNESS_REPOSITORY;
  const [checks,statuses,reviews]=await Promise.all([this.request(root+'/commits/'+expectedHead+'/check-runs?per_page=20'),this.request(root+'/commits/'+expectedHead+'/status?per_page=20'),this.request(root+'/pulls/'+pr.number+'/reviews?per_page=20')]);
  if(!checks||!statuses||!Array.isArray(reviews))throw Error('CI or review status unavailable');
  const result={headSha:expectedHead,headChanged:false,draft:actual.draft,state:actual.state,observedAt:new Date().toISOString(),checks:(checks.check_runs||[]).slice(0,20).map((x:any)=>({name:clip(x.name,120),headSha:clip(x.head_sha,40),status:clip(x.status,40),conclusion:clip(x.conclusion,40),url:safeUrl(x.html_url||x.details_url),summary:clip(x.output?.summary,300),summaryTruncated:typeof x.output?.summary==='string'&&x.output.summary.length>300})),statuses:(statuses.statuses||[]).slice(0,20).map((x:any)=>({context:clip(x.context,120),state:clip(x.state,40),description:clip(x.description,200),url:safeUrl(x.target_url)})),reviews:reviews.slice(0,20).map((x:any)=>({id:x.id,state:clip(x.state,40),commitId:clip(x.commit_id,40),body:clip(x.body,300),bodyTruncated:typeof x.body==='string'&&x.body.length>300,appliesToHead:x.commit_id===expectedHead,url:safeUrl(x.html_url)})),incomplete:(checks.total_count??0)>20||(statuses.total_count??0)>20||reviews.length>=20,continuation:null,nextStep:'Inspect linked checks and PR review history for full details. Results are bounded and do not grant merge or deployment approval; no aggregate success or review approval is inferred.'};
  result.incomplete||=result.checks.some((x:any)=>x.summaryTruncated)||result.reviews.some((x:any)=>x.bodyTruncated);
  while(new TextEncoder().encode(JSON.stringify(result)).length>22000){result.incomplete=true;const list=[result.checks,result.statuses,result.reviews].sort((a,b)=>JSON.stringify(b).length-JSON.stringify(a).length)[0];if(!list.length)throw Error('Status metadata exceeds limit');list.pop();}return result;
 }
}
