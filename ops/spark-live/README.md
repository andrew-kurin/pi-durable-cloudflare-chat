# Proposed Spark activation bundle — not executed

This first-install bundle is prepared for explicit owner approval. Default script
invocation prints an inert plan. No credentials, tunnel, DNS, services or live
inference were created by preparing/testing it. PR36 remains draft; production is
unchanged. The previous four-request local real-model budget is fully consumed.

## Current read-only evidence, 2026-10-19

- Existing production domain: `pi-chat.andrewkurin.com`; account matches current
  Mac Wrangler login. Existing OAuth permissions are only `user:read`,
  `offline_access`, `account:read`, `workers_tail:read`. Do not expand this grant.
- `pi-runner.andrewkurin.com` returns public DNS NXDOMAIN (A/CNAME lookup). This
  does not establish absence of unpublished dashboard/DNS/tunnel configuration.
- Neither `pi-model-runner-live.service` nor `cloudflared-pi-runner.service`
  exists on Spark. `cloudflared` is absent from PATH and `/usr/bin/cloudflared`.
- Spark Node is `/usr/bin/node`22.23.1. Existing fake checkout remains38b7d5e,
  its user unit is active/boot-disabled, and linger is off. Dedicated live paths
  are absent. Existing persistent GitHub runner is separate and untouched.
- No supported authenticated tunnel-list action was available without reading
  tokens or expanding access. Owner must check tunnel-name/hostname conflicts in
  the existing dashboard. Never assume DNS NXDOMAIN proves no named tunnel exists.

## Exact approval to obtain before execution

> Approve the dedicated Cloudflare Tunnel `pi-model-runner-spark` and published
> DNS hostname `pi-runner.andrewkurin.com`, forwarding only `/v1/responses` to
> Spark loopback4320 with HMAC authentication; installation of pinned ARM64
> cloudflared and two boot-enabled system services as `andrewkurin`; generation
> of a dedicated HMAC transport key and its entry as a Worker secret; secure SSH
> transfer of my existing Mac SIWC session with the same account/workspace/scopes,
> a distinct Spark host ID, retirement of the active Mac copy and Spark as sole
> refresh owner. I have stopped other Mac SIWC use and reviewed the owner-only
> OSS/hosted eligibility qualification. No production runner enablement, extra
> OAuth scopes, new OAuth registration or model requests are authorized by this
> setup approval. Copying only the transport key to my Mac clipboard for manual
> Worker secret entry is included.

The documentation supports self-hosted OSS VMs and separately directs remotely
hosted offerings to an interest form; it does not explicitly prohibit this private
hybrid or establish mandatory prior approval for it. Review that qualification;
do not describe uncertainty as a ban or claim a form was submitted. The config
marker records the owner's deployment review, not an OpenAI endorsement.
Sources: [SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source),
[VM handoff](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms).

## Minimal owner handoff after approval

1. In the **existing Cloudflare dashboard/account**, search Tunnels and DNS first
   for the exact name/hostname. Stop on a conflict; do not create a duplicate or
   replace records. Create the dedicated remotely managed tunnel named
   `pi-model-runner-spark`, but leave published routes empty. Keep its connector
   token private for the hidden script prompt. No new account-wide API token or
   broader Wrangler/CI OAuth grant is needed.
2. On the Mac, from this reviewed checkout, run **one command** in a terminal:

   ```sh
   python3 ops/spark-live/setup.py --execute --approved-access-and-services --eligibility-reviewed --copy-worker-key
   ```

   It prompts for the dedicated tunnel token without echo, uses the already-
   approved ghost SSH identity to `dgx`, and later prompts for Spark sudo through
   an interactive SSH terminal. No secrets appear in argv, logs or command output.
   The script does not call an OAuth endpoint, use the model, submit forms, write
   Cloudflare DNS, change Worker settings or enable production.
3. Paste the clipboard value into existing Worker `pi-private-chat` as secret
   **`MODEL_RUNNER_TRANSPORT_KEY`**, using the dashboard's secret field. Clear the
   clipboard after pasting. The protected recovery handoff file is
   `.runtime/spark-live-activation/transport-key.hex` on the Mac. Never paste it
   into chat, public variables or GitHub Actions. This existing read-only Mac
   Wrangler grant cannot perform that write and is not expanded by the script.
