import {channel} from 'node:diagnostics_channel';
import type {Server,ServerResponse} from 'node:http';
import type {Socket} from 'node:net';

/** Fixture-only metadata: no request headers, bodies, JWTs or credential values. */
export function runnerLifecycle(){
 const started=performance.now(),events:Record<string,unknown>[]=[],observed=new Set<string>();
 const mark=(event:string,fields:Record<string,unknown>={})=>{
  observed.add(event);
  if(events.length===256)events.shift();
  events.push({event,ms:Math.round(performance.now()-started),...fields});
 };
 let runtimeOrigin='';const seen=new WeakSet<Socket>(),remove:(()=>void)[]=[];
 const observe=(socket:Socket,side:'api'|'runner')=>{
  if(seen.has(socket))return;seen.add(socket);
  const ports={localPort:socket.localPort,remotePort:socket.remotePort};
  const end=()=>mark(side+'.socket.end',ports);
  const close=(hadError:boolean)=>mark(side+'.socket.close',{...ports,hadError});
  const error=(cause:NodeJS.ErrnoException)=>mark(side+'.socket.error',{...ports,code:cause.code});
  socket.on('end',end);socket.on('close',close);socket.on('error',error);
  remove.push(()=>{socket.off('end',end);socket.off('close',close);socket.off('error',error);});
 };
 const sends=channel('undici:client:sendHeaders');
 const sent=(message:unknown)=>{
  const {request,socket}=message as {request:{origin:string;method:string;path:string};socket:Socket};
  if(String(request.origin)!==runtimeOrigin)return;
  observe(socket,'api');mark('api.send',{method:request.method,path:request.path,localPort:socket.localPort,remotePort:socket.remotePort});
 };
 sends.subscribe(sent);
 return{
  events,mark,observed:(event:string)=>observed.has(event),
  api(socket:Socket){observe(socket,'api');},
  runtime(url:URL){runtimeOrigin=url.origin;mark('runtime.ready');},
  runner(server:Server){
   const connection=(socket:Socket)=>observe(socket,'runner');
   const request=(_request:unknown,response:ServerResponse)=>{
    mark('runner.request');response.once('finish',()=>mark('runner.response.finish'));
    response.once('close',()=>mark('runner.response.close',{ended:response.writableEnded}));
   };
   server.on('connection',connection);server.on('request',request);
   remove.push(()=>{server.off('connection',connection);server.off('request',request);});
  },
  close(){sends.unsubscribe(sent);for(const cleanup of remove)cleanup();},
 };
}
