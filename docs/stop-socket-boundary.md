# Stop settlement and unread HTTP bodies (#50)

Base: verified `origin/main` at `13a6633fcea67f7ac7da948174aa9a4393a36617`.

## Findings and limits

The authenticated `/api/abort` and `POST /api/sessions` routes ignored their
request bodies. The browser and integration fixture send `{}` to both routes.
With the pinned workerd runtime, returning without consuming that body closes
the incoming HTTP/1 connection after the successful response. The response did
not include a `Connection: close` header in the captured baseline.

Two deterministic regressions exercise the actual authenticated Assistant/SQLite
routes. Each writes a POST with `{}` and a following observation GET in **one TCP
write**, so the second request cannot move to a new socket. Both fail on the
original app with one HTTP 200 response instead of two. Draining the body makes
both pass. A minimal workerd experiment also produced one response when ignoring
the body and two after `await request.text()`. No cancellation or model is needed
to reproduce this connection boundary.

Socket diagnostics on the original full suite observed the API peer ending its
connection immediately after Stop, before fixture disposal. Successful settlement
requests then used a new local TCP port. These are API-to-workerd connections,
distinct from workerd-to-runner connections. The runner's upstream signal and
held body cancellation are recorded separately.

**Confirmed:** unread control POST bodies cause the local HTTP connection closure;
consuming them removes that closure and permits the following request on the
same connection. **Inference:** a client-pool reuse race with this closing socket
explains the historical `ECONNRESET`/`UND_ERR_SOCKET` during settlement. The exact
historical intermittent exception was not reproduced in the natural baseline
runs below, so this is not proof that every historical socket failure shares this
cause. No application settlement failure was observed in those baseline runs.

## Change and regression coverage

Both routes now incrementally discard their unused bodies before changing state
and replying. A 20,000-byte limit bounds ignored input; oversized bodies return
413 before the action. Bodyless requests and existing ignored contents remain
accepted. Read failures retain their original cause and do not become success.
Stop still bypasses the mutation queue. Tests cover complete consumption at the
limit, cancellation over the limit, lock release, and original read errors.

The valid consumed-stream synchronization from #45 is retained. The Stop test
still verifies upstream abort, terminal `unanswered` settlement, one inference,
one runner reservation, receipt replay and no redispatch. It additionally checks
upstream body cancellation, the actual durable Worker round record, idle state,
the API socket remaining open until deliberate teardown, and unchanged receipt /
round records / dispatch counts after reconstructing workerd from SQLite.

Fixture diagnostics retain the most recent 256 lifecycle records: API method/path and
socket ports/end/error code, runner response finish/close, provider entry/abort /
body cancellation, consumed-stream readiness, settlement, restart and disposal.
They contain no headers, JWTs, credentials or request/response bodies. Failed
fixture calls include this metadata and preserve the original error as `cause`.
Assertions retain event-presence flags independently of that bounded log, so a
slow readiness poll cannot drop cancellation or earlier socket-failure evidence.
The successful-cancellation deadline timer is cleared instead of keeping each
fresh test process alive for two unnecessary seconds.

No fetch/test/workflow retry, skipped test, new sleep, connection-pool override,
dependency change, or weakened Stop/replay assertion is used.

## Local verification (2026-10-20)

macOS 26.5.2; isolated Node **24.21.0** (matching the reported failing Node
version), npm **11.20.0** (reported failure used 11.19.0). Miniflare
**5.20261006.1-alpha**, workerd **1.20261006.1**, Undici **7.29.1** (both Node's
built-in version and the installed Miniflare dependency), Wrangler **4.149.0**,
Agents **0.28.0**, Pi AI / Pi Durable **1.1.0**. The repository's package and
lockfile remain unchanged; #55 owns the dependency upgrade separately.

Each repetition below starts a new process. Full suites use the normal
`npm test` command/default test-file concurrency; diagnostic baseline suites add
an Undici diagnostics-channel preloader. Some independent batches overlapped on
the same host, so elapsed times include that contention.

| Source / command | Repetitions | Result | Total elapsed |
| --- | ---: | --- | ---: |
| Original: isolated Stop | 30 | 30 passed | 87.911 s |
| Original: `npm test` | 3 | 3 passed, 429 tests each | 17.622 s |
| Original: full suite with socket tracing | 20 | 19 passed; one unrelated workspace UI failure; Stop passed 20/20 | 112.090 s |
| Original app + deterministic route regressions | 1 | Both failed, each observing only 1 of 2 responses | 0.661 s |
| Fixed: body unit tests + Worker runner tests | 1 | 8/8 passed | 11.664 s |
| Fixed: isolated Stop (with restart/replay checks) | 50 | 50 passed | 51.253 s |
| Fixed: `npm test` | 20 | 20 passed, 434 tests each; zero failures/skips | 261.206 s |
| After final diagnostic-retention adjustment: isolated Stop | 20 | 20 passed | 19.614 s |
| After final diagnostic-retention adjustment: `npm test` | 3 | 3 passed, 434 tests each; zero failures/skips | 39.436 s |

The unrelated baseline failure was
`polling during slow export does not discard its saved download link` in
`tests/workspace-ui.test.ts`: `TypeError: release is not a function`. It occurred
in traced full-suite repetition 7 (428/429 passed). It is reported, not modified
or discounted as a passing run.

Reproduction commands, with `node` on PATH set to the stated runtime:

```sh
node --import tsx --test --test-name-pattern='consumes its POST body' tests/model-runner-cloudflare.test.ts
node --import tsx --test --test-name-pattern='actual Worker Stop' tests/model-runner-cloudflare.test.ts
npm test
npm run typecheck
node --check public/app.js
npm run check:ui
WRANGLER_SEND_METRICS=false XDG_CONFIG_HOME=/tmp/pi-issue-50-config npm run build
```

Typecheck (Worker and runner), JavaScript syntax, UI bundle consistency and
Wrangler dry-run passed. Dry-run upload: 2,324.66 KiB / 434.28 KiB gzip.
All five configured hermetic browser scripts passed in local Chrome: `ui.mjs`
(3.665 s), `mobile-reading.mjs` (1.393 s), `compact-identifiers.mjs` (1.209 s),
`workspace-resume.mjs` (1.533 s), `copy-controls.mjs` (1.467 s).

The new pipelined tests observe actual socket responses rather than delaying or
retrying a request after the peer closes it. Their timeout is only a failure
deadline; success is driven by received response framing / connection events.

## CI and deployment boundary

Exact-head GitHub CI results will be linked in the draft PR. CI runs the same
typecheck/test/syntax/dry-run steps as deployment validation, plus browser smoke.
The manual deployment workflow requires main and proceeds to deployment; it was
not invoked because this task authorizes neither merging nor deploying. A real
post-merge deployment-validation run remains outside this task's authority.

No Spark checkout/service, production Worker, real model/provider endpoint,
deployment setting, credential or user chat was touched. The only network
activity outside local fixtures was repository/dependency retrieval and PR/CI
publication/inspection.
