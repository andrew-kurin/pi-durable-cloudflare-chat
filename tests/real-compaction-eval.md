# Opt-in Sol compaction evaluation

Print a zero-call plan:

```sh
node --import tsx tests/real-compaction-eval.mjs
```

After explicit owner approval to consume the existing subscription quota:

```sh
node --import tsx tests/real-compaction-eval.mjs --run --allow-subscription-usage \
  --transport-key-file /private/path/to/existing-runner-transport-key.hex
```

Use an existing mode-0600 transport key, not OAuth credentials. The script consumes it in memory for the application's signed requests to the configured production Spark endpoint. It does not print, publish, transfer, refresh, or change subscription credentials. There is no new endpoint, login, credential grant, model API fallback, deployment, or change to user chats. Existing Spark admission/credential handling and permanent round fences still apply. Each run uses a unique namespace and fresh local private SQLite directory. Production Spark journal records are added for these isolated eval rounds, as with normal model requests.

The eval uses the pinned native Pi Harness, `createWorkerRunnerProvider`, model guard, compaction logging, `fullHistorySnapshot`, and `ChatProjection`. It seeds synthetic user decisions and a paired saved tool call/result. Artifact and checksum values occur only in the saved tool result. Irrelevant padding triggers automatic blocking compaction. The selected Sol model must summarize, call the side-effect-free `eval_probe` once, then produce JSON with the six retained values and a newly generated tool proof. It verifies both summary and final answer, removal of old padding from active context, unchanged visible history, and identical context/history after closing and reopening SQLite, with dispatch disabled on reopen.

The eval retains production code but uses an **isolated 8,192-token model context window**, 2,048 reserved tokens and 1,024 recent tokens. Production's 272,000-token catalog window and 16,384/32,768/32,768 compaction policy remain unchanged. This checks real summary quality and continuation through Spark, not the full production context threshold, browser UI, Cloudflare storage/recovery, or a complete process restart. Worker-side round reservation storage in this Node harness is in memory; actual Spark reservations are durable. The SQLite harness itself is closed and reopened from disk.

Each run permits at most four requests, 100,000 input bytes/request, 160,000 streamed response bytes/request, 90 seconds/request and four minutes overall. Admission stops once known usage reaches 50,000 input or 8,000 output tokens. **These are not hard token or billing ceilings**: SIWC removes output tuning; a final response may cross usage limits, and aborting delivery does not guarantee backend computation stops. No automated transport retries are added. Reports mark usage incomplete if a completed request lacks usage. Reports and the synthetic SQLite transcript stay in the private temporary directory printed by the runner. Existing round logs retain IDs, timings, usage and original technical errors; no authentication headers or key material are reported.

Offline regression rehearsal (zero live calls):

```sh
node --import tsx --test tests/real-compaction-eval.test.ts
```

## Real result, 2026-10-20 UTC

Final fixture: **passed**, 3 physical Sol requests, all HTTP 200 and `response.completed`, using Spark source `e3ff1a0129a9def45ec7cf78e79e648d158b8f18`.

| Round | Input tokens | Output tokens | Client duration |
| --- | ---: | ---: | ---: |
| Native summary | 6,417 | 325 | 8.749 s |
| Tool selection | 1,112 | 14 | 3.408 s |
| Final answer | 1,159 | 77 | 3.753 s |
| Total | 8,688 | 416 | 15.968 s overall |

All six exact values survived in the summary and final JSON. The fresh probe ran once and its proof appeared in the final JSON. Active context shrank from 16 to 8 messages; the original visible transcript remained intact and survived SQLite reopen without inference. Spark's existing journal logs independently matched all three signed round IDs, `compaction`/`generation` kinds and terminal completions. No model/provider errors occurred.

An initial three-request run also passed (8,638 input / 381 output tokens, 15.844 s), but duplicated tool evidence in the seed user facts. The final fixture removed that weakness and was rerun. **Total actual usage for this task: six requests, 17,326 input and 797 output tokens; no cache-read tokens reported.** No further real calls were needed for implementation/CI checks. This single synthetic final case establishes a bounded quality result; it does not establish general long-context summary quality or resolve every production compaction/recovery scenario.
