import { RUNNER_FAILURE_CODES, savedRunnerFailure } from './model-runner-error';
/** Classify an existing provider error locally. Never forward its raw text or payload. */
export interface ModelErrorInfo {
  category: string;
  httpStatus?: string;
  code?: string;
  providerHttpStatus?: string;
  providerCode?: string;
  providerParam?: string;
}
export interface SavedFailure {
  kind: "model";
  diagnostic: ModelErrorInfo;
  recoveryAction: "check-status";
}
function runnerErrorInfo(failure: NonNullable<ReturnType<typeof savedRunnerFailure>>): ModelErrorInfo {
  const { code, httpStatus, provider } = failure;
  if (code === 'runner_gateway_browser_integrity_blocked')
    return { category: 'runner gateway browser integrity check', httpStatus: '403', code: 'cloudflare_1010' };
  const category = provider?.code === 'subscription_sharing_unsupported_capability' ? 'subscription input capability rejected'
    : code === 'runner_http_rejected' ? 'runner HTTP rejection'
    : code === 'siwc_provider_rejected' ? 'provider request rejected'
    : ['siwc_reauthorization_required', 'siwc_refresh_resolution_required', 'siwc_refresh_deferred', 'siwc_credential_invalid'].includes(code) ? 'authentication or subscription credentials'
    : code === 'siwc_access_denied' ? 'access denied'
    : code === 'siwc_usage_limited' ? 'rate or usage limit'
    : code === 'runner_input_limit' ? 'runner input size limit'
    : ['unsupported_siwc_request', 'runner_contract_rejected'].includes(code) ? 'runner request protocol'
    : code === 'runner_stream_interrupted' ? 'response stream protocol'
    : ['round_conflict', 'round_already_reserved', 'worker_round_conflict', 'worker_round_already_reserved'].includes(code) ? 'model round dispatch fence'
    : 'model runner failure';
  return { category, code,
    ...(httpStatus === undefined ? {} : { httpStatus: String(httpStatus) }),
    ...(provider ? { providerHttpStatus: String(provider.httpStatus), ...(provider.code ? { providerCode: provider.code } : {}), ...(provider.param ? { providerParam: provider.param } : {}) } : {}),
  };
}
export function modelErrorInfo(raw: unknown, diagnostics?: unknown): ModelErrorInfo {
  const failure = savedRunnerFailure(diagnostics);
  if (failure) return runnerErrorInfo(failure);
  if (typeof raw !== "string" || raw.length > 65536)
    return { category: "unclassified saved model error" };
  if (raw === "Model round failed (runner gateway browser integrity blocked); automatic replay disabled.")
    return { category: "runner gateway browser integrity check", httpStatus: "403", code: "cloudflare_1010" };
  if (raw === "Model round failed (runner input limit); automatic replay disabled.")
    return { category: "runner input size limit", code: "runner_input_limit" };
  if (raw === "Model round failed (unsupported siwc request); automatic replay disabled.")
    return { category: "runner request protocol", code: "unsupported_siwc_request" };
  if (raw === "Model round failed (runner stream interrupted); automatic replay disabled.")
    return { category: "response stream protocol", code: "runner_stream_interrupted" };
  // Older saved messages may have the fixed runner text without diagnostics.
  const runnerCode = raw.match(/^Model round failed \(([a-z ]+)\); automatic replay disabled\.$/)?.[1].replaceAll(' ', '_');
  if ((RUNNER_FAILURE_CODES as readonly unknown[]).includes(runnerCode))
    return runnerErrorInfo({ code: runnerCode as typeof RUNNER_FAILURE_CODES[number] });
  const status = raw.match(
    /^(?:[A-Za-z][A-Za-z ]{0,40} \()?([45]\d\d)\)?(?:\s*:|\s+status code\b)/,
  )?.[1];
  const codes = [
    "invalid_api_key",
    "authentication_error",
    "permission_denied",
    "rate_limit_exceeded",
    "usage_limit_reached",
    "context_length_exceeded",
    "invalid_request_error",
    "server_error",
  ] as const;
  const code = codes.find((c) =>
    new RegExp('"code"\\s*:\\s*"' + c + '"').test(raw),
  );
  let category = "unclassified saved model error";
  if (raw === "Model access unavailable or daily request limit reached.")
    category = "local model access guard";
  else if (
    /No API key for provider:|OAuth.*(?:expired|refresh|failed)|(?:invalid_api_key|authentication_error)/i.test(
      raw,
    ) ||
    status === "401"
  )
    category = "authentication or subscription credentials";
  else if (status === "403" || code === "permission_denied")
    category = "access denied";
  else if (
    status === "429" ||
    code === "rate_limit_exceeded" ||
    code === "usage_limit_reached" ||
    /usage limit|rate limit/i.test(raw)
  )
    category = "rate or usage limit";
  else if (
    code === "context_length_exceeded" ||
    /context (?:window|length)|maximum context|input is too long/i.test(raw)
  )
    category = "context limit";
  else if (
    /No tool (?:output|response|call) found|(?:No tool (?:output|response) found|No tool call found|function_call_output|tool_call_id|call_id).*(?:missing|invalid|not found|without|match)|(?:missing|invalid|not found|without|match).*(?:function_call_output|tool_call_id|call_id)/i.test(
      raw,
    )
  )
    category = "tool response protocol";
  else if (
    /timed? out|timeout|RetryDelayExceeded/i.test(raw) ||
    status === "408"
  )
    category = "request timeout";
  else if (
    /Invalid Codex (?:SSE|WebSocket) JSON|stream ended without a stop reason|stream closed before response.completed|No response body/i.test(
      raw,
    )
  )
    category = "response stream protocol";
  else if (
    /fetch failed|network error|connection reset|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(
      raw,
    )
  )
    category = "network transport";
  else if (
    (status && ["500", "502", "503", "504"].includes(status)) ||
    code === "server_error"
  )
    category = "upstream service error";
  else if (
    (status && ["400", "409", "413", "422"].includes(status)) ||
    code === "invalid_request_error"
  )
    category = "request rejected";
  return {
    category,
    ...(status &&
    [
      "400",
      "401",
      "403",
      "408",
      "409",
      "413",
      "422",
      "429",
      "500",
      "502",
      "503",
      "504",
    ].includes(status)
      ? { httpStatus: status }
      : {}),
    ...(code ? { code } : {}),
  };
}
export function modelErrorDiagnostic(raw: unknown, diagnostics?: unknown): string {
  const info = modelErrorInfo(raw, diagnostics);
  return (
    "Diagnostic hint: " +
    info.category +
    "." +
    (info.httpStatus ? " Reported HTTP " + info.httpStatus + "." : "") +
    (info.code ? " Reported code: " + info.code + "." : "") +
    (info.providerHttpStatus ? " Provider HTTP " + info.providerHttpStatus + "." : "") +
    (info.providerCode ? " Provider code: " + info.providerCode + "." : "") +
    (info.providerParam ? " Provider parameter: " + info.providerParam + "." : "")
  );
}
