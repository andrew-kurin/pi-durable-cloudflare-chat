# Owner-authorized harness proposals

This is the first self-modification milestone: Pi can edit and test the public harness checkout, export its work, request owner review, and observe publication/CI status. Publication creates a GitHub-signed commit and a draft PR only after a separate owner action. Merge, deployment, maintenance and production recovery remain external.

The feature is **off by default**. This implementation does not provision a publisher, a GitHub credential, a signing key, an HTTPS endpoint or a Worker secret. Its local tests use synthetic credentials and offline fixtures. Enabling and validating real publication needs separately approved setup described below; deploying this code alone does not enable it.

## Edit, verify, export and propose

The existing workspace tools remain the editing and execution interface. A newly opened workspace for `andrew-kurin/pi-durable-cloudflare-chat` checks out the serving Worker's exact `SOURCE_REVISION`, when configured. Other projects keep the ordinary clone behavior. An existing workspace retains its recorded immutable base; tools never silently update it to another revision. Source edits do not hot-reload the running chat harness.

1. Edit in the harness workspace. Package installation, if needed, stays in the guest; the publisher never installs packages or executes project scripts.
2. Run `npm run build` to update generated UI first. Then run the exact argv commands `npm test`, `npm run typecheck` and `npm run build` at the project root on the final unchanged tree. Use `workspace_wait`/status/logs to observe each existing run rather than rerunning an ambiguous command.
3. Call `workspace_export`. The immutable artifact includes its base commit, Git tree ID, patch SHA-256, existing logs/retention metadata, and successful check receipts whose before/after trees both equal the export tree. A later failed attempt supersedes an earlier success for that check. Missing/changed-tree receipts require a fresh successful check and new export; prior artifacts remain immutable.
4. Call `harness_propose_change` with `workspaceId`, `artifactId` and a short title. It returns a durable proposal ID and `/changes?session=...&proposal=...` review URL. This creates an internal proposal, with no GitHub mutation. Repeated calls for the same export recover its existing proposal.
5. The owner opens the page, reviews the inert patch, source hashes and observed checks, then explicitly chooses **Authorize signed draft PR**. The authenticated, same-origin POST binds the exact patch and tree hashes. Chat messages, file instructions, review text and tool arguments cannot grant this authorization.
6. Use `harness_change_status` with the same proposal ID. After publication it returns the PR identity, published head and bounded CI/status/review details. Checks use the exact published commit. An externally changed PR head is reported explicitly; older reviews have `appliesToHead: false`. Truncation is marked `incomplete` and links lead to complete details. No aggregate success, review approval, merge permission or deployment permission is inferred.

Check receipts establish an observed exit status and unchanged tracked/unignored source tree. They do **not** attest that scripts/tests are meaningful, or that ignored build inputs, dependencies or runtime state are trusted. Hosted CI and independent review remain necessary. Changes to tests and source can affect what an exit status means.

## Credential and publication boundary

`ChangeProposals` stores metadata in the existing Assistant DO. The patch remains in its existing owner-scoped immutable workspace artifact. Proposal creation and artifact-to-proposal deduplication are atomic. Model tools expose only proposal and status operations. Normal workspace mode remains 13 tools; this opt-in adds two.

After the owner's hash-bound action, the Worker sends the immutable envelope to an isolated publisher. An independent HMAC key binds method, operation ID and exact body. The HTTPS origin is fixed configuration, redirects fail closed, and response sizes/timeouts are bounded. Neither this key nor the publisher's GitHub credential enters the guest, model prompt or artifact. This key must be separate from model transport and provider credentials.

The Node publisher fetches only the fixed public repository anonymously at the recorded base. It applies the binary patch with Git, verifies the resulting tree, and constructs file changes without executing repository hooks, scripts or tests. Git subprocesses receive an isolated home and an explicit environment without the publisher credential. Automatic publication supports:

- 1–50 changed regular, non-executable file paths under `src/`, `public/`, `tests/` or `docs/`;
- added/updated contents must be UTF-8 text without NUL bytes, at most 128,000 bytes per file and 512,000 bytes in total (deleting an existing regular binary is allowed);
- a nonempty patch of at most 512,000 UTF-8 bytes, with a 3,100,000-byte encoded envelope cap to allow JSON escaping;
- no `src/change-*`, `src/publication-protocol.ts`, or paths outside those four roots. Root configuration/dependency files, `.github/` workflows and `services/` therefore need separate manual publication. This is a path policy, not a semantic restriction on configuration/code stored inside the allowed roots.

