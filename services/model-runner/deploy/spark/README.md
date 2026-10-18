# Spark preparation — not installed

This is a minimal user-systemd template for **fake loopback smoke testing only**. No service, repository checkout, credentials, firewall rules or Worker connection have been installed by this preparation. The registered DGX `Projects` environment is the intended execution context. Its read-only prerequisite task currently awaits environment approval; architecture, Node paths, systemd user manager/linger and port availability are unverified. Do not assume this host is ready from the template.

## One supervised process

Use one pinned checkout and the repository lockfile, Node >=22.19 (Node 24 is used in CI), and `npm ci`. Verify the actual Linux CPU architecture and compatible Node binary in the registered remote task before installing dependencies. OpenAI hosts inference; this service needs no GPU stack. Do not use a Mac binary or copy node_modules across architectures.

The `.service.in` is intentionally not directly installable. Replace `@ABSOLUTE_NODE@` with the verified absolute Node executable and `@ABSOLUTE_PINNED_CHECKOUT@` with a protected, stable, commit-pinned checkout. The fake server binds only `127.0.0.1:4319`; `/health` must say fake mode and contract 1. Its existing HTTP bridge streams with backpressure and propagates client cancellation/deadlines. Local native tests cover those mechanics; remote verification is still required.

The dispatch journal is the checkout's `.runtime/model-runner/rounds.jsonl`, private and persistent across process restarts. Keep the same checkout/state directory across supervised restarts; never recreate or discard the fence to recover a request. Before any release-directory rotation, define and test an external persistent state path/migration. One process owns the journal; no overlapping rollout. Failure/full/corrupt journals fail closed. `UMask=0077` protects new state; verify owner/modes before startup. The template does not contain auth or credential configuration.

After separate installation approval, a registered remote task can prepare the pinned checkout/dependencies, substitute and inspect the unit, then install it in the owner's user-systemd directory and perform loopback fake health/stream/cancel/restart checks. Confirm availability of the user manager first. Enabling linger is a separate persistent host change; do not silently enable it. Never expose this unauthenticated fixture port. Stop the unit before rollback, retain the dispatch fence and use a compatible pinned revision. Do not reset IDs or replay uncertain work.

## Live SIWC is a later implementation and approval

The working Mac SIWC CLI is a fixed diagnostic, not the standalone inference server. A real runner still needs a dedicated official `/v1/responses` backend, account binding, secure credential persistence and refresh handling; do not merely substitute its access token into the fake service. Keep the Worker as sole owner of the Pi tool loop, history, durable admission and tools. The runner handles one model round only. Preserve SSE, terminal-event validation, limits, no hidden retry and end-to-end cancellation over the actual future HTTP hop.

Follow OpenAI's [self-hosted VM guidance](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms): establish a distinct stable VM host ID before any approved import; authorize the same intended client/user/workspace locally; transfer the protected credential record only through a separately approved secure mechanism. Never commit tokens, put them in a unit/environment/log, overwrite the VM host ID with the Mac ID, or paste credentials into task prompts. Reserve an owner-only persistent directory outside rotating releases (0700 directory, 0600 atomic record) for future credentials. No such directory or transfer is performed here.

The VM must become the sole refresh owner after an approved handoff; stop concurrent Mac refresh use. Serialize refresh plus atomic persistence and define expired/revoked credential behavior before a live service starts. Existing fake refresh tests do not prove the live refresh implementation. Bootstrap must not start OAuth or create a new persistent grant automatically.

Eligibility for the Cloudflare Worker plus owner-hosted runner hybrid remains unresolved under the [OSS/local scope](https://developers.openai.com/siwc/token-sharing-open-source). Successful local SIWC checks and MIT publication do not resolve that question. No blocked backend-api route may be proxied. A future Worker transport also needs authenticated TLS, account binding and an explicitly approved gateway/tunnel design; loopback is not reachable from the Worker. No gateway, public port or tunnel is configured here.

## Next handoff

First resolve the pending read-only remote task approval and inspect its prerequisite results. Then seek a concrete separate approval for the pinned **fake-only** installation/smoke test in that registered environment. Credential transfer, sole-refresh handoff/live adapter, any new OAuth grant, network exposure and production Worker activation each remain outside this preparation. Keep PR #36 draft until review and deployment decisions are complete.
