# Verified local SIWC results

Owner-approved personal/local OSS checks on the Mac, October 18, 2026. These are a manually curated nonsecret summary, not raw runtime reports. No credentials, identity, authorization URLs, host/client IDs, hidden reasoning or raw SSE are included.

| Check | UTC start | Requests | Result |
| --- | --- | --- | --- |
| Sol text (`gpt-6.1-sol`) | 15:07:23 | 1 | Passed; text observed, `response.completed` |
| Sol fixed tool (`gpt-6.1-sol`) | 15:25:27 | 2 | Passed; one `test_status({})` returning `offline-marker`, then “Confirmed: offline-marker.” |
| Luna text (`gpt-6-luna`) | 15:25:32 | 1 | Passed; “Compatibility is OK.” |

All four successful responses returned HTTP 200 without Content-Type. Native SSE parsing and a completed terminal event were required; metadata was captured before response reconstruction. The tool result used the actual returned call ID in full-context continuation. The fixed tool has no environment access. No retries, refresh, API-key fallback or paid-credit opt-in occurred. Prior consumed audits and protected credentials were unchanged by the fresh inference checks.

The account-specific catalog GET completed with HTTP 200, `application/json`, 569,147 bytes and nine entries. Both requested model slugs were listed with `visibility:list` and `supported_in_api:true`. An earlier 256 KiB catalog limit was insufficient; the current limit is 2 MiB. Catalog instruction metadata is not published.

Earlier failed checks are preserved as failures: the old content-type guard cancelled their bodies before parsing and caused a generic SDK connection error. Those discarded bodies cannot now be classified. Offline native HTTP regressions reproduced and fixed the guard; fresh live checks above established success through the corrected path.

These results establish only the tested local compatibility. The standalone service remains fake-only. No Spark service, credential transfer, refresh owner, authenticated remote transport, Worker integration, hosted-hybrid eligibility, production recovery or live browser UI QA is established. In-app Disconnect remains absent and documented. No production flags or defaults were activated.
