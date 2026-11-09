---
type: iteration
title: "Iteration 8: the AI connection without the side panel"
status: completed
description: "The connection to the AI app moves from the side panel into the service worker (DEC-015), so it stays while the panel is closed and comes back after a restart; the panel becomes a view with a plain pairing view of its own; a tool that changes something asks in the side panel of the window in front, else in a Chrome notification."
timestamp: 2026-11-09T12:00:00+01:00
tags: [iteration, mcp]
---
# Iteration 8: the AI connection without the side panel

The owner, 2026-11-09: Overmark's AI connection must stay up while the side panel is
closed, as the tab-mcp extension's does since its iteration 26. Until now `TabMcp` ran in
the panel's page (DEC-004): closing the panel ended it, and the AI app's next call failed.
The port follows tab-mcp's main branch (its `packages/tab-mcp-extension`); the decision is
DEC-015.

## Scope

- `TabMcp` with Overmark's tools in the service worker (`src/worker/`). The tools are
  the same (`src/worker/tools.ts`, moved from the panel); "the tab in front" is the
  active tab of the last focused normal window; screenshots go through the worker's own
  capture queue, no message any more (the panel's `capture:tab` is gone).
- The address secret in a write-through cache over `chrome.storage.local`
  (`CachedSecretStorage`), `connect({ resume: true })`, no dynamic `import()` in the
  worker's bundle (a unit test checks the build).
- "Keep AI access on" (`KeepOn`, moved) in the worker: it connects at every worker start,
  after an idle or expired session, and goes on trying. Without it a connection lasts
  until the relay ends it, "Stop AI access", the browser closes, or the extension is
  updated, reloaded or disabled (`chrome.storage.session` is cleared then), across
  worker restarts. An alarm once a minute while AI
  access is on restarts it after a sleep.
- One named port from the side panel, its sender checked: this extension's page at the
  panel's path, not in a tab. Content scripts cannot command; their one-off messages are
  the old ones (`isWorkerRequest`). `chrome.storage.local` is for trusted contexts only
  (`setAccessLevel` for the local area works from Chrome 140, now the manifest's
  minimum); where Chrome refuses, no secret is kept and AI access stays off.
- The panel as a view: the header (status, Connect/Manage, Stop AI access, last AI call),
  "Keep AI access on" and the relay field as before; the library's dialog cannot draw from
  the worker, so a plain pairing view of its own (`src/sidepanel/ai.ts`): the address
  with Copy, the code, connected apps with Disconnect, New address, the takeover notice.
  It is kept to the minimum on the owner's word: the tab-mcp extension is finishing its own
  AI access UI, and Overmark takes that over later as a whole, so all of it is in one
  module.
- Questions (DEC-008: every call asks, no Always allow): in the side panel of the window
  in front when it is open and focused, else also a Chrome notification; the first answer
  counts, 60 s without one is Don't allow. The badge says "?" while one waits, "on" while
  connected.
- The panel's `localStorage` (relay, Keep AI access on, Blur form fields, the secret) is
  handed to the worker once, when the side panel first opens, so the address stays.
- Permissions `alarms` and `notifications`; README, PRIVACY.md and the store listing say
  why.

## Tasks

- [x] The worker's connection, settings, secret storage, keep-on and alarm
- [x] The port, its sender check, the commands parsed; unit tests
- [x] Questions in the panel or a notification, the timeout, the badge; unit tests
- [x] The panel's AI section on the worker's state; pairing view; migration
- [x] End-to-end: connect, close the panel, an AI app still calls a tool; a question in
      the panel and through the notification (the worker's own button handler over the
      DevTools Protocol); a panel closed during a question; reopening shows the same
      state; a stopped worker connects again with the same address; content scripts and
      the panel page in a tab get no port; the old address kept; existing tests on the
      real side panel
- [x] Permissions, README, PRIVACY.md, store listing, DEC-015

## Left open

- The icon's click still opens the panel with `sidePanel.open` in `action.onClicked`. The
  tab-mcp extension found that this does nothing while another extension's side panel is
  open and is trying `openPanelOnActionClick` instead; for Overmark that would move the
  `activeTab` grant, the injection and the case loading of the icon's click
  (`pendingLoad`) into the panel's opening, which waits for their result there.
- The AI access UI is a stopgap until the tab-mcp extension's (its branch
  `ext/panel-clarity`) is settled.
- How notifications look and stay on macOS, Windows and Linux is not tested here.

# Citations

- [Chrome extensions: WebSockets in service workers (Chrome 116)](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
- [Chrome extensions: notifications](https://developer.chrome.com/docs/extensions/reference/api/notifications)
- [Chrome extensions: storage access levels](https://developer.chrome.com/docs/extensions/reference/api/storage#method-StorageArea-setAccessLevel)
- [Chromium a8f1f337c6: setAccessLevel() for the local and sync areas](https://chromium.googlesource.com/chromium/src/+/a8f1f337c6)
  (commit position 1482413, between the branch points of M139 at 1477651 and M140 at
  1496484, so Chrome 140)
