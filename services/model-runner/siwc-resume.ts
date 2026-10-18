import { open, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { runLocalSiwcRounds, type SiwcReport } from './siwc-check';
import type { CatalogEvidence } from './siwc-catalog';
import type { LocalSiwcCredential } from './siwc-auth';
export interface RecoveryProof { phase: 'catalog-before-inference'; previousInferenceRequests: 0; originalCode: string; reason: string }
/** Explicit audited recovery, never erases or reuses the original dispatch fence.
 * A separate exclusive marker permits ONE owner; any later resume is refused. */
export async function resumeSiwcAfterCatalog(dir: URL, credential: LocalSiwcCredential, catalog: CatalogEvidence, transport: typeof fetch, proof: RecoveryProof) {
 if(proof.phase!=='catalog-before-inference'||proof.previousInferenceRequests!==0||!proof.originalCode||!proof.reason)throw Error('Unproven inference state cannot resume');
 if(catalog.outcome!=='available'||!['gpt-6.1-sol','gpt-6-luna'].every(id=>catalog.catalog.some(m=>m.slug===id&&m.visibility==='list'&&m.supported_in_api===true)))throw Error('Both exact models must be API-supported and listed');
 const prior=await readFile(new URL('diagnostic-rounds.jsonl',dir),'utf8'), entries=prior.trim().split('\n').map(line=>JSON.parse(line));
 if(entries.length!==1||entries[0].id!=='local-siwc-check-v1'||entries[0].fingerprint!=='0'.repeat(64))throw Error('Unexpected original audit');
 try{await lstat(new URL('report.json',dir));throw Error('Prior report exists; cannot assert catalog-only failure');}catch(error:any){if(error.code!=='ENOENT')throw error;}
 const marker=await open(new URL('catalog-recovery.started',dir),'wx',0o600);await marker.writeFile('One recovery owner; never reset after interruption.\n');await marker.sync();await marker.close();
 const audit={operation:'local-siwc-check-v1',originalReservationSha256:createHash('sha256').update(prior).digest('hex'),proof,catalogRequestsPreviously:3,catalogRequestsThisResume:0,inferenceRequests:[] as {model:string;round:number;at:string}[],startedAt:new Date().toISOString()};
 const save=async(name:string,value:unknown)=>{const temp=new URL(randomUUID()+'.tmp',dir);await writeFile(temp,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});const handle=await open(temp,'r+');await handle.sync();await handle.close();await rename(temp,new URL(name,dir));};
 await save('recovery-audit.json',audit);
 const before=async(model:string,round:number)=>{const count=audit.inferenceRequests.filter(r=>r.model===model).length;if(!['gpt-6.1-sol','gpt-6-luna'].includes(model)||count>=(model==='gpt-6.1-sol'?2:1)||round!==count+1)throw Error('Original cumulative request budget exhausted');audit.inferenceRequests.push({model,round,at:new Date().toISOString()});await save('recovery-audit.json',audit);};
 const progress=async(report:SiwcReport)=>save('recovery-progress.json',report);
 const report=await runLocalSiwcRounds(credential,transport,catalog,before,progress);await save('report.json',report);return report;
}
