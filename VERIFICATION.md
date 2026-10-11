# Verification record

Prepared 2026-10-11. The initial source-build checks below did not include deployment or a real subscription grant; later separately authorized deployment and sign-in checks are recorded at the end. No existing local credentials were read/copied or artificial live model prompts sent.

Passed on the initially reviewed source:
- TypeScript strict typecheck (`npm run typecheck`)
- 18 offline automated tests (`npm test`)
- Wrangler dry-run bundle: 1,263.30 KiB uncompressed / 244.82 KiB gzip
- JavaScript syntax check for browser app

Automated coverage:
- Access owner signature/issuer/audience/expiry and wrong-owner rejection; absent config/token and mutation CSRF denial
- AES-GCM ciphertext, tamper detection, provider binding, refresh serialization, cancellation, deletion ordering
- Device-code status sanitization, stable host identity, concurrent login exclusion and retries
- Real local workerd DurableObjectStorage: actual SDK device login and rotating OAuth refresh with synthetic upstream responses only
- Faux Sol → Luna → Sol delegation
- Transport-boundary disabled/exhausted model guard proves zero provider calls, and forwards an allowed response before refusing exhaustion
- Streaming text projection and reconnect deduplication
- Whole app in local workerd: owner JWT can access status and create/persist sessions and receive SSE; unsigned access denied; model/login disabled by default

Miniflare's optional synthetic request.cf lookup was discovered to fetch workers.cloudflare.com/cf.json. Both runtime test configurations explicitly set cf:false, preventing that auxiliary network request. Tests replace provider and JWT-key fetches with local synthetic replies and throw on unexpected destinations.

Not verified during the initial build:
- Mobile/desktop visual rendering: Chromium cannot launch in this environment because local socket creation is prohibited, including after an approved escalation. `tests/ui.mjs` is a portable mocked browser smoke test, not a claimed visual pass; no screenshots were produced.
- Live subscription entitlement, OpenAI network acceptance from Cloudflare, production Access policy configuration or actual deployment
- Real-cloud crash/eviction recovery; relies on official PiHarness implementation until an authorized deployment test
- A guaranteed Free-tier workload fit or exact monetary/token ceiling. The subscription backend ignores Pi's maxTokens option; only request/message admission limits are claimed.

Security review found two important issues during development: Pi's extension hooks swallow exceptions, and the subscription backend ignores maxTokens. Both are reflected in final code and documentation: model permission/budget guards now run before the actual Models transport/auth dispatch, and no output-token cap is claimed.

## Mac publication checks — 2026-10-11

Before public source publication, Node.js 26.4.0 on macOS passed:
- All 18 offline automated tests (`npm test`)
- Strict TypeScript typecheck (`npm run typecheck`)
- Browser JavaScript syntax (`node --check public/app.js`)
- Wrangler 4.149.0 dry-run bundle: 1,263.30 KiB / 244.52 KiB gzip

MIT license and root package/lockfile license metadata were applied. The source-only publication list was scanned for credentials and personal details; credential-like test values are synthetic. Model and subscription-login flags remain false. These checks do not verify UI visual rendering, live Cloudflare recovery, deployment, or live provider access. No new OAuth grant was requested.

## Multiple owner addresses — 2026-10-11

The app accepts a configured comma-separated OWNER_EMAILS exact allowlist, retaining OWNER_EMAIL singleton compatibility. Twenty offline tests pass, including both synthetic allowed addresses, outsider denial, malformed configuration denial, and real local workerd proof that two distinct signed identities see the same persisted session. Typecheck, synthetic deployment config validation and Wrangler dry-run passed. Personal addresses are absent from source. These checks do not establish live Cloudflare Access behavior or recovery.

## Authorized live setup and deployment — 2026-10-11

- Latest code passes 22 offline tests, strict typecheck, browser JavaScript syntax, Wrangler dry-run, and independent GitHub CI on Node 24.
- Public source uses MIT licensing and contains no credentials or personal Access configuration.
- Manual deployment validates the dispatched main commit. The owner removed the separate production reviewer gate; the main-only deployment policy remains.
- User personally provisioned the encryption secret and completed official OpenAI device consent. The app confirmed subscription connection; tokens and the encryption key were not read or copied by the assistant.
- Encrypted subscription connection and the existing chat survived a subsequent code deployment. This is persistence across deployment, not proof of crash/eviction recovery.
- Final runtime shows Connected with setup/login controls hidden. Production configuration has ENABLE_SUBSCRIPTION_LOGIN=false and ENABLE_MODEL=true for user-submitted chats only.
- Unsigned requests to the homepage and status API returned Cloudflare 403 responses. The authenticated browser had previously reached the correct Access email-code sign-in page.
- Config-only flag changes were observed to retain old bindings in a running Durable Object. The deployment script now embeds a non-secret mode marker in the Worker bundle to replace running code when the mode changes. Existing storage and secrets are preserved.

Still unverified: live model responses, real provider token refresh, crash/eviction recovery, comprehensive mobile/desktop visual QA, and exact cost/token limits. No artificial model prompt was sent.

## Public-source tool implementation — 2026-10-11

Forty-one offline tests pass, including actual Pi harness execution with a faux model and mocked GitHub transport, concurrent budget reservations, failed-request accounting, cache/memo reuse, URL/credential rejection, fixed basic Tavily settings, output and response bounds, cancellation, public-only repository checking, and UI activity sanitization. Existing workerd auth/credential tests continue to pass. Typecheck, browser syntax and Wrangler dry-run pass on this Mac. The workerd tests require authorized local socket listeners; provider traffic is mocked.

A separate security reviewer found no blocking issues after encoded-secret and hostname-alias hardening. Known limits are recorded in README: public-DNS classification, heuristic private-query screening, provider extraction boundary and shared-account billing. One unauthenticated GitHub read-tool smoke test retrieved this public repository's metadata. No real Tavily call, model prompt, private repository token, key value access or billing change occurred. Tavily defaults off until user key provisioning and separately approved live test/enablement.
