/** Authentication for the isolated publisher, separate from model/provider transport. */
import {operation} from './change-contract';
export async function publicationSignature(key:string,method:string,id:string,body:string){
 const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(method+'\n'+id+'\n'+body)))).map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function verifyPublicationSignature(key:string,method:string,id:string,body:string,signature:string){
 if(!operation(id)||!operation(signature)||key.length<32)return false;
 const expected=await publicationSignature(key,method,id,body);let difference=0;for(let i=0;i<64;i++)difference|=signature.charCodeAt(i)^expected.charCodeAt(i);return difference===0;
}
