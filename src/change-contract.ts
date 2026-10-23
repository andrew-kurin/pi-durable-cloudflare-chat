/** Shared data contract only. No credential, network or publication authority. */
export const MAX_PUBLICATION_WIRE_BYTES=3100000;
export const HARNESS_REPOSITORY = 'andrew-kurin/pi-durable-cloudflare-chat';
export const CHECK_COMMANDS = {test:['npm','test'],typecheck:['npm','run','typecheck'],build:['npm','run','build']} as const;
export type CheckName = keyof typeof CHECK_COMMANDS;
export interface CheckReceipt {check:CheckName;runId:string;treeSha:string;exitCode:0;finishedAt:number}
export interface ChangeSource {repository:string;baseRevision:string;treeSha:string;patchSha256:string;checks:CheckReceipt[]}
export interface PublicationInput {id:string;session:string;workspaceId:string;artifactId:string;title:string;source:ChangeSource;patch:string}
export const sha1=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
export const operation=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
export async function digest(text:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join('');}
export function checkName(argv:readonly string[]):CheckName|undefined{return (Object.keys(CHECK_COMMANDS) as CheckName[]).find(k=>JSON.stringify(CHECK_COMMANDS[k])===JSON.stringify(argv));}
export async function validatePublication(input:PublicationInput){
 if(new TextEncoder().encode(JSON.stringify(input)).length>MAX_PUBLICATION_WIRE_BYTES)throw Error('Publication envelope is too large after JSON escaping; use a smaller patch');
 if(!input||!operation(input.id)||!/^\d{1,12}$/.test(input.session)||!/^[-a-f0-9]{36}$/.test(input.workspaceId)||!/^([a-f0-9]{64}|final)$/.test(input.artifactId)||typeof input.title!=='string'||input.title.length<1||input.title.length>100||/[\x00-\x1f]/.test(input.title))throw Error('Invalid proposal identity or title');
 const s=input.source;
 if(!s||s.repository!==HARNESS_REPOSITORY||!sha1(s.baseRevision)||!sha1(s.treeSha)||!operation(s.patchSha256)||typeof input.patch!=='string'||!input.patch||new TextEncoder().encode(input.patch).length>512000||await digest(input.patch)!==s.patchSha256)throw Error('Export source or patch hash is invalid; create a fresh immutable export');
 if(!Array.isArray(s.checks)||s.checks.length!==3||new Set(s.checks.map(c=>c.check)).size!==3||s.checks.some(c=>!Object.hasOwn(CHECK_COMMANDS,c.check)||!operation(c.runId)||c.exitCode!==0||c.treeSha!==s.treeSha||!Number.isSafeInteger(c.finishedAt)||c.finishedAt<0)||new Set(s.checks.map(c=>c.runId)).size!==3)throw Error('Run npm test, npm run typecheck and npm run build successfully on the same unchanged tree, then export again');
}
