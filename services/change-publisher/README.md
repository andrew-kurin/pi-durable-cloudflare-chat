# Isolated draft-PR publisher

This optional service receives owner-authorized immutable source proposals from the Worker, reconstructs the fixed public harness repository, and creates a verified signed commit plus draft PR on a dedicated branch. It never runs project code and has no merge or deploy API. It is disabled/unprovisioned by default.

See [the complete contract and pending setup](../../docs/harness-proposals.md), including credential isolation, file limits, observed-check limitations and forward-only uncertain-outcome handling. Do not start/configure it against a real credential or endpoint without the separate setup approval described there.

Local verification uses synthetic credentials, temporary SQLite journals, offline Git objects and intercepted HTTP. Run `npm run typecheck` and `node --import tsx --test tests/change-*.test.ts tests/workspace-verification.test.ts` from the repository root. Real GitHub signing, network authentication and production integration remain separate checks.
