# Offline model-runner prototype

**Fake only. SIWC eligibility for the Cloudflare Worker + owner-hosted runner hybrid is unresolved.** This prototype does not register OAuth, read real credentials, call external inference, change production defaults or provide a deployable live SIWC integration. Its standalone process binds loopback only and ignores credential/network environment variables.

## Ownership and contract v1

The Worker retains Pi orchestration, tool execution/delegation, durable history, admission/quotas, workspace coordination and browser event projection. The service handles one model round, never a whole chat turn and never tools. `createChatModels(credentials, offlineProvider)` in `src/provider-sessions.ts` is an explicit test seam; existing production callers supply no provider. The offline provider is a separate ID, so saved Codex/Grok chats retain their existing routing.

`GET /health` reports fake mode and contract 1. `POST /v1/responses` takes a Pi-generated Responses JSON body with `model: gpt-6.1-sol`, array `input`, `store:false`, `stream:true`, and headers:

- `x-pi-prototype: offline-v1`: fixture marker, **not authentication**.
- `x-pi-round-id`: caller-generated stable ID for exactly one model request. A tool follow-up has its own ID. Reusing an accepted ID returns 409, even if the first response was lost; changed content returns `round_conflict`.

The response is unbuffered Responses SSE. The existing pinned Pi Responses implementation converts text/tool events to Pi messages; the caller executes a tool and submits its result in a new round. It must consume a terminal event: failed, incomplete and truncated streams are distinct from successful completion. The service does not retry. Transport retry is forced to zero, even if requested by its caller. Production harness retry policy is unchanged. Prototype errors preserve the SDK cause and stable round ID in diagnostics, while using a non-retryable summary for Pi’s text classifier; this prevents its harness from silently minting a new round after uncertain work.

A request's AbortSignal/deadline propagates to inference and stream reads; downstream cancellation also aborts upstream. Browser history-feed reconnect is separate from model cancellation. A persistent append-only dispatch fence reserves IDs before backend dispatch. It stores only IDs and request hashes, not prompts, outputs or credentials. Each file has exactly one process owner; do not share it across processes. The file is bounded to 10,000 entries and fails closed when full or corrupt. Do not delete it to retry an uncertain round. It is not a job queue, transcript store or second orchestration system. A lost accepted round remains unavailable; the Worker must report uncertainty rather than silently give it a new ID.

Fake credential access is injected. A shared refresh promise serializes concurrent reads/refresh/persistence; a cancelled round stops waiting without cancelling another round's shared refresh, then cannot dispatch. Failed refresh never dispatches. No credential value crosses the response/client boundary. The Worker adapter strips caller authorization headers before using its explicit fixture transport.

## Run locally

From the repository root, using its existing Node 24 dependency installation:

```sh
node --import tsx --test tests/model-runner.test.ts
npm run typecheck
node --import tsx services/model-runner/server.ts
```

The last command starts `http://127.0.0.1:4319`, using deterministic fake events and `.runtime/model-runner/rounds.jsonl` (ignored, private mode). It does not use the DGX GPU. For a standalone host, install the root pinned dependencies and copy this service and shared source from the same commit; no extra daemon, container platform or message broker is needed. No live image or remote deployment is supplied here.

An optional fake HTTP request from a separate local terminal:

```sh
curl --no-buffer http://127.0.0.1:4319/v1/responses \
  -H 'Content-Type: application/json' -H 'x-pi-prototype: offline-v1' \
  -H 'x-pi-round-id: offline-demo-round-1' \
  -d '{"model":"gpt-6.1-sol","input":[{"role":"user","content":"offline fixture"}],"store":false,"stream":true}'
```

This emits a fake `test_status` call. No tool runs on the service. Repeating that ID returns 409, including after process restart. Stop with Ctrl-C. Never expose this unauthenticated fixture listener beyond loopback.

## Before live integration

1. Confirm eligibility for this exact hybrid with OpenAI. Public OSS/MIT and a self-hosted runner alone do not establish it. See [SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source).
2. Obtain separately approved SIWC registration/consent. Existing `openai-codex` credentials are not assumed compatible. A VM needs its own stable host ID, protected credential storage and one refresh owner; follow [self-hosted VM guidance](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).
3. Implement and test the documented SIWC payload subset: account-specific model discovery, namespace/additional-tools packaging, unsupported-field omission, full context input, terminal usage errors and opaque reasoning/tool-ID continuation. This fixture deliberately accepts Pi's generic Responses payload; it does **not** prove SIWC wire compatibility. Pi 1.1.0 has relevant Responses/SIWC capabilities, but configuring a remote service changes automatic SIWC detection; do not just change a base URL.
4. Use only the documented `https://api.openai.com/v1/responses` flow, never proxy the blocked backend-api route. See [inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) and [preview requirements](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
5. Design authenticated TLS service access, account binding, body/stream limits, health/upgrade/rollback, deployment fence compatibility and restart behavior. Wire Worker Stop through the actual HTTP hop and prove admission/harness replay cannot generate a new round ID for uncertain work. Existing submission IDs are not round IDs. Add owner status/UI/disconnect separately; no production feature flag is introduced here.

Offline tests prove the boundary and fail-closed behavior with fake credentials/inference, not live eligibility, OAuth security, network availability, upstream cancellation confirmation or production recovery.
