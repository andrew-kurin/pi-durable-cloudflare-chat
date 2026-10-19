# Offline investigation of the HTTP 200 / Connection error

The October 18 local checks retained HTTP 200, CF-Ray, no Content-Type, no terminal SSE event, and the SDK text `Connection error.` One request was reserved/sent per model, with no tool or Sol follow-up. No live request was made during this investigation, and no credential or reservation was changed.

## Actual path and observation boundary

1. `local-siwc.ts` calls `resumeSiwcAfterCatalog` with the explicit native `fetch` transport and existing local credential. The audit reserves before each POST. The original reservation is preserved.
2. `runLocalSiwcRounds` in `siwc-check.ts` uses Pi 1.1.0’s **direct** `api/openai-responses.streamSimple`, after `normalizeContext`. It does not route through `provider-sessions`, `guardModels`, the fake runner, a Worker, a Durable Object or browser history streaming. Those paths cannot strip this live response’s headers.
3. Pi `dist/api/openai-responses.js:117–145` constructs the pinned OpenAI 7.19.0 client with our `fetch` override. Its payload hook restricts the request body. Both Pi request retries and SDK retries are zero. `createClient` passes the fetch function through; no response is reconstructed there.
4. OpenAI `client.mjs:984–1021` invokes that override with its timeout/controller signal and returns the resulting response unchanged. Our override calls the injected native transport. **Status and named headers are read directly from the transport-returned Response before any body reader or reconstruction.** Thus the missing Content-Type was already absent at this Mac `fetch` boundary. This does not prove what left the upstream origin versus any intervening network component.
5. The old guard required the original header to contain the case-sensitive string `text/event-stream`. If absent, it cancelled the original body and threw **inside the fetch override**. No body reached Pi’s SSE parser. It also rejected valid mixed-case media types.
6. OpenAI `client.mjs:779–841` treats a thrown fetch override as a transport failure and wraps it in `APIConnectionError`, normally with message `Connection error.` Pi’s error normalization retained that generic message. The lack of terminal events therefore did not prove an upstream connection failure: our own guard caused it before parsing.
7. For accepted responses, `bounded()` reads the original body once and reconstructs `new Response(stream, {status: response.status, headers: response.headers})`. It preserves Content-Type and correlation headers; native streaming tests verify this and successful fragmented bodies. It limits bytes without buffering the whole SSE response. Future evidence marks `headersCapturedAt: transport-return`, body presence, received bytes and bounded read errors.
8. OpenAI `internal/parse.mjs:8–15` selects SSE parsing from the request’s `stream:true`; it does **not** require a Content-Type header. `core/streaming.mjs:76–145` decodes streamed frames. Pi `openai-responses-shared.js:479,639–659` handles Responses events and rejects missing terminal events. Our check additionally requires `response.completed` and the fixed marker/tool constraints.

## Reproduced defect and correction

`tests/siwc-stream-path.test.ts` runs a real Node HTTP server on an ephemeral loopback port. It sends named SSE events, comments, CRLF delimiters, UTF-8 text and JSON split across seven-byte writes. Native fetch passes through our complete diagnostic, the bounded Response copy, pinned OpenAI parser, Pi message conversion and caller-owned tool follow-up. It does not mock final Pi events.

Before the fix, ordinary Content-Type passed; headerless and mixed-case valid SSE failed in our full adapter. The pinned SDK consumed the same headerless HTTP fixture successfully without our guard. This reproduces a local cause for the generic Connection error.

The guard now normalizes a present media type case-insensitively. An absent/empty Content-Type is recorded but passed to the native parser; **valid SSE and `response.completed` are still mandatory**. Explicit non-SSE media types are rejected with bounded redacted operational evidence. Headerless HTML and prematurely dropped streams still fail without tool/follow-up. No header is fabricated. The transport also combines the SDK signal with the diagnostic deadline rather than replacing it; a loopback stalled-header test verifies SDK cancellation remains effective.

## What remains unproven

The old live bodies were cancelled and not retained. Offline reproduction proves the guard rejected them and manufactured the generic transport error; it cannot prove that either live body contained valid SSE, valid JSON, HTML, no bytes or a later upstream error. Nor can it establish which upstream/network component omitted Content-Type. Subsequent separately approved fresh local checks passed through the fixed parser, including Sol text, a Sol tool continuation and Luna text. The original one-shot inference audit remains closed. See [verified local results](LIVE-RESULTS.md).

Fresh checks recorded original response metadata, byte counts and completed events. Only an explicitly enabled fixed diagnostic retained final text/tool-marker evidence; hidden reasoning and raw SSE were not logged. Do not reset consumed reservations. Local success does not establish hosted eligibility, a Spark service, or Cloudflare production recovery.
