# Disposable project workspace V1

This feature is disabled by default and has not been deployed. The existing production configuration, model/auth loop, domain and deployment workflow are unchanged. Sol stays in Pi Durable; a separate task-scoped `TaskWorkspace` Durable Object owns the guest and its lifecycle. The guest contains Node, Git, Python and normal build utilities, with no second model, application credentials, GitHub write/deployment tokens or mounted production state.

The owner explicitly opens one disposable workspace for the configured trusted public `WORKSPACE_REPOSITORY` (`owner/repository`). The app admits one active owner workspace across conversations. It clones anonymously and saves the resolved initial commit as the immutable export base. Tools are registered only when the feature, namespace, project and image are configured. They select only a workspace approved for the calling conversation:

| Tool | Behavior |
| --- | --- |
| `workspace_read` | Read a bounded UTF-8 project file. |
| `workspace_edit` | Replace exactly one matching occurrence, or create a new file with an empty old value. |
| `workspace_exec` | Start one serial argv command and return a durable run ID. A shell is explicit argv, such as `sh -c`. |
| `workspace_status` | Read recorded/live process state and deadlines without restarting work. |
| `workspace_logs` | Return the last 16 KiB of a recorded stdout/stderr stream. |
| `workspace_cancel` | Signal the process group, then stop the entire guest after bounded grace. |
| `workspace_export` | Save an immutable base-relative binary patch and available logs for owner review. |

Read/edit/new commands wait for the active command to finish. Export requires a quiet workspace. File adapters restrict relative paths and resolved paths to the project and exclude direct `.git` edits. This is intended for the owner's trusted project, not arbitrary hostile repositories. Internet access permits public cloning and package installation. V1 does not add an elaborate network policy layer. External publication, deployment or security-setting changes still require explicit owner approval; the guest has no write/deploy credentials. There are no previews, snapshots, automated PRs or parallel workspace agents.

## Lifecycle and limits

Run IDs and operation fingerprints are saved before dispatch. Duplicate exec requests report the existing run; reconnect asks for status/logs. SDK recovery marks arbitrary execution/edit/export as unsafe rather than replaying it. A missing PID, changed boot ID, missing exit record or ambiguous dispatch becomes interrupted. The app never silently restarts a command or lost container. Start a new task or issue an explicit new command after reviewing available work.

| Configurable default | Rationale |
| --- | --- |
| Task deadline: 90 minutes | Enough time for a normal edit/build/test loop without an open-ended guest. |
| Command deadline: 30 minutes | Accommodates installs and quiet builds; an individual command may request up to 120 minutes, capped by the task deadline. |
| Idle cleanup: 15 minutes | Allows reading results and deciding the next step. A running process is active even if its logs are quiet. Completion starts a fresh idle window. |
| Warning: 5 minutes before a limit | Gives time to use explicit owner extension controls. |
| Graceful cancellation: 10 seconds | Allows termination and final writes before whole-container shutdown. |
| Final artifact budget: 20 seconds | A failed or hung export cannot keep compute alive indefinitely. |
| Ordinary adapter operation: 30 seconds; setup: 5 minutes | Setup permits a realistic public clone without thrashing. |

`WORKSPACE_LIMITS` accepts a JSON override of the `*Ms` fields in `DEFAULT_WORKSPACE_LIMITS`. Validated caps are six hours per task, two hours per command, one hour idle, 15 minutes warning, 30 seconds cancellation grace, 60 seconds artifact/adapter operations and ten minutes setup. The owner can explicitly add 30 minutes to either task or command; extension does not revive a stopping/closed task. Task and command limits are displayed separately. Alarms poll every 30 seconds, keep active guests alive and enforce deadlines independently of log output. Cancellation bypasses the app's long-running POST admission queue, including during setup.

The resource class is `standard-1` (1/2 vCPU, 4 GiB RAM, 8 GB disk), with an app-owned one-active-workspace admission limit and at most 100 commands per task. Guest logs have a file-size limit. Exports cap patch output at 512 KB and use bounded Durable Object storage chunks. Logs preserve only their tails. Artifacts are immutable per export ID and available through existing owner authentication and same-origin mutation checks. Cancellation saves available work best effort, then stops compute; missing/truncated logs, capture failures and uncertain stop confirmation are reported. A patch captured while a command is still stopping is explicitly marked. No Git commit or PR is created by export.

## Configuration and future integration

