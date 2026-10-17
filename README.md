# Private Pi on Cloudflare

A small, owner-only mobile web chat using Cloudflare's official PiHarness integration (Agents 0.28.0; Pi Durable/Pi AI 1.1.0). Deployed as an owner-only prototype behind Cloudflare Access. A separately approved subscription device connection is stored encrypted in the Durable Object; further login is disabled and model use is enabled for user-submitted chats. Live model responses and real-cloud recovery remain unverified. No existing local subscription credentials were read or copied, and no artificial live model prompts were sent.

## What is implemented

- New chats use the connected Grok subscription model `grok-4.7` when Grok is enabled; optional tool-less delegates use that same model. Existing chats retain their persisted model selections, including Codex Sol with Luna delegation. Provider-aware connection and model labels appear in the chat UI. No conversation history or credentials are migrated.
- Durable Object SQLite conversations and official Lifecycle alarm recovery.
- HTTP/SSE streaming, fresh snapshot on reconnect, persistent selectable chats. Closing the tab does not cancel the run; Stop explicitly aborts it.
- Every asset and API request must pass Access JWT signature, issuer, audience, expiry and exact owner-email checks. Mutations require same-origin JSON. Missing configuration denies access.
- OAuth tokens never go to the browser. AES-256-GCM credentials at rest, random IV per update, provider-bound authenticated data, serialized refresh rotation. Encryption key is a Cloudflare secret. Credentials are decrypted in Worker memory when needed. Cloudflare/account administrators with secret/runtime access remain trusted; this is not end-to-end encryption from Cloudflare. Chats reside in Cloudflare's managed SQLite storage.
- No logs/analytics enabled. Raw model/provider errors, thinking content, tool arguments/outputs and OAuth tokens are excluded from browser event output. Selected public source titles and links are exposed as bounded tool evidence. User/model Markdown is rendered through an explicit DOM allowlist with text nodes. Raw HTML stays inert; HTTP, HTTPS and mailto links are clickable. Images remain text placeholders and load no remote resources.
- Default flags disable model calls and new OAuth grants. A 150-attempt/day guard applies to every generation including recovery; 50 submitted messages/day, 12,000 input characters, at most 100 active top-level chats for new-chat creation, and three SSE connections. The subscription backend ignores Pi’s maxTokens option, so there is no enforced per-response output-token cap. These are operational safeguards, not guaranteed monetary caps or an exact token budget. SSE keeps a Durable Object active; close unused tabs. Free-tier hard limits can interrupt service.

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

## Public-source tools

Sol can use `web_search(query)` and `fetch_page(url)` through Tavily basic search/extraction, plus `github_search(kind, query, repo?)` and `github_read(repo, kind, path?, ref?, number?)` through unauthenticated GitHub REST. GitHub search kinds are repositories and issues (including PRs); read kinds are repository, file/directory, issue and pull_request. Code search, comments/diffs, private repository access and writes are not implemented. The project's own public repository is supported. Returned sources carry URLs; files carry blob SHAs. Luna receives selected public excerpts from Sol and has no tools.

Search requires the Cloudflare Worker Secret `TAVILY_API_KEY` AND nonsecret deployment variable `ENABLE_WEB_SEARCH=true`. Default is false even if a key exists. The user personally provisions the key; never paste it into chat, commits, logs or GitHub configuration. No GitHub token is accepted. Model credentials and Access identities are unchanged. The manual deployment workflow reads ENABLE_WEB_SEARCH from the production GitHub environment; setting only a dashboard variable is not sufficient for subsequent workflow deployments. The bundle mode marker includes the web flag so changes replace running Durable Object code.

Before enabling search, confirm the provider account's remaining credits and billing limits, especially if its key is shared. This app atomically reserves one conservative credit per attempted Tavily request, including extraction and failures, with caps of 20/day and 500/calendar month. These limits apply only to this app and do not guarantee zero spend on a shared account. No paid account upgrade or live Tavily test is included in source validation.

All chats and owner identities share durable budgets and a bounded 256-slot five-minute cache. GitHub reserves up to 40 HTTP requests/hour and 200/day, and 8 search requests/minute; metadata public-repo checks count too. Upstream IP-based limits may still reject reads. Quotas use UTC calendar periods, failures retain reservations, and caches can evict on collisions. Pi per-call memoization retains completed results; Tavily is replay-unsafe to prevent automatic repeats of interrupted billable calls. GitHub is replay-safe, so an interrupted request can repeat within its durable budgets. Exactly-once external execution is not claimed.

