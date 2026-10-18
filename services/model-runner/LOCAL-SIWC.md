# Local SIWC compatibility check — approval pending

This is a separate personal/local OSS test on the Mac. It is not a remote runner deployment or a statement that the Cloudflare hybrid is eligible. The existing fake runner and production pi-chat defaults remain unchanged. Do not run privileged actions until the owner has given action-time approval.

## Concrete approval request

Approve registering **pi-durable-cloudflare-chat** as a local OSS client through OpenAI’s `dynamic_agent_client` flow on this Mac, selecting the intended ChatGPT account/workspace, and granting exactly:

`openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`

The resource is `https://api.openai.com/v1`. The system browser authorizes at `https://auth.openai.com/api/accounts/authorize`; the callback is `http://127.0.0.1:<available-port>/auth/callback`. The local CLI exchanges the code directly at OpenAI’s documented token endpoint, verifies the signed ID token against OpenAI JWKS (issuer, issued-client audience, expiry, nonce and subject), and saves the issued client ID, validated identity, tokens/scopes and expiry in `.runtime/local-siwc/credentials.json` (0600). A distinct stable Mac host ID is retained in the same private ignored directory. This is persistent OAuth access, even though the diagnostic itself never refreshes. No credentials go to the Worker, DGX, repository, chat, or another service.

Returning sign-in reuses the issued client ID, verifies the original subject, and omits `id_token_hint` from the displayed authorization URL to prevent token logging. It may therefore show the account selector. Do not paste callback URLs, codes or credentials into chat. The CLI prints no callback/token/provider error text. No client secret or API key is used. Decline paid credits and do not authorize a different billing option if offered.

The owner must separately approve the one-shot diagnostic, which performs one account-specific model-catalog GET and, only if actually listed, **at most two `gpt-6.1-sol` requests for one fixed `test_status` tool round-trip and one `gpt-6-luna` text request**. Tool execution only returns an in-memory marker. No files, shell, web tools, private context, API-key fallback, paid-credit opt-in, automatic refresh or retries. Receiving `response.completed` is required; interrupted/incomplete/failed streams fail. Global deadline 240s, per-model deadline 120s, 64 KiB received per inference response, 256 KiB catalog limit. No provider-side token ceiling is claimed: SIWC currently rejects `max_output_tokens`.

## Commands (prepared, not authorized/executed live)

```sh
# Safe: displays the plan, creates no state and does no networking.
node --import tsx services/model-runner/local-siwc.ts --plan

# Only after explicit approval to create the OAuth registration/credentials:
node --import tsx services/model-runner/local-siwc.ts --sign-in --approved-local-oauth

# Only after explicit approval for this bounded local model test:
node --import tsx services/model-runner/local-siwc.ts --check --approved-local-check
```

Sign-in starts a loopback listener, then prints a browser authorization URL containing no tokens. Open it in the Mac browser. Refusing consent stops the attempt. The default command is inert; neither privileged action runs implicitly. The diagnostic reads only this new protected local record, not Codex, pi-chat, keychain or environment credentials. It does not refresh; expiration requires a separately approved sign-in action. The one-shot dispatch fence `.runtime/local-siwc/diagnostic-rounds.jsonl` prevents replay after success, failure or disconnect. Do not delete it to retry uncertain work. Reports contain exact catalog slug/display names and bounded status metadata; generated text, reasoning and tokens are never logged.

`siwc-check.ts` reuses Pi 1.1.0’s native Responses serializer/parser. Its fixed `onPayload` constructs a documented minimal body, uses `additional_tools` input items for the fixed function, sends full history rather than `previous_response_id`, and omits unsupported options. `siwc-auth.ts` replaces the pinned OAuth helper for this test because the latter only checks ID-token presence and does not verify its signature/claims; the pinned helper also always re-registers a client. No dependencies were upgraded or patched for this local test.

Offline tests cover callback abuse/replay, new/returning client IDs, ID-token signatures/issuer/audience/expiry/nonce/identity, granted scopes, discovered vs missing models, wire fields/tool continuation, HTTP failure/no-retry and approval/key/expiry fail-closed behavior. They establish no live entitlement or compatibility. **No actual model catalog has been discovered yet.**

Official guidance read October 18, 2026:
- [OSS/local scope](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

Production wiring, remote authentication, VM credential transfer and hosted eligibility are outside this local action. No interest form is submitted. The new code remains local until separately approved for publication.
