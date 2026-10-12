const states={pending:'Pending',running:'Running',success:'Done',error:'Failed',interrupted:'Interrupted',unavailable:'Result unavailable'};
function sourceUrl(raw){try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.port&&u.port!=='443'||!u.hostname.includes('.')||/[\[\]:]/.test(u.hostname)||/^[\d.]+$/.test(u.hostname)||/(?:^|\.)(?:localhost|local|internal|lan|test|invalid|onion)(?:\.|$)/.test(u.hostname)||/\.(?:localdomain|home\.arpa|nip\.io|sslip\.io)$/.test(u.hostname)||/token|secret|password|credential|github_pat_|gh[pousr]_|sk-|tvly-/i.test(decodeURIComponent(u.pathname)))return null;return u.href}catch{return null}}
export function toolActivity(document,tools,expanded,onToggle){
 const list=document.createElement('div');list.className='tool-activities';list.setAttribute('aria-label','Tool activity');
 const rounds=new Map();for(const tool of tools.slice(0,50)){const key=tool?.roundId||'unlinked';if(!rounds.has(key))rounds.set(key,[]);rounds.get(key).push(tool);}
 let roundNumber=0;for(const round of rounds.values()){roundNumber++;const group=document.createElement('div');group.className='tool-round';if(rounds.size>1){const caption=document.createElement('p');caption.className='tool-round-label';caption.textContent='Tool round '+roundNumber;group.append(caption);}
 for(const tool of round){
  if(!tool||typeof tool.id!=='string'||!Object.hasOwn(states,tool.state))continue;
  const row=document.createElement('details');row.className='tool-row';row.dataset.state=tool.state;if(typeof tool.roundId==='string')row.dataset.originMessageId=tool.roundId.slice(0,200);const linkage=['following_response','streaming_response','user_boundary','turn_unavailable','result_unavailable','order_unavailable','no_following_response','unlinked'];if(linkage.includes(tool.linkage))row.dataset.linkage=tool.linkage;row.open=expanded.has(tool.id);
  const summary=document.createElement('summary');summary.dataset.toolId=tool.id;
  const label=document.createElement('span');label.className='tool-label';label.textContent=typeof tool.label==='string'?tool.label.slice(0,80):'Tool';
  const state=document.createElement('span');state.className='tool-state';state.textContent=states[tool.state];summary.append(label,state);
  if(typeof tool.summary==='string'&&tool.summary){const preview=document.createElement('span');preview.className='tool-preview';preview.textContent=tool.summary.slice(0,180);summary.append(preview);}
  const evidence=document.createElement('div');evidence.className='tool-evidence';
  const sources=Array.isArray(tool.sources)?tool.sources.slice(0,5):[];let count=0;
  for(const source of sources){const url=sourceUrl(source?.url);if(!url)continue;const a=document.createElement('a');a.href=url;a.dataset.toolId=tool.id+':source:'+count;a.target='_blank';a.rel='noopener noreferrer';a.textContent=typeof source.title==='string'?source.title.slice(0,140):new URL(url).hostname;evidence.append(a);count++;}
  if(!count){const legacy=document.createElement('p');legacy.className='tool-legacy';legacy.textContent=tool.state==='success'?(tool.label?.startsWith('Workspace ·')?'Workspace result recorded. Save patch and logs for owner review.':'No source details were recorded.'):tool.state==='pending'||tool.state==='running'?'Source details will appear when recorded.':'No source details available.';evidence.append(legacy);}
  const detail=document.createElement('p');detail.className='tool-detail';detail.textContent=typeof tool.detail==='string'?tool.detail.slice(0,500):'No further details available.';
  const technical=document.createElement('details');technical.className='tool-technical';const technicalId=tool.id+':details';technical.open=expanded.has(technicalId);const technicalLabel=document.createElement('summary');technicalLabel.dataset.toolId=technicalId;technicalLabel.textContent='Read details';technical.append(technicalLabel,detail);technicalLabel.addEventListener('click',()=>onToggle(technicalId,!technical.open));technical.addEventListener('toggle',()=>onToggle(technicalId,technical.open));evidence.append(technical);
  summary.addEventListener('click',()=>onToggle(tool.id,!row.open));row.append(summary,evidence);row.addEventListener('toggle',()=>onToggle(tool.id,row.open));group.append(row);
 }
 list.append(group);}
 return list;
}
