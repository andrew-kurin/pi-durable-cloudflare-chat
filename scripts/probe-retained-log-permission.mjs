// Fixed incident-window authorization probe; never emits or stores log records.
export async function probe(fetcher, token, accountId) {
 if (!token || !/^[a-f0-9]{32}$/.test(accountId ?? '')) return { authorized:false, result:'existing CI credential unavailable' };
 try {
  const response=await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`,{
   method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
   headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
   body:JSON.stringify({queryId:'pi-retained-log-permission-probe',timeframe:{from:Date.parse('2026-10-19T03:10:00Z'),to:Date.parse('2026-10-19T03:12:00Z')},dry:true,view:'events',limit:1,parameters:{filters:[{key:'$metadata.service',operation:'eq',type:'string',value:'pi-private-chat'}]}}),
  });
  // Authorization is proven by HTTP200. Actual worker logs are never read.
  await response.body?.cancel().catch(()=>{});
  return { authorized:response.status===200, httpStatus:response.status, result:response.status===200?'retained-log query authorized':'retained-log query not authorized or unavailable' };
 } catch { return {authorized:false,result:'authorization probe unavailable; no raw error emitted'}; }
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1],'file:').href) {
 const result=await probe(globalThis.fetch,process.env.CLOUDFLARE_API_TOKEN,process.env.CLOUDFLARE_ACCOUNT_ID);
 console.log(JSON.stringify(result));
 process.exitCode=result.authorized?0:1;
}
