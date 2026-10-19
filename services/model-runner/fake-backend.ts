const sse = (events: object[]) => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
/** Deterministic fixture only: never evaluates tools or calls the network. */
export async function fakeBackend(payload: Record<string, unknown>, _access: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const followup = (payload.input as { type?: string }[]).some(item => item.type === 'function_call_output');
  if (!followup) {
    const call = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'test_status', arguments: '{}' };
    return sse([{ type: 'response.created', response: { id: 'resp_aaaaaaaa' } }, { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } }, { type: 'response.output_item.done', output_index: 0, item: call }, { type: 'response.completed', response: { id: 'resp_aaaaaaaa', status: 'completed', output: [call] } }]);
  }
  const item = { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'Confirmed offline-marker.', annotations: [] }] };
  return sse([{ type: 'response.created', response: { id: 'resp_bbbbbbbb' } }, { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } }, { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Confirmed offline-marker.' }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'resp_bbbbbbbb', status: 'completed', output: [item] } }]);
}
