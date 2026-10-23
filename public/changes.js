export function changeReview({document,location,fetch}){
 const el=id=>document.getElementById(id),params=new URLSearchParams(location.search),id=params.get('proposal'),session=params.get('session');let review,busy=false;
 const valid=/^[a-f0-9]{64}$/.test(id||'')&&/^\d{1,12}$/.test(session||'');
 const path='/api/changes/'+id+'?session='+session;
 async function request(url,body){const r=await fetch(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error('Proposal unavailable. Refresh status before retrying; do not create another proposal.');return r.json();}
 function render(value){el('status').textContent=JSON.stringify(value,null,2);el('authorize').disabled=busy||!review;el('authorize').textContent=value.phase==='awaiting_owner'?'Authorize signed draft PR':'Retry delivery of authorized request';el('authorize').hidden=value.publication?.phase==='published';}
 async function act(work){if(busy||!valid)return;busy=true;el('authorize').disabled=true;el('refresh').disabled=true;try{const value=await work();render(value);el('message').textContent=value.publication?.phase==='published'?'Signed PR is available. Inspect its current state and CI, and request independent review before merging.':'Review the exact patch and source below. Refresh status to reconcile any interrupted delivery.';}catch(error){el('message').textContent=error.message;}finally{busy=false;el('authorize').disabled=!review;el('refresh').disabled=false;}}
 el('refresh').onclick=()=>act(()=>request(path));
 el('authorize').onclick=()=>act(()=>request('/api/changes/'+id+'/authorize?session='+session,{action:'authorize_signed_draft_pr',patchSha256:review.patchSha256,treeSha:review.treeSha}));
 const ready=act(async()=>{review=await request('/api/changes/'+id+'/review?session='+session);el('title').textContent=review.title;el('patch').textContent=review.patch;el('source').replaceChildren();for(const [label,value] of [['Repository',review.repository],['Base revision',review.baseRevision],['Tested tree',review.treeSha],['Patch SHA-256',review.patchSha256],['Observed checks',review.checks.map(c=>c.check+' · '+c.runId).join('\n')]]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;el('source').append(dt,dd);}return request(path);});
 if(!valid)el('message').textContent='Invalid proposal link.';
 return {ready};
}
if(typeof document!=='undefined')changeReview({document,location,fetch});
