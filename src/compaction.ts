/** Native Pi context compaction. Entries remain intact for the history projector.
 * The conversation's selected model summarizes; no separate background provider.
 */
export const COMPACTION_POLICY = {
 enabled: true,
 reserveTokens: 16384,
 keepRecentTokens: 32768,
 backgroundTokens: 32768,
};

import {CompactionTask,defineExtension,hook} from '@earendil-works/pi-durable';
/** Observation only: Pi owns range selection, summarization and placement. */
export function compactionLogs(workerVersion?:string){return defineExtension({name:'compaction-logs',hooks:[hook(CompactionTask,{beforeCompact:(selection,api)=>{try{console.info(JSON.stringify({event:'pi_compaction',phase:'selected',workerVersion,taskId:String(api.taskId),conversation:String(api.conversationId),reason:selection.reason,sourceEntries:selection.entries.length,sourceMessages:selection.messages.length,firstKept:String(selection.firstKept)}));}catch{}return undefined;}})]});}
