# Deploy from your own computer

The reviewed source has been published and deployed behind Cloudflare Access. Live subscription login, model responses, and recovery still require verification. This package contains no Cloudflare or subscription credentials. The commands below document a separate manual setup path; the current deployment uses the manual GitHub Actions workflow.

## 1. Install and check

Use Node.js 24+ and unzip this folder.

    npm ci
    npm run typecheck
    npm test
    npm run build

`build` is only a local dry run. Tests replace all model/OAuth network calls with synthetic responses. Optional browser QA is `node tests/ui.mjs` and requires Chromium at `/usr/bin/chromium`; adjust that executable path for your machine. Browser QA could not run in the assistant's restricted environment.

## 2. Sign in to Cloudflare yourself

    npx wrangler login --device --browser=false

Read the requested grant in Cloudflare before accepting. This saves deployment access on your computer. Do not share the saved token. You can also use ordinary `npx wrangler login` for a same-computer browser.

Stay on Workers Free unless you deliberately choose a paid plan. There is no automatic paid upgrade in this project. Free limits may stop the app; a long-lived chat workload still consumes Durable Object duration.

## 3. Set up your exact private hostname

In Cloudflare's Workers & Pages dashboard, find your account's workers.dev subdomain. With this project's name, the hostname will be `pi-private-chat.YOUR-SUBDOMAIN.workers.dev`. Confirm it in the dashboard; do not guess your account subdomain.

In Zero Trust, create an Access application for that exact hostname. Select a Free plan if appropriate. Enrollment may require entering payment details yourself. Add your existing login provider or email One-time PIN, and create an Allow policy that includes only your exact email address. An OTP-only Include condition is not an owner allowlist.

Copy the application's AUD and your team's domain. In wrangler.jsonc, set:

- ACCESS_TEAM_DOMAIN: https://YOUR-TEAM.cloudflareaccess.com
- ACCESS_AUD: the application's audience tag
- OWNER_EMAILS: your exact allowed email
- APP_ORIGIN: https://pi-private-chat.YOUR-SUBDOMAIN.workers.dev
- workers_dev: true
- Keep preview_urls false, ENABLE_MODEL false and ENABLE_SUBSCRIPTION_LOGIN false

For a custom domain use its exact HTTPS origin and dashboard-managed binding; disable workers_dev only after owner verification. Both the outer Worker and its Durable Object validate Access again. No production local-auth bypass exists.

## 4. Create the encryption secret and deploy

This key encrypts future subscription tokens. Review the storage/trust notes in README first. Generate directly into Wrangler without displaying or saving it in a file:

    node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))" | npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
    npx wrangler deploy

If Wrangler requires creating the Worker first, run `npx wrangler deploy` with both ENABLE flags still false, then set the secret and redeploy. Missing secret returns a generic configuration error and cannot run a model. Never replace a configured encryption key casually: existing credentials would become unreadable.

Check the address in a private browser window. You must be sent through Access, and a different email must be denied. Confirm the owner can see sessions but cannot send a model message yet. An unsigned direct request must not return chat history or assets.

## 5. Connect a fresh subscription, separately

This creates new persistent OpenAI subscription access stored in your Cloudflare account. Do this only if you want that grant and have checked your subscription/provider terms. Existing local Pi credentials are not imported.

Set ENABLE_SUBSCRIPTION_LOGIN to true, redeploy, and click Connect subscription in the owner-only app. Keep the chat page open while you open the displayed official OpenAI device-verification link in another tab. Complete the consent yourself. The stream keeps login alive for up to five minutes; if interrupted, retry. Tokens stay server-side.

The device-code and rotating-refresh paths were tested with fake responses in a real local Workers runtime. Real provider acceptance, entitlement and Cloudflare-network compatibility remain untested. If live login fails, do not paste tokens or use an unofficial endpoint.