Endpoints are fixed to api.tavily.com and api.github.com, redirects are rejected, requests time out after 12 seconds and respect cancellation, upstream JSON is capped at 256 KiB, and model output is capped with truncation indicators. Small regular GitHub files must decode as UTF-8, with binary/symlink content refused. No arbitrary page is directly fetched or executed by the Worker: fetch_page sends one validated public HTTPS URL to Tavily's extraction endpoint. IP literals, obvious local/embedded-IP aliases, URL credentials and suspicious secret query fields/paths are blocked. DNS names alone cannot prove a resource is public; provider fetching protections remain part of that boundary.

Retrieved pages, files and tool content are untrusted evidence, never instructions. The system prohibits forwarding private code, transcripts, personal information or credentials into search/extraction. Pattern screening catches common credential forms; it cannot prove an arbitrary query contains no private information. Tools have no permission/approval UI, so users should limit requests to public information. Private tool cards show recorded input context, bounded output and tool diagnostics, with targeted masking of credential values. Hidden model reasoning is never displayed.

Official API references: https://docs.tavily.com/documentation/api-reference/endpoint/search ; https://docs.tavily.com/documentation/api-reference/endpoint/extract ; https://docs.tavily.com/documentation/api-credits ; https://docs.github.com/en/rest/search/search ; https://docs.github.com/en/rest/repos/contents

### One-time owner search check

With separately approved test scope, `ENABLE_WEB_SEARCH_TEST=true` exposes an owner-only button for one basic search for Cloudflare PiHarness documentation and one extraction of the official public Pi page. It uses the saved server-side key, bypasses cache, invokes no model and reserves up to two conservative credits through existing quotas. Web-search test mode and normal ENABLE_WEB_SEARCH cannot both be enabled. A durable one-shot claim is written before either call; duplicate requests, errors and interruptions cannot repeat it. Failed search prevents extraction, and provider credit-limit errors have no paid fallback. Client disconnection can leave the check running or permanently claimed; do not retry it. Results retain only source/count/length and provider-reported credit metadata, never the key. After a successful check, disable test mode and enable normal web search through the reviewed deployment workflow.

Tool calls appear as compact expandable rows beside their related response, including Luna delegation. Recorded call/result IDs and user-turn boundaries place completed rounds beneath the following assistant text or streamed reply; multiple rounds stay distinct. Pending or historically unlinked calls remain beside their originating segment. Verified pending/running/completed/failed/interrupted states survive history reload; missing historical results are labeled unavailable. Public reads show selected recorded source titles, counts and links; safe repository descriptions can provide a short result summary. Query parameters are omitted from source links, credential-bearing URLs and secret-like metadata are rejected, and no page/file bodies, excerpts or Luna outputs are published. Older or malformed/truncated envelopes without metadata say no source details were recorded. Duration and truncation sit behind a secondary disclosure. Tool arguments, raw outputs, error strings, diagnostics and hidden reasoning are excluded.

The composer starts at one line and grows with drafts to a bounded height. Privacy and model notes are available through About this chat. Conversation titles use deterministic excerpts of visible user text, with common credential forms excluded; explicit renames take priority and persist in the owner's existing object. Legacy conversations acquire a displayed title when opened; unopened legacy chats retain an Untitled conversation label. No model call generates titles. Keyboard focus, expanded tool rows and reader position survive incoming history updates. Changes await separate deployment approval.

## Disposable project workspace (disabled)

The optional trusted-project workspace V1 keeps Sol and credentials in the app and delegates typed file/process operations to a separate task-scoped Sandbox DO. It remains disabled in the existing production configuration. See [WORKSPACE.md](WORKSPACE.md) for owner controls, generous independent deadlines, cancellation/export behavior and explicit local-versus-Cloudflare verification limits. Image publication, provisioning and activation require separate approval.

Grok new-chat integration: `GROK_CHAT_MODEL` can select another ID from the pinned xAI catalog; the default is `grok-4.7`. With Grok disabled, new chats retain the Codex default. With Grok enabled but disconnected, new chat creation requires connecting Grok and does not silently fall back to Codex. The normal harness uses the OAuth-only Worker provider and encrypted credential refresh. Existing bounded setup-test evidence remains immutable; future newly reserved reports record the selected model.

Chat history uses a compact modal drawer. The last opened chat ID and bounded recent-ID timestamps are remembered on the device; a valid explicit `?session=` URL takes priority. Drafts are held per chat in memory only. Missing or deleted selections fall back safely, without leaving the previous chat stream attached.