The sole destination is `andrew-kurin/pi-durable-cloudflare-chat`, base `main`, on `pi-self-change/<proposal-id>`. The GitHub commit API uses the expected base as a compare-and-swap guard. The publisher verifies the commit's signature, sole parent, exact tree and identity marker before opening a draft PR. It has no merge/deploy implementation. External PR state changes are observed, not reversed.

## Uncertain outcomes and recovery

Existing guest execution journals and immutable export IDs are retained. Proposal IDs derive from durable model task/call identity. Publication uses a persistent SQLite journal with an atomic version guard and a durable fence before each branch, commit and PR mutation. Reusing an ID with different content fails closed.

If a response is lost, read status first. It reconciles through GitHub reads only. An exact matching result may advance a known stage; an absent or mismatched result leaves the fence in place. Status never dispatches a new mutation. The owner can retry delivery of the **same authorized proposal** to continue only stages known not to have been dispatched. A crash after saving a dispatch fence but before sending the request can intentionally require operator inspection.

Never clear the journal/fence, change IDs, re-export or create another proposal to replay uncertain publication. Do not overwrite an externally changed branch. Preserve journal, PR/branch references, hashes and status for reconciliation. Rejected candidates contain allowlisted error codes and recovery guidance; raw Git/provider stderr and credentials are not returned. The journal stores patches and metadata, so it also needs private filesystem access and durable backup appropriate to owner source data.

## Setup still requiring approval

No host or credential has been configured by this implementation. Before enabling it, separately approve these concrete choices/actions:

1. An isolated non-root publisher account/host with Node 24 or newer, Git, the reviewed service source, and a protected persistent journal directory. The service binds only `127.0.0.1:8789`; select an authenticated/restricted HTTPS reverse proxy at one fixed origin. HMAC is mandatory even behind the proxy. Keep publisher execution separate from the model guest and deployment credentials. This implementation does not install anything on Spark or create a machine-maintenance channel.
2. A GitHub credential identity limited to this repository, with Contents write, Pull requests write, Checks read and Commit statuses read (plus metadata access). Choose a supported identity that produces verified GitHub-signed commits through `createCommitOnBranch`; the bridge rejects an unverified result. It needs no workflow modification, Actions dispatch, administration, security-setting or deployment permission. No signing setting is disabled and no private signing key is installed in the guest. Keep merge/deploy approval external even though a Contents-write credential can have broader GitHub capabilities than this service exposes.
3. Publisher environment: `GITHUB_PUBLICATION_TOKEN`, a fresh independent `PUBLICATION_TRANSPORT_KEY` of at least 32 characters, and an absolute persistent `PUBLICATION_JOURNAL` path. Start with `node --import tsx services/change-publisher/server.ts` from the reviewed checkout. Supply secrets through the approved host secret mechanism, never shell arguments, public variables or repository files. Retain the journal across restarts; losing it is not permission to republish.
4. The matching Worker secret `PUBLICATION_TRANSPORT_KEY`, exact HTTPS-origin variable `PUBLICATION_ENDPOINT`, and `ENABLE_HARNESS_PROPOSALS=true`, with the existing workspace feature and fixed harness repository already enabled. The generator forwards only the nonsecret flag/origin and forces proposals off for staging. Existing owner Access and same-origin mutation enforcement remain mandatory. Missing setup keeps tools unavailable; exported work remains accessible.
5. A separately approved, small real publication smoke: owner reviews one harmless patch, verifies its remote signature/content and draft PR, and observes exact-head hosted CI. Mocked tests do not prove a particular token, proxy or production service is configured correctly. Merge/deploy still require external authorization and the established forward-only maintenance procedure.

Source/receipt fields are additive to artifacts. Previously saved artifacts remain readable and immutable, but cannot support publication without required metadata/checks. This is not a source-state restore mechanism, release controller, or authority to change private deployment architecture/ADR proposals.