After connection, set ENABLE_SUBSCRIPTION_LOGIN false again and set ENABLE_MODEL true only when you are ready for a small live test. Deploy and send one short prompt. Model usage counts against the relevant subscription/provider limits. The 150-attempt/day guard is not a token/dollar cap; the subscription backend does not enforce Pi's maxTokens option.

## 6. Verify and stop safely

This is a setup preview. There is no in-app Disconnect/revoke button yet; deployment-side disable and provider-side revocation are required. Confirm you are comfortable with those controls before enabling normal use.


Reload to verify chat persistence. Test Stop. Only then consider a separately budgeted recovery test. There has been no real-cloud crash/eviction test yet.

To disable new and recovered model requests, set ENABLE_MODEL false and redeploy. Stop any active run first where possible. To revoke provider access, use the provider's official account security controls; to revoke deployment access, use Cloudflare's account controls. Do not delete the encryption secret as a substitute for provider revocation.

Read README.md for architecture, limits and official links.

## GitHub Actions: checks and manual production deployment

`.github/workflows/ci.yml` runs secret-free checks on main pushes and pull requests, including forks. It uses Node 24 LTS, `npm ci`, strict typecheck, offline tests, browser JavaScript syntax checking, and the Wrangler dry-run build. Actions are pinned to full commits; tooling comes from package-lock.json.

`.github/workflows/deploy.yml` runs only when manually dispatched on main. It validates the exact dispatch commit, then deploys that same commit through the GitHub `production` environment. Deployments are serialized; a new run does not cancel an active deployment. GitHub concurrency can replace an older pending run, so review the actual run SHA. The workflow token has only contents read access; no PR receives Cloudflare credentials, and checkout does not persist GitHub credentials.

The environment is restricted to branch main. Its separate required-reviewer gate has been removed by the owner; manual workflow dispatch remains required. Administrator bypass remains disabled. CI validation must succeed before the deploy job runs.

Before any manual deployment:

