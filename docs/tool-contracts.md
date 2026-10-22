# Model tool result contracts

The chat registry keeps the shared `assistant_policy` and conditional
`workspace_policy` sections separate. Both are present when workspace tools are
enabled. Tool names, ownership checks, admission, command deadlines and replay
policies are unchanged.

## Bounded text and JSON

Public read results are complete JSON envelopes capped at 16,000 UTF-8 bytes,
including JSON escaping and metadata. Workspace model results stay below 48 KiB,
leaving room below the pinned Pi SDK's 50 KiB output bound. Neither path slices
serialized JSON. An unexpectedly oversized workspace result returns an explicit
`output_too_large` error instead of malformed content.

`github_read` files accept `offset` and `expectedSha`. `workspace_read` and
`workspace_logs` accept `offset` and `expectedSha256`. Offsets count Unicode code
points, not UTF-16 units or UTF-8 bytes. A nonzero offset requires the hash from
the preceding page. Use the returned `continuation` object as the next call's
arguments to pin the resource and avoid mixing versions. Workspace text pages
contain at most 6,000 code points. Files still have their existing byte limits;
pagination does not bypass them.

Text results expose `offset`, `totalChars`, `nextOffset`, `incomplete` and
`continuation`. A null continuation means no further retained content is
available from that result. Changed content returns a sanitized error and asks
for a fresh first page; it does not repeat an executed command. Public page
extraction, issue/PR bodies, search results and directory listings are bounded
excerpts without continuation. Their results identify incompleteness and say
when repeating the same call cannot recover the omitted content.

Model workspace summaries return 20 run-history entries at a time, newest first.
`runHistory` includes the total, returned count and continuation. Continue using
`workspace_status` with the returned `runsOffset` and workspace ID. A specific
`runId` remains independently addressable through status/wait/logs. The owner UI
and controller retain their full state; model projection does not delete runs.

## File failures

Expected file-helper failures return an error record with `error`, `code` and
`nextStep`; the tool result is marked as an error. Stable allowlisted codes are
`file_not_found`, `file_too_large`, `edit_too_large`, `edit_match_count`,
`target_exists`, `not_text`, `permission_denied`, `path_outside_project` and
`file_operation_failed`. Messages are fixed descriptions and recovery guidance,
not raw Python stderr, paths, tracebacks or credentials.

The controller serializes these records before the Durable Object RPC boundary.
Completed expected-error receipts retain the existing operation fingerprint,
so recovery cannot replay a failed mutation under its old operation ID. Unknown
failures keep the generic failure path. Exact-match edits remain atomic and
preserve permissions; the resulting file must fit the existing 64,000-byte
file-operation limit.

## Log retention and loss

The supervisor still retains only the final 16 KiB of each raw stdout/stderr
stream. It atomically records the retained bytes and cumulative byte counter in
one snapshot, while preserving raw `.log` tails for guest diagnostics. A live
read cannot combine a newer count with an older tail.

Log results add `retention: "tail"`, `limitBytes`, `retainedBytes`, `totalBytes`,
`droppedBytes`, `truncated` and `available`. Counters describe original raw
stream bytes. Displayed text decodes UTF-8 with replacement, so re-encoding text
may have a different byte length when a retained boundary splits a multibyte
sequence. `pageTruncated` describes text pagination separately from `truncated`,
which describes stream bytes already discarded. A final page can therefore have
no continuation and still report `incomplete: true` because stream output was
lost or its earlier retention is unknown.

Existing raw guest logs remain readable with known retained-byte size but
unknown total, dropped and truncation counters. Existing persisted text-only
logs remain readable with null raw counters. Unavailable recordings explicitly
set `available: false`. Unknown/lost bytes are never presented as recoverable.

New exports retain the existing `logs: {name: text}` format and add
`logMetadata: {name: metadata}`. Existing immutable artifacts and operation
journals are not rewritten or cleared. The offline Docker smoke fixture reads
the new adapter log object's `text` field; no live guest is needed to test the
model contracts.

## Regression coverage

Composed-registry tests use the actual pinned SDK and faux providers. Public and
workspace output tests cover escaping, control characters, multibyte/astral
text, SDK output limits, continuation and revision changes. Local helper tests
cover allowlisted failures, atomic edit permissions, stream byte counts, exact
retention boundaries, old log records and additive export metadata. No live
model or provider calls are required.
