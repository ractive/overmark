---
type: iteration
title: "Iteration 9: the AI settings in the worker's IndexedDB"
status: completed
description: "The address secret and the AI settings move from chrome.storage.local, which content scripts may reach, into an IndexedDB database the service worker alone uses (DEC-016); nothing is taken from chrome.storage.local, only deleted; the panel's localStorage handover stays, in one transaction; the side panel changes the settings only over its port; setAccessLevel best effort; Chrome 116 again."
timestamp: 2026-11-09T15:00:00+01:00
tags: [iteration, mcp, security]
---
# Iteration 9: the AI settings in the worker's IndexedDB

Iteration 8 (overmark#26) kept the address secret and the AI settings in
`chrome.storage.local`, closed to content scripts with `setAccessLevel`, fail closed, and
Chrome 140 as the minimum. Whether the local area's access level applies at all is
unclear (Chromium's `storage.json` and MDN say session only), and a level that does not
apply does not throw. This ports the tab-mcp extension's fix (its PR 89 and PR 91: `worker/kv.ts`, the old
area only cleaned up); the decision is DEC-016.

## Scope

- `src/worker/kv.ts`: `openKv` (database `overmark-settings`, store `settings`, in the
  extension's origin, used by the worker only, opened again after Chrome closes it or a
  `versionchange`; the cases' `overmark` database untouched), `memoryKv` for tests,
  `removeOldSettings`.
- The connection, the secret's write-through cache and the settings on it; the session
  flag stays in `chrome.storage.session` (DEC-016 says why).
- `chrome.storage.local`: the keys iteration 8 kept there (only the owner's unreleased
  build) are deleted at every start and never taken over; that build's AI apps pair once
  more.
- The panel's `localStorage` handover (builds before iteration 8): secrets first, then
  Keep AI access on, the relay, Blur form fields and `panelHandedOver` in one
  transaction, then connect or switch relay; cut short, it runs again whole.
- The side panel: Blur form fields over the port (`blur-forms`) and from the worker's
  state, like Keep AI access on and the relay; it touches no storage of the settings.
  Settings change in the worker's memory only after the write succeeded; the tools read
  blur from there at each call. The worker tells open overlays its blur value when it
  changes, when it starts and when a panel attaches; without the worker's value in 2 s,
  or with a worker that failed, the panel blurs; a worker that cannot start tells the
  panel why.
- `setAccessLevel` best effort (logged); no fail-closed path; `minimum_chrome_version`
  116.
- README, PRIVACY.md, the store listing, the overview, DEC-015 marked, DEC-016.

## Tasks

- [x] `kv.ts` and the connection, secret and settings on it; reopening a closed database
- [x] `chrome.storage.local` cleaned up at every start, nothing imported
- [x] The panel's handover in one transaction
- [x] The panel's blur setting over the port; the worker's state carries it; overlays
      told at start and on a panel's attach; blur on without the worker's value
- [x] A failed start reported to the panel
- [x] `setAccessLevel` best effort, Chrome 116
- [x] Unit tests: a settings contract run on `memoryKv` and, in the browser, on `openKv`
      (reads, writes, copies, an all-or-nothing write); a database deleted under an open
      `Kv` opened again; the old keys removed and never taken; the panel's bundle touches
      neither `chrome.storage` nor the database
- [x] End-to-end: iteration 8's keys in `chrome.storage.local` (and a content script's
      relay) deleted at the next start, the relay and the address unchanged; a handover
      cut short before its settings runs again whole and keeps the address; Blur form
      fields through the real side panel, for the tools and the open overlays, and told to
      them at a worker start and a panel's attach; a worker whose database cannot be
      opened says so in the panel, which then starts an overlay with blur on
- [x] Docs

## Left open

- Nothing of this iteration.

# Citations

- [Chrome extensions: storage access levels](https://developer.chrome.com/docs/extensions/reference/api/storage#method-StorageArea-setAccessLevel)
- [MDN: StorageArea.setAccessLevel()](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/StorageArea/setAccessLevel)
- [Chromium: extensions/common/api/storage.json](https://source.chromium.org/chromium/chromium/src/+/main:extensions/common/api/storage.json)
- [Chrome extensions: WebSockets in service workers (Chrome 116)](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
