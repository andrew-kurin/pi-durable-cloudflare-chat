/** Only fixed protocol values may cross the runner -> saved history -> UI
 * boundary. No provider message, arbitrary param path, payload or credential. */
export const RUNNER_SERVICE_CODES = ['transport_auth_failed', 'round_conflict', 'round_already_reserved', 'unsupported_siwc_request', 'siwc_reauthorization_required', 'siwc_access_denied', 'siwc_usage_limited', 'siwc_provider_rejected', 'siwc_refresh_resolution_required', 'siwc_refresh_deferred', 'siwc_credential_invalid', 'siwc_round_interrupted', 'round_cancelled'] as const;
export const RUNNER_FAILURE_CODES = [...RUNNER_SERVICE_CODES, 'runner_transport_interrupted', 'runner_contract_rejected', 'runner_input_limit', 'worker_round_reservation_failed', 'worker_round_conflict', 'worker_round_already_reserved', 'runner_redirect_rejected', 'runner_http_rejected', 'runner_gateway_browser_integrity_blocked', 'runner_round_mismatch', 'runner_body_missing', 'runner_stream_interrupted'] as const;
export const FAILURE_HTTP_STATUSES = [400, 401, 403, 408, 409, 413, 422, 429, 500, 502, 503, 504] as const;
const PROVIDER_CODES = ['subscription_sharing_unsupported_capability', 'subscription_sharing_usage_limit_exceeded', 'invalid_api_key', 'authentication_error', 'permission_denied', 'rate_limit_exceeded', 'usage_limit_reached', 'context_length_exceeded', 'invalid_request_error', 'server_error'] as const;
const PROVIDER_PARAMS = ['input', 'model', 'tools', 'reasoning', 'instructions', 'tool_choice'] as const;
export type ProviderFailureInfo = { httpStatus: number; code?: string; param?: string };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function failureHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && (FAILURE_HTTP_STATUSES as readonly number[]).includes(value) ? value : undefined;
}
export function providerFailureInfo(status: unknown, error: unknown): ProviderFailureInfo | undefined {
  const httpStatus = failureHttpStatus(status);
  if (httpStatus === undefined) return undefined;
  return { httpStatus,
    ...(record(error) && (PROVIDER_CODES as readonly unknown[]).includes(error.code) ? { code: error.code as string } : {}),
    ...(record(error) && (PROVIDER_PARAMS as readonly unknown[]).includes(error.param) ? { param: error.param as string } : {}),
  };
}
export function savedRunnerFailure(diagnostics: unknown) {
  if (!Array.isArray(diagnostics)) return undefined;
  for (const item of diagnostics.slice(-32).reverse()) {
    if (!record(item) || item.type !== 'model_runner_round_failure' || !record(item.details)) continue;
    const d = item.details;
    if (!(RUNNER_FAILURE_CODES as readonly unknown[]).includes(d.code)) continue;
    const httpStatus = failureHttpStatus(d.httpStatus);
    const provider = d.code === 'siwc_provider_rejected' || d.code === 'siwc_reauthorization_required' || d.code === 'siwc_access_denied' || d.code === 'siwc_usage_limited'
      ? record(d.provider) ? providerFailureInfo(d.provider.httpStatus, d.provider) : undefined : undefined;
    return { code: d.code as typeof RUNNER_FAILURE_CODES[number], ...(httpStatus === undefined ? {} : { httpStatus }), ...(provider ? { provider } : {}) };
  }
  return undefined;
}
