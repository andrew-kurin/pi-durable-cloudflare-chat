# Tool and workspace status usability pass

Local headless Chrome renders of the same synthetic fixture, before (main a73451d) and after this change. No production/user chat or model calls. Mobile 390×844; desktop 1280×900. These are simulated mobile viewports, not physical iPhone or keyboard validation.

| View | Before | After |
| --- | --- | --- |
| Expanded mobile tool | [Before](mobile-tool-before.png) | [After](mobile-tool-after.png) |
| Mobile workspace | [Before](mobile-workspace-before.png) | [After](mobile-workspace-after.png) |
| Desktop chat | [Before](desktop-chat-before.png) | [After](desktop-chat-after.png) |

The fixture uses real display projection of structured workspace/tool results: a successful status invocation reporting a running process, accepted command dispatch, and a file read. Status checks say “Status checked” and command dispatch says “Request accepted”; neither implies the process has exited. Summaries use actual process states and exit codes. Existing historical labels still render.

Expanded details preserve inputs, raw outputs, errors, duration and truncation information. Generic completed prose, duplicate summaries, and absent/empty-output paragraphs are omitted; empty files are identified in the preview instead.

“Stop workspace” names the cancellation scope. Workspace and command deadlines include date and timezone. “Workspace +30 min” explicitly concerns workspace time; its title notes that command time is unchanged. Command extensions are disabled when there is no active running/dispatching command. Backend cancellation, extension caps and command execution behavior are unchanged.

Browser checks: no horizontal overflow at 390/320/1280 widths; no page errors; disclosure state/focus, raw output keyboard scrolling, workspace panel scrolling, draft preservation and menu dismissal passed. No command POSTs or inference were sent. Header, composer and transcript-area dimensions remained unchanged. This pass does not redesign the mobile layout.
