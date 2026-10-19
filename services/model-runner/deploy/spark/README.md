# Spark fake runner deployment

The standalone model service is fake-only and binds `127.0.0.1:4319`. The personal/local Mac SIWC diagnostic is separate; deploying this service does not enable real inference or change Cloudflare production routing.

## Existing standard runtime

Spark has verified Linux ARM64, `/usr/bin/node` v22.23.1, npm 10.9.8, and a working user-systemd manager. The pinned service checkout is `~/projects/pi-model-runner-prototype`. Its user unit is `pi-model-runner-prototype.service`; it uses the substituted `.service.in` template, private files and loopback binding. The fake service is not enabled at boot; linger remains disabled.

A separate persistent GitHub Actions runner, scoped only to the private `andrew-kurin/pi-chat-deploy` repository, runs as the owner. Its basic Linux ARM64 smoke workflow passed. The private repository owns the manually triggered **Fake model runner operations** workflow: `status`, `deploy` at an exact full application SHA, and `rollback` to the previously recorded source revision. See that repository's operations README for the current workflow and results. No container, GPU stack, image registry or privileged deployment service is required for this Node route.

## Dispatch fence and rollback

Deployments deliberately keep one stable checkout. The ignored `.runtime/model-runner/rounds.jsonl` remains at the same path across source checkout, dependency installation and rollback. Never delete or reset it to recover an uncertain round. One process owns the journal; stop the old process before starting another. It stores dispatch IDs and hashes, not prompts or credentials, and fails closed when corrupt or full.

Before activation, the workflow prepares an isolated candidate with the repository lockfile, full typecheck and runner tests. It then stops the existing user service, checks out the approved revision and installs that revision's locked dependencies in the stable checkout. Activation must pass fixed fake health and a fresh bounded SSE fixture; the prior journal prefix must remain unchanged. Failed activation attempts restore the previous source and dependencies while retaining all dispatch reservations. Short downtime during activation is expected. This is conservative source rollback, not model-round replay or a zero-downtime rollout.

The workflow supplies `XDG_RUNTIME_DIR` and the user bus address explicitly because the system-level GitHub runner's jobs do not necessarily inherit an interactive user-session environment. It uses no sudo, does not enable the fake model service at boot, and does not change Docker privileges or linger. Deployment metadata and a lock live in `~/.local/state/pi-chat-deploy`; temporary candidate files are removed after each operation. Before any future release-directory rotation, implement and test external persistent state storage/migration rather than moving the fence implicitly.

## Real SIWC remains separate

The Mac CLI is a fixed diagnostic, not this server's backend. A live runner still needs an official `/v1/responses` adapter, account binding, protected credential persistence, one refresh owner, terminal-event validation, limits, no hidden retry, and end-to-end cancellation over the real transport. Keep the Worker as sole owner of Pi orchestration, tools, history and durable admission; the runner handles one model round.

Follow OpenAI's [self-hosted VM guidance](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms). Establish a distinct stable VM host ID before any approved import. Never commit credentials, place them in unit files/logs, overwrite the VM ID with the Mac ID, or paste them into task prompts. A future owner-only persistent credential directory must sit outside rotating releases (0700 directory, 0600 atomic record). No OpenAI credential transfer is part of fake deployment.

Eligibility for the Cloudflare Worker plus owner-hosted runner hybrid remains unresolved under the [OSS/local scope](https://developers.openai.com/siwc/token-sharing-open-source). Successful local tests and MIT publication do not resolve it. A future Worker connection needs authenticated TLS and an approved gateway/tunnel design; do not expose the unauthenticated fixture listener or proxy a blocked backend-api route. No production model traffic or browser recovery is established by fake deployment.