Delete moves a top-level chat to Recently deleted by adding a timestamp marker. Undo and Restore remove that marker; model selections, transcript entries, credentials and workspace records are retained. There is no permanent-delete or automatic-purge action. New-chat creation is capped at 100 active top-level chats; deleted chats and delegates do not count. Restoration is always allowed, including above 100 active chats; new creation stays blocked until the active count falls below 100. Busy/queued responses and open workspaces must finish or close before deletion. No live user chats were deleted during validation.

## UI icons

The chat, history, workspace and diagnostic controls use a small vendored subset of [Lucide](https://lucide.dev/guide/lucide), pinned to 1.57.0 (`dab294f313897bacaa968b725b3259fa37c17bd1`). Both refresh controls use [refresh-cw](https://lucide.dev/icons/refresh-cw). Original SVGs and the complete ISC/Feather MIT notices are in `vendor/lucide`; `build:ui` generates the inline sprite and `check:ui` checks it. No runtime CDN or icon dependency is used. Icons are decorative; controls retain labels, focus styling, touch targets and reduced-motion loading feedback.

## Internal ownership boundaries

`Assistant` composes HTTP validation, authentication, POST scheduling and the Pi runtime. `SubmissionAdmission.submit({sessionId, operationId, text})` owns exact-text operation binding, the existing daily attempt reservation and receipt persistence. It relies on the caller’s POST queue and SDK request-ID deduplication; chat/provider gates, cancellation routing and auto-title policy remain outside. `ChatCatalog` owns ownerless top-level chat membership, titles, tombstones and the active-chat creation limit. `WorkspaceCoordinator` owns chat/workspace identity mappings and safe automatic activation for read/edit/exec, with durable operation bindings and cancellation intent; `WorkspaceController` and its adapter retain execution, journals, deadlines, alarms and cleanup. `HistoryFeed` owns history subscriptions, stream limits, close-before-open markers and lease cleanup; `ChatProjection` remains a pure event projection.

The browser `createChatSession` controller owns selected-chat policy, device selection memory, per-chat in-memory drafts and submission operation identities. Its snapshots drive DOM rendering; `createHistoryClient` separately owns history transport and leases. The projection declares `failureState` explicitly, and `historyPresentation` confines compatibility parsing for older saved/projected history. Failed submission retries retain their operation ID across chat switches; reload persistence is unchanged.


Existing durable keys and namespaces are preserved; automatic activation adds operation-binding, predecessor-reference and stop-intent keys described in `WORKSPACE.md`. Catalog mutations and workspace opening must retain the Assistant POST admission queue. Workspace cancel/extend and history close must bypass that queue so they can interrupt slow setup. Restore remains allowed above the new-chat creation cap. Chat APIs now consistently reject missing and delegated conversation IDs rather than applying weaker parent-only checks in selected routes.

Projection messages add a safe `failure` object (`kind`, classified diagnostic fields, recovery action). The browser prefers it for recovery UI; legacy human-readable error fields remain compatible with older clients and saved-history renderers. Raw provider errors are not part of this DTO. Workspace page restoration restarts one polling timer and performs a refresh. Malformed/non-object JSON requests return 400 rather than unexpected-failure 500.

`ProviderSessions` owns subscription availability, default/new-chat policy, public connection status and device-login stream lifetimes. Shared model policy in `chat-model.ts` keeps saved model choices intact and makes delegation follow the same rules as status reporting. It registers only the explicitly bundled Worker OAuth providers; host environment/file credential lookup stays disabled. The existing encrypted credential store still owns credential persistence and refresh serialization. Ordinary model attempts remain guarded at actual dispatch in `Assistant`, while the explicitly approved fixed Grok check retains its isolated model registry, one-shot storage keys, strict request budget and SQL-readable non-secret evidence. HTTP authentication, request validation and the Assistant admission queue remain at the boundary.

## Tool cards

Each response-local tool call has one native disclosure. Its collapsed card shows the tool, state, actual command/query/file/repository context and a concise recorded result or error. Expansion shows input, output, source links and timing directly, without nested recorded-actions or Read details disclosures. Ordinary commands, paths, public excerpts, file/log text and tool diagnostics are retained. Display excerpts are bounded (4,000 input and 12,000 output characters) and explicitly marked when truncated; existing upstream truncation remains indicated. No reasoning blocks are projected.

Display masking targets credential keys/assignments, authorization and cookie values, recognizable tokens/private keys, credential-bearing command flags and URL parameters. It does not replace outbound-request policy or diagnostic-log sanitization. Untrusted tool content is rendered as inert text; authentication and tool execution permissions are unchanged. Legacy records without text show that absence explicitly.
