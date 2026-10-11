const states={pending:'Pending',running:'Running',success:'Done',error:'Failed',interrupted:'Interrupted',unavailable:'Result unavailable'};
export function toolActivity(document,tools,expanded,onToggle){
 const list=document.createElement('div');list.className='tool-activities';list.setAttribute('aria-label','Tool activity');
 for(const tool of tools.slice(0,50)){
  if(!tool||typeof tool.id!=='string'||!Object.hasOwn(states,tool.state))continue;
  const row=document.createElement('details');row.className='tool-row';row.dataset.state=tool.state;row.open=expanded.has(tool.id);
  const summary=document.createElement('summary');summary.dataset.toolId=tool.id;
  const label=document.createElement('span');label.className='tool-label';label.textContent=typeof tool.label==='string'?tool.label.slice(0,80):'Tool';
  const state=document.createElement('span');state.className='tool-state';state.textContent=states[tool.state];summary.append(label,state);
  const detail=document.createElement('p');detail.className='tool-detail';detail.textContent=typeof tool.detail==='string'?tool.detail.slice(0,500):'No further details available.';
  row.append(summary,detail);row.addEventListener('toggle',()=>onToggle(tool.id,row.open));list.append(row);
 }
 return list;
}
