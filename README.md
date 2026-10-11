# Private Pi on Cloudflare

A small, owner-only mobile web chat using Cloudflare's official PiHarness integration (Agents 0.28.0; Pi Durable/Pi AI 1.1.0). Deployed as an owner-only prototype behind Cloudflare Access. A separately approved subscription device connection is stored encrypted in the Durable Object; further login is disabled and model use is enabled for user-submitted chats. Live model responses and real-cloud recovery remain unverified. No existing local subscription credentials were read or copied, and no artificial live model prompts were sent.

## What is implemented

- Sol orchestrator (`gpt-6-sol`, subscription provider) with optional durable Luna (`gpt-6-luna`) delegation, no external-action tools.
- Durable Object SQLite conversations and official Lifecycle alarm recovery.
- HTTP/SSE streaming, fresh snapshot on reconnect, persistent selectable chats. Closing the tab does not cancel the run; Stop explicitly aborts it.
- Every asset and API request must pass Access JWT signature, issuer, audience, expiry and exact owner-email checks. Mutations require same-origin JSON. Missing configuration denies access.
- OAuth tokens never go to the browser. AES-256-GCM credentials at rest, random IV per update, provider-bound authenticated data, serialized refresh rotation. Encryption key is a Cloudflare secret. Credentials are decrypted in Worker memory when needed. Cloudflare/account administrators with secret/runtime access remain trusted; this is not end-to-end encryption from Cloudflare. Chats reside in Cloudflare's managed SQLite storage.
- No logs/analytics enabled. Raw model/provider errors, thinking content, tools and OAuth tokens are excluded from browser event output. User/model text is rendered with textContent, never HTML.
- Default flags disable model calls and new OAuth grants. A 150-attempt/day guard applies to every generation including recovery; 50 submitted messages/day, 12,000 input characters, at most 100 sessions, and three SSE connections. The subscription backend ignores Pi’s maxTokens option, so there is no enforced per-response output-token cap. These are operational safeguards, not guaranteed monetary caps or an exact token budget. SSE keeps a Durable Object active; close unused tabs. Free-tier hard limits can interrupt service.

## Verification

`npm ci --cache=/tmp/pi-npm-cache`

`npm run typecheck`

`npm test`

`HOME=/tmp/pi-cloudflare-home XDG_CONFIG_HOME=/tmp/pi-cloudflare-home/.config WRANGLER_SEND_METRICS=false npm run build`

Build is `wrangler deploy --dry-run` and does not publish. Local scripts default to no model credentials. Unit tests use faux models and generated test-only JWT keys. See `tests/` for all checks. Workerd tests, if available, fake all provider fetches.

## Deployment and approvals still required

1. Confirm the Cloudflare account, Free vs Paid plan, hostname, and owner's exact allowed email. Do not upgrade or enable paid services implicitly.
2. The deployer may start Wrangler's device login only after the user approves the new persistent deployment grant: `npx wrangler login --device --browser=false` (installed 4.149.0 supports it). User opens the official link and approves on their phone. Never ask for API tokens in chat. Narrow requested scopes to Worker deployment/DO needs; Access policies require separate dashboard setup because Wrangler OAuth does not provide Access management scope.
3. Deploy with model/login flags false. Default configuration disables workers.dev and preview URLs. For workers.dev deployment deliberately set workers_dev true, obtain the exact hostname, and set APP_ORIGIN to its HTTPS origin. Alternatively configure an authorized custom domain. Code denies all requests until Access variables are valid.
4. In Cloudflare Zero Trust, create an Access application for the exact hostname (or enable Worker-level Access for all entry points). Use an existing identity provider or email One-time PIN. Allow only the owner's exact email, never Everyone or an OTP-method-only Include policy. Zero Trust Free covers up to 50 users but may require user-entered payment details during enrollment.
5. Set nonsecret variables ACCESS_TEAM_DOMAIN (`https://TEAM.cloudflareaccess.com`), ACCESS_AUD (application audience), OWNER_EMAILS, APP_ORIGIN. Keep previews disabled. Validate an unauthenticated request is denied and a different email is denied before enabling model use. Static assets run Worker first so cannot bypass code-level authentication.
6. With explicit authorization to create/store credentials, generate a random 32-byte base64 CREDENTIAL_ENCRYPTION_KEY directly in the deployment environment and store using `wrangler secret put`; do not display it, attach it or paste into chat. Keep the same key for existing encrypted records. It protects database snapshots from disclosure without also compromising the secret, but does not protect against a compromised authorized runtime.
7. New subscription device login is a separate persistent model-access grant. Only enable after user approval and runtime verification; user completes OpenAI consent themselves on the official provider page. Existing local subscription tokens are not imported. Device sign-in from Workers has been observed to succeed for the owner; model transport, refresh, provider policy and broader subscription eligibility still need live verification. No claim is made that Workers-hosted subscription access is guaranteed by OpenAI.
8. Use a user-submitted small first prompt to verify model compatibility before relying on normal use, then separately verify recovery within the approved model budget. Enabling ENABLE_MODEL and a successful deploy do not prove live model compatibility.

