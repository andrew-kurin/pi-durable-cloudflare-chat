# Deploy from your own computer

This package has not been deployed. The assistant's Cloudflare sign-in attempt was blocked by its network policy; this package contains no Cloudflare grant or subscription credentials. The commands below are for you to run in your own terminal after reviewing the access and costs.

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
- OWNER_EMAIL: your exact allowed email
- APP_ORIGIN: https://pi-private-chat.YOUR-SUBDOMAIN.workers.dev
- workers_dev: true
- Keep preview_urls false, ENABLE_MODEL false and ENABLE_SUBSCRIPTION_LOGIN false

For a custom domain use its exact HTTPS origin and authorized route instead; keep workers_dev false. Both the outer Worker and its Durable Object validate Access again. No production local-auth bypass exists.

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
