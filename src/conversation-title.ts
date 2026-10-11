export function conversationTitle(text:unknown):string {
 if(typeof text!=='string')return '';
 if(/bearer\s|-----BEGIN|\b(?:gh[pousr]_|github_pat_|sk-|tvly-)[A-Za-z0-9_-]+|\b(?:api[_-]?key|access[_-]?token|password|secret|token)\s*[:=]/i.test(text))return '';
 const clean=text.replace(/https?:\/\/\S+/gi,'').replace(/[`#*_>\[\]]/g,'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim();
 if(!clean)return '';
 return clean.length>56?clean.slice(0,53).trimEnd()+'…':clean;
}
