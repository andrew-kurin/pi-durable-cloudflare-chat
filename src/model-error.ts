/** Classify an existing provider error locally. Never forward its raw text or payload. */
export function modelErrorDiagnostic(raw:unknown):string {
 if(typeof raw!=='string'||raw.length>65536)return 'Diagnostic hint: unclassified saved model error.';
 const status=raw.match(/^(?:[A-Za-z][A-Za-z ]{0,40} \()?([45]\d\d)\)?(?:\s*:|\s+status code\b)/)?.[1];
 const codes=['invalid_api_key','authentication_error','permission_denied','rate_limit_exceeded','usage_limit_reached','context_length_exceeded','invalid_request_error','server_error'] as const;
 const code=codes.find(c=>new RegExp('"code"\\s*:\\s*"'+c+'"').test(raw));
 let category='unclassified saved model error';
 if(raw==='Model access unavailable or daily request limit reached.')category='local model access guard';
 else if(/No API key for provider:|OAuth.*(?:expired|refresh|failed)|(?:invalid_api_key|authentication_error)/i.test(raw)||status==='401')category='authentication or subscription credentials';
 else if(status==='403'||code==='permission_denied')category='access denied';
 else if(status==='429'||code==='rate_limit_exceeded'||code==='usage_limit_reached'||/usage limit|rate limit/i.test(raw))category='rate or usage limit';
 else if(code==='context_length_exceeded'||/context (?:window|length)|maximum context|input is too long/i.test(raw))category='context limit';
 else if(/No tool (?:output|response|call) found|(?:No tool (?:output|response) found|No tool call found|function_call_output|tool_call_id|call_id).*(?:missing|invalid|not found|without|match)|(?:missing|invalid|not found|without|match).*(?:function_call_output|tool_call_id|call_id)/i.test(raw))category='tool response protocol';
 else if(/timed? out|timeout|RetryDelayExceeded/i.test(raw)||status==='408')category='request timeout';
 else if(/Invalid Codex (?:SSE|WebSocket) JSON|stream ended without a stop reason|stream closed before response.completed|No response body/i.test(raw))category='response stream protocol';
 else if(/fetch failed|network error|connection reset|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(raw))category='network transport';
 else if(status&&['500','502','503','504'].includes(status)||code==='server_error')category='upstream service error';
 else if(status&&['400','409','413','422'].includes(status)||code==='invalid_request_error')category='request rejected';
 return 'Diagnostic hint: '+category+'.'+(status&&['400','401','403','408','409','413','422','429','500','502','503','504'].includes(status)?' Reported HTTP '+status+'.':'')+(code?' Reported code: '+code+'.':'');
}
