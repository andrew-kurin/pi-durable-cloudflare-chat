// Legacy presentation parsing is confined here. Modern views declare failureState
// even when null, so normal assistant copy can never become an interruption signal.
const LEGACY_FAILURE = 'Sol could not finish this response.';
export function historyPresentation(view) {
  const modern = Object.hasOwn(view, 'failureState');
  const messages = view.messages.map(message => {
    if (message.failure?.kind === 'model' || modern || message.role !== 'assistant' || !message.text?.startsWith(LEGACY_FAILURE)) return message;
    return { ...message, failure: { kind: 'model', recoveryAction: 'check-status',
      legacyHint: message.text.split('Diagnostic hint:')[1]?.trim().slice(0,500) } };
  });
  const interrupted = modern ? view.failureState?.kind === 'model' : view.activity?.startsWith(LEGACY_FAILURE);
  return { ...view, messages, activity: interrupted
    ? messages.some(m => m.failure?.kind === 'model') ? '' : 'Response interrupted · saved work retained.'
    : view.activity };
}
