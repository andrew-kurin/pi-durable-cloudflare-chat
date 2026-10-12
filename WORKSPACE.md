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

`wrangler.workspace.jsonc` is a separate opt-in configuration, validated by Wrangler 4.149.0. Its feature flag is false and project/image values are blank. The production generator does not adopt this configuration or enable the feature. Sandbox 1.0 requires digest-pinned managed-registry images; the older `max_instances` field is unsupported for Durable Object scheduling. The Dockerfile is source preparation only. Building/uploading its image, configuring the registry digest, provisioning the container app, setting the trusted project and enabling the feature require separate approval. No image has been uploaded and no paid resource provisioned.

## Verification limits

Tests include synthetic Sol tool conformance with faux responses, controller state/replay/serial/deadline/extension/loss tests, real local Python file edits, a mocked `ctx.container` process adapter, and workerd owner-route tests with a mocked workspace DO. The owner panel has pending-setup cancellation/retry and inert-text tests. Existing app tests and mobile/desktop fixtures remain in the full checks. These are local/simulated tests, not real Cloudflare Sandbox integration tests. Docker is installed on this Mac but its daemon is not running, so the guest image and Linux process-group behavior have not been executed here. Provider/model/Tavily calls were not made.
