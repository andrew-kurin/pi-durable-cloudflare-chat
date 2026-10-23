import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {pathToFileURL} from 'node:url';
import {operation,MAX_PUBLICATION_WIRE_BYTES} from '../../src/change-contract';
import {verifyPublicationSignature} from '../../src/publication-protocol';
import {ChangePublisher} from './core';
import {GitHubApi} from './github';
import {prepareCandidate} from './git';
import {PublicationJournal} from './journal';
export function publicationHandler(core:Pick<ChangePublisher,'publish'|'status'>,key:string){return async(req:IncomingMessage,res:ServerResponse)=>{
 const reply=(status:number,value:unknown)=>{let text=JSON.stringify(value);if(Buffer.byteLength(text)>30000)text=JSON.stringify({id:req.url?.split('/').at(-1),phase:'status_too_large',incomplete:true,nextStep:'Inspect the linked PR for complete CI/review details; no publication was replayed.'});res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(text);};
 try{
  const match=/^\/v1\/changes\/([a-f0-9]{64})$/.exec(req.url??'');if(!match||!['GET','POST'].includes(req.method??''))return reply(404,{error:'Not found'});
  const id=match[1];let body='',size=0;const decoder=new TextDecoder('utf-8',{fatal:true});for await(const chunk of req){size+=chunk.length;if(size>MAX_PUBLICATION_WIRE_BYTES)return reply(413,{error:'Request too large'});body+=decoder.decode(chunk,{stream:true});}body+=decoder.decode();
  const signature=req.headers['x-pi-publication-signature'];if(typeof signature!=='string'||!await verifyPublicationSignature(key,req.method!,id,body,signature))return reply(403,{error:'Forbidden'});
  if(req.method==='GET'){if(body)return reply(400,{error:'GET body is not supported'});return reply(200,await core.status(id));}
  const input=JSON.parse(body);if(!operation(input.id)||input.id!==id)return reply(400,{error:'Publication identity mismatch'});return reply(200,await core.publish(input));
 }catch{return reply(400,{error:'Publication unavailable. Inspect the existing operation status before retrying.'});}
};}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 process.umask(0o077);const token=process.env.GITHUB_PUBLICATION_TOKEN,key=process.env.PUBLICATION_TRANSPORT_KEY,path=process.env.PUBLICATION_JOURNAL;
 if(!token||!key||key.length<32||!path)throw Error('Configure the isolated publisher token, transport key and persistent journal before startup');
 const journal=new PublicationJournal(path),core=new ChangePublisher(journal,new GitHubApi(token),prepareCandidate);
 const server=createServer(publicationHandler(core,key));server.requestTimeout=120000;server.headersTimeout=15000;server.listen(8789,'127.0.0.1');
}
