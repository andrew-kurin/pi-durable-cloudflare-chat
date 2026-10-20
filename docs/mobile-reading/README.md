# Reading space and compact controls

Matching local Chrome renders before (main 39a4825) and after this pass. Synthetic saved messages, titles and connection/interruption states only; no live user data, model calls, or production operations.

| View | Before | After |
| --- | --- | --- |
| 390×460 simulated visual viewport, long draft | [Before](mobile-short-before.png) | [After](mobile-short-after.png) |
| Desktop chat details | [Before](desktop-title-before.png) | [After](desktop-title-after.png) |
| Mobile title/actions | Existing clipped row | [Full title in existing menu](mobile-title-menu.png) |
| Short-screen reconnect state | — | [Recovery stays visible](mobile-reconnect.png) |

The short-viewport fixture leaves 256px of transcript space versus 162px before (+94px). Its composer is 96px versus 158px, with a scrolling textarea capped at 82px rather than 144px. Healthy history status is quiet on mobile; loading, unavailable and reconnect states remain visible, including on short screens. Workspace controls remain available. Composer sizing uses the visual viewport so it can react when the keyboard reduces visible space without changing the layout viewport.

Full titles are inert, wrapping text in the existing chat-info panel and history row action menu. History action targets are 44×44px. The composer has a rounded visible focus outline, and links have a visible keyboard focus outline. Sampled history text/icon contrast against the app surface is 10.63:1 and the focus ring is 6.90:1; this is a focused check, not a complete accessibility audit.

`tests/mobile-reading.mjs` runs in browser CI. It verifies full title access, icon target dimensions and accessible names, menu Escape behavior, actual repeated tall/short viewport transitions, retained drafts/reading position, long-draft internal scrolling, reconnect visibility/recovery, interruption/workspace disclosure, focus indication, no horizontal overflow, no page errors, and no submit/workspace mutation requests. Existing browser/history and visual-viewport resize/pan/zoom regressions also pass. A unit regression checks full-title updates and hostile-looking titles remain inert.

Reproduce locally:

```sh
node tests/mobile-reading.mjs
```

Optional baseline capture (requires the named commit locally):

```sh
PI_UI_BASE_REF=39a4825267893cb53f95cedd2d51e644aca7f57d \
PI_UI_CAPTURE_DIR=.runtime/mobile-reading-before node tests/mobile-reading.mjs
```

**Limitations:** Chrome mobile emulation and synthetic visualViewport events are not a physical iPhone, Safari keyboard, or assistive-technology test. Authenticated live UI was not accessed. No deployment or model/runtime behavior changes are included.