1. Confirm the intended Cloudflare account and current Workers plan, and inspect any existing `pi-private-chat` Worker before overwriting it. Confirm its exact workers.dev hostname. No paid upgrade is part of this pipeline.
2. Create or verify an Access application for that exact hostname and an Allow policy restricted to the owner's exact email. New Access/security settings require separate approval. An OTP-method-only policy does not restrict access to the owner.
3. In Cloudflare, create a dedicated API token with Account → Workers Scripts → Edit, restricted to the intended account. This gives account-level Workers authority, not single-Worker isolation. No KV, R2, D1, Pages, Zone or Access-management permission is needed for this initial workers.dev configuration. If Cloudflare reports another permission requirement, review it before expanding the token. Set an appropriate expiry and rotate/revoke through Cloudflare.
4. Enter the token yourself directly into GitHub Settings → Environments → production → Environment secrets as `CLOUDFLARE_API_TOKEN`. Never send it in chat or commit it. Add `OWNER_EMAILS` as another environment secret containing the comma-separated exact owner address list, to keep personal configuration out of public source.
5. Add environment variables `CLOUDFLARE_ACCOUNT_ID` (32-character account ID), `ACCESS_TEAM_DOMAIN` (exact HTTPS team origin without trailing slash), `ACCESS_AUD` (Access application's 64-character audience), and `APP_ORIGIN` (exact `https://pi-private-chat.YOUR-SUBDOMAIN.workers.dev` origin without trailing slash). These values are used only in an ignored temporary configuration, removed after deployment. Do not upload that file or build artifacts containing it.
6. Review the intended deployment and commit, then choose Actions → Deploy production manually → Run workflow → main. There is no separate environment review click. This pipeline reads strict true/false ENABLE_MODEL and ENABLE_SUBSCRIPTION_LOGIN production environment variables, defaulting both to false, and rejects enabling both together. Use login=true/model=false only for approved setup; after verified connection use login=false/model=true. Keep these GitHub variables in sync with approved dashboard changes before future deployments. Existing secrets are preserved. The generated config also embeds a non-secret deployment-mode marker in the bundle, so a mode change replaces running Durable Object code and refreshes its environment bindings; persistent chats and encrypted credentials remain intact. Previews and observability stay off, and workers.dev is enabled only for the configured origin. It does not create or modify Access policies. The configured hostname must match the actual Cloudflare hostname; verify after deployment.
7. Verify unsigned access is denied and the owner-only Access policy works. Before needing credential-backed status/model functions, separately authorize and create the encryption secret directly in Cloudflare as described above. Never rotate an existing key accidentally. The deployment workflow does not create encryption secrets or import subscription credentials. Live subscription login, model enablement, UI visual QA and live recovery require separate work and approval.

Missing production settings stop deployment configuration generation. The temporary configuration keeps the fixed Worker name and SQLite migration from the reviewed source. Custom-domain attachment is managed in the dashboard as described below. Manual dispatch does not make unreviewed code safe: review workflow and source changes before running them.

Cloudflare's documented external CI path requires an API token and account ID; no direct GitHub OIDC exchange is assumed. Workers Builds can manage deployment credentials within Cloudflare, but still requires a Git integration grant and persistent credentials. Neither is connected automatically here.

Official references:
- https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments

For multiple verified addresses belonging to the same owner, use the `OWNER_EMAILS` environment secret with a comma-separated exact list. The Access Allow policy must include exactly the same addresses. Both sign-ins share one workspace. The initial GitHub pipeline requires the plural secret; legacy manual deployments may still use `OWNER_EMAIL` for a singleton. No wildcard or whole-domain policy is permitted for this owner-only app.

## Protected custom-domain cutover

Set production `CUSTOM_DOMAIN` to the exact approved hostname and `APP_ORIGIN` to its HTTPS origin. The generator omits `routes` and `route` so the dashboard-managed binding remains untouched, and rejects credential, port, path, query, wildcard, IP and mismatched-origin configuration. `WORKERS_DEV` defaults to true for initial verification; set it to false only after owner UI/API verification. A configured custom-domain origin is required before disabling workers.dev, and previews remain disabled. The code accepts only APP_ORIGIN, so the old hostname denies application access as soon as the origin changes, even while its platform entry point remains enabled.

Protect the exact hostname in the existing Access app before attaching DNS/Worker routing; preserve the audience, exact owner policy, identity providers and session settings. Dashboard attachment can establish the approved connection first. Creating or changing domain/route connections via API needs zone-scoped Workers Routes Write; an unchanged existing connection can be deployed with existing Workers editor permissions. Never expand grants implicitly. Keep the same Worker, Durable Object namespace/name and credential-encryption secret. The subscription uses device login and needs no app-host callback change. Quiesce idle SSE connections for the origin-marker deployment; preserve unsent drafts. Verify unsigned homepage/API requests fail and an owner can see the existing subscription/chat before retiring the old entry point. Do not send synthetic model prompts or additional provider calls for this cutover.

Installed Wrangler 4.149.0 only invokes publishRoutes/publishCustomDomains when the corresponding route list is nonempty. Omitting both fields skips domain-record PUT/changeset calls; explicit workers_dev controls only that entry point. Keep the binding configured in the dashboard and verify it persists after deployment. This avoids adding zone-routing permissions to the CI token.

Before cutover, inspect existing zone URL rewrite and cache rules. Exclude the exact private-app hostname from public-site rules that append index.html to slash-ending paths: Workers assets redirect /index.html back to /, so combining those behaviors creates a loop. Also exclude that hostname from rules overriding origin cache-control or browser TTL; private responses must retain the Worker's no-store policy. Preserve the original expressions and actions for every other hostname.

## Opt-in workspace deployment

The baseline chat deployment stays separate from Containers. Workspace activation requires verified Workers Paid/Containers availability, a digest-pinned account-scoped image, and reviewed resource/egress authorization. Do not run the manual workflow until the intended target and prerequisites are approved. Its target chooser defaults to `production`; `staging` uses a different fixed Worker and its own GitHub `staging` environment. Configure and protect that environment explicitly before use, restrict its deployment branch to main, and protect the exact staging workers.dev hostname with the approved owner-only Access policy. Do not copy production model credentials or the existing encryption key. Shell-only staging uses a separate entrypoint and Workspaces namespace without importing Assistant/provider credential storage, so no staging encryption key or subscription credential is required. Production credential-store validation remains unchanged.

Use `PROVISION_WORKSPACE=true` to retain the additive Workspaces binding/migration/container configuration and pinned image; `ENABLE_WORKSPACE` separately controls activation. Both default false. Environment inputs are `WORKSPACE_REPOSITORY` and `WORKSPACE_IMAGE_REFERENCE` (full digest-pinned managed-registry URI for this account). Staging forces model/login/web flags false and uses shorter lifecycle defaults for the proposed bounded smoke. The default-false `build_workspace_image` manual input optionally builds/uploads one approved image and resolves its manifest digest; ordinary dispatch uses the pinned image and never buys a plan. The API token additionally needs account-scoped Containers Edit (Write in some permission lists); existing Workers Scripts Edit and Account Settings Read should be verified, not expanded automatically. No routing, Access administration, R2 or billing-write permission is required by this workflow.

Keep provisioning true after first activation, including when turning `ENABLE_WORKSPACE` off, so binding/migration history and cleanup remain present. See [WORKSPACE.md](WORKSPACE.md#deployment-wiring-manual-after-prerequisites-and-approval) for exact inputs, image/namespace separation, the 15-minute staging operator window, cancellation verification and cleanup. Native Cloudflare handles/alarms/lifecycle remain unverified until an approved live smoke passes.

For the approved existing-host rollout, use production directly as described in [WORKSPACE.md](WORKSPACE.md#existing-host-production-smoke): normal tools off, independent owner-only smoke on, preserved provider/auth settings, one pinned image and additive namespace. No separate staging environment, Access app or token entry is needed. Enable normal tools only after real smoke and destruction verification.

## Forward-only Pi maintenance window

The optional draft-PR publisher is a separate service and remains disabled until [its explicit setup](docs/harness-proposals.md#setup-still-requiring-approval) is approved. `ENABLE_HARNESS_PROPOSALS` and `PUBLICATION_ENDPOINT` are nonsecret deployment inputs; its transport key is provisioned separately as a Worker secret. Publishing a proposal never dispatches this deployment workflow or updates the model runner.

The SIWC effort compatibility repair can ship in the Worker before a runner update. Both Worker catalogs explicitly disable `supportsMidConvoEffort` before Pi serialization, keeping selected effort in `reasoning.effort` and excluding subscription-unsupported `configuration_update` items. Existing runners accept these requests. This repair does not require a runner restart or credential changes.

The same source includes a separately deployable runner diagnostic improvement: only allowlisted provider HTTP status/code/parameter values enter its error envelope, and provider HTTP 400 rejections remain application HTTP 400 instead of being wrapped in 502. Deploy the Worker reader/projection first; a later separately authorized runner release enables richer provider details. Until then, saved runner codes and gateway HTTP status still display safely. A gateway that replaces a response body can still remove provider details; do not infer missing metadata or rewrite old failures from correlated logs. This change does not add automatic retries, reopen failed intent, or remove any reservation. No runner deployment is part of the Worker deployment workflow.

This is the approved 1.1 → 1.3 release gate. Code-only downgrade is unsafe: Pi 1.3 can persist tool-task v2 records that 1.1 cannot recover. This procedure keeps all current storage and execution journals and repairs forward. Native bookmarks are diagnostic checkpoints; they do not establish a coordinated restore capability. Never rewind chat data, runner/workspace journals, or dispatch reservations; never clear an ambiguous reservation or use a fresh ID to replay old intent. No restore endpoint or generic SQL control is provided.

1. Verify current main, exact-head CI and current production revision/100% traffic. Preserve the existing Worker, Assistant namespace and `private-owner-v1` name, workspace binding/image, encrypted credentials, runner and security settings. Keep Spark untouched. Do not build another workspace image or send live model/tool work for this window.
2. Before changing code, inspect owner chats and use the existing **Stop** while the 1.1 runtime can still cancel its work. Preserve unsent drafts and avoid new submissions. This first operator drain is best effort; the frozen inspection below is the authoritative gate. A feature flag such as `ENABLE_MODEL=false` alone does not prevent tool or alarm recovery.
3. Dispatch the protected main-only deployment workflow with `maintenance_mode=frozen` (the default) and `build_workspace_image=false`. The preparatory entrypoint imports no Pi/Agents engine, credentials or provider code. Its HTTP and alarm paths cannot open/migrate/resume Pi. TaskWorkspace denies new admission before its serial controller executes; existing cancellation/cleanup remains available. Verify the deployed source revision, version and 100% traffic before continuing. Do not use a gradual mixed-version rollout.
4. Open the owner-authenticated `/maintenance` page and **Pause admission**. The stored window epoch survives restarts; fixed read-only SQL inspects Pi work without opening it. Inspection is capped at 100 tasks/submissions/workspaces and workspace RPCs time out after two seconds; unknown/truncated data blocks progress. No prompt, credential, model output or arbitrary SQL is exposed. Every unfinished generation, compaction, tool task or queued/placed submission blocks capture/resume. Every historical owned workspace must be confirmed `closed` with native container `running=false`; use its existing cancellation path if needed, then refresh. Cancellation retains operation IDs and immutable artifacts.
5. If frozen inspection still finds unsettled Pi work, **stop here**. Frozen mode cannot open Pi to Stop it. Do not call the new 1.3 runtime to drain v1 work. A separately tested compatible 1.1 preparatory drain release may be needed; retain the pause while preparing it. Existing Stop in an active already-open runtime is available for later windows, but no paused restart is allowed to open Pi solely to Stop. Do not rewrite tasks to manufacture an idle result.
6. **Capture native checkpoint** only when inspection has no blockers. This calls production Durable Object `getCurrentBookmark()` for each stopped workspace and the Assistant, then stores immutable metadata under `maintenance-checkpoint:v1:<id>` and the window pointer. Repeat capture is idempotent. Any unavailable native API/RPC leaves the app paused. Record the checkpoint ID, revision, Assistant/workspace bookmarks, counts/tail, serving version and traffic evidence in the rollout record. Local tests use explicit bookmark stubs; they do not prove production PITR capture. A bookmark has Cloudflare's documented 30-day retention and is not a restore instruction.
7. Dispatch the **same exact commit** with `maintenance_mode=active`, image build still false. Startup and alarm recovery check the persistent pause before opening Pi. A changed deployment revision without a matching active checkpoint also fails closed. Verify source/version/100% traffic, reload `/maintenance`, then **Validate and resume**. The request binds the window epoch, immutable checkpoint ID, source revision and current serving version. It opens the idle 1.3 harness while admission, network/model dispatch, workspace tools and background recovery remain gated; saved history counts/tail, unsettled-work checks and native stopped-state checks must still match. Only then does it mark workspaces and Assistant active. Stale queued admissions retain their old epoch and cannot become new intent after resume.
8. Verify the owner can read retained chat history, unsigned homepage/API access is still denied, production is on the intended active revision at 100%, and `/maintenance` reports active. Do not submit an inference or replay an old operation as a smoke test. Record authenticated/live-provider/iPhone limits honestly.

If validation, deployment or native capture fails, remain paused and repair forward. A crash during validation persists `validating`, which stays paused across restart. A correction on a new source revision needs a new window/checkpoint before explicit resume; the page's Pause action creates it when the prior checkpoint belongs to a different revision. Successful resume is idempotent; replaying its old Pause cannot re-pause it. A failed or uncertain action must be inspected before retry. Do not downgrade or restore as a rehearsal. Actual restoration would need separately approved reconciliation of every later write and preservation of dispatch fences across all systems.

Cloudflare API reference: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api