4. After services are confirmed active, add the tunnel's published application
   hostname `pi-runner.andrewkurin.com`, path `^/v1/responses$`, service
   `http://127.0.0.1:4320`, preserving the path. Keep unmatched requests404;
   `tunnel-route.example.json` is a review template, not an API mutation executed
   by this bundle. Tunnel TLS carries traffic to Spark without an inbound firewall
   port. Public reachability is gated by the implemented request HMAC; this is not
   a Cloudflare Access browser-login endpoint. An Access service-token layer would
   require a separately reviewed client change and is not silently added here.
5. Leave production `ENABLE_MODEL_RUNNER` OFF/unset. PR36 review/merge and the
   production flag/endpoint deployment remain separately approved steps. Before
   paid/live validation, obtain a fresh bounded model budget; do not reuse the
   four consumed diagnostic requests. Unsigned rejection/read-only health checks
   need no model inference. Current live server has no public health route.

## What the script stages and installs

The dedicated live checkout is `/home/andrewkurin/projects/pi-model-runner-live`,
pinned to reviewed implementation6773a901153828682c5cb6e2d635dc3e9aae8e5e.
It runs locked `npm ci` using `/usr/bin/npm` and `/usr/bin/node` on PATH.
The fake checkout, journal/unit and GitHub runner are never modified.

`cloudflared-pi-runner` is a dedicated user-owned binary pinned to official
release2026.10.1, LinuxARM64 SHA256
`2c65dfabf616c40efc7545d107d7a57ad5e21377e2964b7e88af19a238074a46`.
The checksum is verified before execution. Source:
[official release](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.1).

Runtime/config lives in `~/.config/pi-model-runner`, journal in
`~/.local/state/pi-model-runner`: directories0700/files0600. The session's client,
subject, tokens and scopes are preserved; only its host ID changes to a distinct,
persisted Spark UUID. This follows the official VM handoff. No refresh occurs
at installation. Spark owns later refreshes when a separately approved model
request needs one. The active Mac credential is durably renamed to
`credentials.retired-to-spark.json`, not deleted, before services start. That
protected record is recovery evidence; it must never be reused/refreshed or
reactivated automatically after Spark may have rotated the session.

The tunnel token is stored in a protected file and supplied through `--token-file`;
no token is embedded in a unit. Services run as`andrewkurin`, `UMask=0077`,
`NoNewPrivileges=yes`, `PrivateTmp=yes`, and `WantedBy=multi-user.target`:

- `pi-model-runner-live.service`: `/usr/bin/node --import tsx
  services/model-runner/live-server.ts <protected-config>`, `Restart=no`, stop
  timeout45seconds. It binds127.0.0.1:4320. Crash/ambiguous refresh locks require
  operator resolution; they are never erased to make a restart pass.
- `cloudflared-pi-runner.service`: dedicated pinned binary `tunnel run
  --token-file <protected-token-file>`, restart on failure.

The owner-run installer uses sudo only to install these two reviewed units,
reload systemd and enable/start them. It refuses existing units; it does not enable
user lingering or add privileges/groups. Model/tunnel credential files remain
user-owned and are not written to `/etc` or GitHub.

## Failure recovery and validation

This is deliberately first-install only. Any existing helper/live path, secret or
unit stops it; rerunning cannot overwrite credentials, fences or unrelated state.
Mac phase evidence is `.runtime/spark-live-activation/phase.json`. A failed/uncertain
handoff retains the owner lock and active credential until resolved; no service
is started automatically. After `import-uncertain`, inspect privately whether the
remote import completed before deciding which host owns the session. After
`mac-retired`, never restore the active Mac copy without resolving Spark ownership.
A partial service install requires inspection of only these two named units;
do not rerun the bootstrap or regenerate keys. This bundle has no destructive
rollback or automatic stale-lock clearing.

Offline tests use synthetic files and mocked subprocesses only. They cover
same-registration/VM-host import, protected modes, no overwrite, invalid payloads,
ambiguous refresh markers, bootstrap/import failure preserving Mac ownership,
durable retirement-before-start ordering, unsupported Node refusal, inert plans,
and credential-free unit arguments. No setup execution, credential creation or
provider calls are part of these tests.