The implementation uses the [Sandbox 1.0 app-owned container API](https://developers.cloudflare.com/sandbox/sdk/migrate/changes-in-1-0/) and [request-independent process records](https://developers.cloudflare.com/sandbox/commands/run-background-processes/), not SDK 0.x sessions. Each call supplies cwd explicitly. A constructor restores inactivity management and alarms for a still-running guest.

`wrangler.workspace.jsonc` is a separate opt-in configuration, validated by Wrangler 4.149.0. Its feature flag is false and project/image values are blank. The production generator does not adopt this configuration or enable the feature. Sandbox 1.0 requires digest-pinned managed-registry images; the older `max_instances` field is unsupported for Durable Object scheduling. The Dockerfile has been built and smoke-tested locally. Uploading its image, configuring the registry digest, provisioning the container app, setting the trusted project and enabling the feature require separate approval. No image has been uploaded and no paid resource provisioned.

## Verification limits

Tests include synthetic Sol tool conformance with faux responses, controller state/replay/serial/deadline/extension/loss tests, real local Python file edits, a mocked `ctx.container` process adapter, and workerd owner-route tests with a mocked workspace DO. The owner panel has pending-setup cancellation/retry and inert-text tests. Existing app tests and mobile/desktop fixtures remain in the full checks. These are local/simulated tests, not real Cloudflare Sandbox integration tests. On October 12, 2026, the owner-authorized normal launch of the existing Docker Desktop made its local daemon available without installation, new grants, account steps or configuration changes. The actual Docker image built and the adapter smoke passed: read/edit/new files, command exit/status/stdout/stderr, base-relative patch/new-file export with the real Git index preserved, process-group cancellation including its child, and forced guest cleanup. The local image ID is `sha256:fd5893764c83e317de1ba5f922b3a210a7ee9752a344cdfb880a6adf1c6cea95`. These real Linux guest checks do not verify Cloudflare request-handle semantics, deployment or Durable Object alarms/lifecycle. Provider/model/Tavily calls were not made.

Once the owner independently makes Docker available, run `node --import tsx scripts/workspace-docker-smoke.mjs` from the repository root. The runner rejects remote endpoints and checks local daemon availability, builds this Dockerfile locally using a temporary empty Docker client configuration for anonymous public-image access, creates a synthetic project without host mounts or guest network access, and exercises the actual adapter's file edits, process status/logs, base-relative patch/new-file export, process-group cancellation and forced guest cleanup. It preserves the real Git index and removes its guest in `finally`. The local image tag remains available for inspection; remove `pi-workspace-smoke:local` manually when no longer needed. The runner does not start Docker, upload an image, call Cloudflare, or verify Cloudflare's request-owned process/lifecycle behavior. Docker image build may download official base/package dependencies; the running guest has network disabled.

The first build attempt with the existing client configuration timed out while fetching base metadata, with Docker’s credential helper still waiting. A bounded anonymous retry succeeded; the runner now uses that temporary build-only configuration and removes it afterward. Saved contexts/account settings are untouched. The final runner passed again with an explicit check that the cancelled child process was gone. The guest is network-disabled and has no host mounts, app/provider credentials or model.

## Deployment wiring (manual, after prerequisites and approval)

The manual workflow accepts `production` (default) or `staging`. Each uses only its own GitHub environment variables/secrets and requires main. Staging creates a separate `pi-private-chat-workspace-staging` Worker and fresh namespaces; its exact workers.dev origin must be protected by an approved owner-only Access application before use. Its provider/login/web flags are forced off regardless of environment values, and no production encryption key or provider credential is copied. The Assistant still requires an encryption secret during initialization: the owner must provision a new 32-byte base64 `CREDENTIAL_ENCRYPTION_KEY` directly into the staging Worker after resource approval. This storage key is not a model grant; never paste it into chat or copy the production key. The workflow checks only that its name exists before staging deploy and fails closed if the Worker/key is missing; this name check cannot verify key validity. Initial staging Worker/secret provisioning is a separate approved owner step, not performed by the workflow. The original production origin, routing, Assistant migration and secrets remain unchanged.

Add these variables to the selected environment only after reviewing that target's resource/egress authorization:

| Variable | Required setting |
| --- | --- |
| `PROVISION_WORKSPACE` | `true` explicitly selects the existing workspace template, Workspaces binding, additive `workspace-v1` SQLite migration and container configuration. Default `false` creates none of these. Keep this true after provisioning, even when disabling the feature, to retain cleanup bindings and migration history. |
| `ENABLE_WORKSPACE` | Default `false`. Set `true` only after activation approval. Requires provisioning. |
| `WORKSPACE_REPOSITORY` | One approved trusted public `owner/repository`, without URL, credentials or branch suffix. |
| `WORKSPACE_IMAGE_REFERENCE` | `registry.cloudflare.com/<this-account-id>/<repository>@sha256:<registry-manifest-digest>`. Tags, other registries and other accounts fail closed. The generator names it `workspace` and supplies `WORKSPACE_IMAGE=workspace` to the app. |

Both targets also require their own `CLOUDFLARE_ACCOUNT_ID`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, exact `APP_ORIGIN`, and `OWNER_EMAILS`/`CLOUDFLARE_API_TOKEN` secrets through the existing private-config path. Do not paste secrets into chat or public variables. The workflow does not upload/build images, buy/upgrade subscriptions, manage Access policies or attach routes. Image upload is a separate approved action; the local image ID is not the registry manifest digest. A named digest-pinned image source resolves through `ctx.container.images`.

For the proposed staging smoke window, the generated defaults are a 12-minute task, 10-minute command and one-minute idle/warning period, leaving cleanup margin inside 15 minutes. Do not extend staging deadlines. The operator must enforce the overall approved window, cancel and verify guest destruction, including when API/runtime recovery is ambiguous. Native Cloudflare execution, alarm delivery and stop confirmation still require verification; these are not proven hard billing caps. No model prompt is needed for the shell lifecycle smoke. Each opened task clones the approved public repository and enables outbound Internet for Git/package operations; there are no guest model/deployment tokens. This egress activation requires the same explicit approval as staging resources.

After native validation and reviewed activation, use the production environment with its existing owner authentication/data settings. To disable a provisioned workspace, retain `PROVISION_WORKSPACE=true`, repository and pinned image, set `ENABLE_WORKSPACE=false`, and deploy after cancelling/exporting any active task. The bundle marker includes workspace mode/image/repository so bindings refresh. A deployment does not itself replace an already-running guest or guarantee artifact recovery. Delete staging resources/image only after stop confirmation and rollback-reference review; never remove the production Assistant namespace or encryption key.