## Important limitations

There is no in-app Disconnect or credential-revocation control yet. Before enabling normal use, decide how you will disable the deployment and revoke the provider grant. To stop future/recovered model requests, set ENABLE_MODEL false and redeploy; stop any active request first. Revoke subscription access through the provider’s official account security controls. Deleting the encryption secret does not revoke the provider grant. An in-app disconnect is a pending feature.


PiHarness is beta. The subscription OAuth implementation comes from Pi's internal pinned module through `src/oauth-loader.ts`, because its CLI-oriented variable dynamic import is not bundled by Wrangler. Device-code path is selected; callback-server flow is never selected. This is an application compatibility adapter, not an official Cloudflare OAuth template. Review it on SDK upgrades.

Pi Durable currently cannot delete individual conversations and has no tool approval step. No consequential-action tools are installed. Recovery may repeat interrupted model calls and replay-safe delegation. Credentials refresh is serialized within the single owner's Durable Object; all sessions must keep sharing that object. Session compaction is disabled in this bounded prototype; start a new chat when context grows too large.

There is no proof of real-cloud eviction recovery in this project until deployed and tested. Local faux tests establish software behavior, not provider entitlement or production availability. SSE reconnections refresh the JWT check; a stream is bounded to 55 seconds.

## Official sources checked 2026-10-11

- PiHarness, storage, streaming, recovery and limitations: https://developers.cloudflare.com/agents/harnesses/pi/
- Access Worker settings and WebSocket limitation: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- JWT verification: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- Access policies: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/
- Zero Trust setup: https://developers.cloudflare.com/cloudflare-one/setup/
- OTP: https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
- Phone-friendly Wrangler device login: https://developers.cloudflare.com/workers/wrangler/commands/general/
- Assets authentication routing: https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
- Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- SQLite Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/

Workers Free includes 100,000 requests/day and 10 ms Worker CPU/invocation; SQLite DO Free includes 100,000 requests/day, 13,000 GB-s/day, 5 million rows read/day, 100,000 rows written/day and 5 GB. Paid Workers starts at $5/month; model subscription/provider usage is separate. Exact workload fit on Free needs measurement. No paid-plan changes have been authorized here.

Owner identity can be configured with `OWNER_EMAILS`, a comma-separated list of exact email addresses. Matching is case-insensitive; domains, wildcards, malformed entries and empty entries are rejected. `OWNER_EMAIL` remains a backwards-compatible singleton fallback when the plural setting is blank or absent. A configured plural list takes precedence. Every allowed identity shares the existing `private-owner-v1` Durable Object, conversations and credential store; this is one owner's workspace accessible through multiple verified addresses, not a multi-user tenancy system. Keep personal addresses in deployment settings, never public source.
