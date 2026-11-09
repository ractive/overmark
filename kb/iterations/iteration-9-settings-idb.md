---
type: iteration
title: "Iteration 9: the AI settings in the worker's IndexedDB"
status: completed
description: "The address secret and the AI settings move from chrome.storage.local, which content scripts may reach, into an IndexedDB database the service worker alone uses (DEC-016); moved once, never imported again; the side panel changes them only over its port; setAccessLevel best effort; Chrome 116 again."
timestamp: 2026-11-09T15:00:00+01:00
tags: [iteration, mcp, security]
---
# Iteration 9: the AI settings in the worker's IndexedDB

Iteration 8 (overmark#26) kept the address secret and the AI settings in
`chrome.storage.local`, closed to content scripts with `setAccessLevel`, fail closed, and
Chrome 140 as the minimum. Whether the local area's access level applies at all is
unclear (Chromium's `storage.json` and MDN say session only), and a level that does not
apply does not throw. This ports the tab-mcp extension's fix (its PR 89: `worker/kv.ts`,
the one-off move with a marker); the decision is DEC-016.

## Scope

- `src/worker/kv.ts`: `openKv` (database `overmark-settings`, store `settings`, in the
  extension's origin, used by the worker only; the cases' `overmark` database untouched),
  `memoryKv` for tests, `migrate(old, kv)`.
- The connection, the secret's write-through cache and the settings on it; the session
  flag stays in `chrome.storage.session` (DEC-016 says why).
- The move from `chrome.storage.local`: once, entries and the `movedFromStorage` marker in
  one transaction; with the marker, setting keys found there are only removed. The
  panel's `localStorage` handover (builds before iteration 8) as before, guarded by
  `panelHandedOver` (iteration 8's `migrated`).
- The side panel: Blur form fields over the port (`blur-forms`) and from the worker's
  state, like Keep AI access on and the relay; it touches no storage of the settings. The
  worker tells open overlays a changed blur setting. The tools read blur from the store
  at each call.
- `setAccessLevel` best effort (logged); no fail-closed path; `minimum_chrome_version`
  116.
- README, PRIVACY.md, the store listing, the overview, DEC-015 marked, DEC-016.

## Tasks

- [x] `kv.ts` and the connection, secret and settings on it
- [x] The move from `chrome.storage.local`, once, with the marker
- [x] The panel's blur setting over the port; the worker's state carries it
- [x] `setAccessLevel` best effort, Chrome 116
- [x] Unit tests: a settings contract run on `memoryKv` and, in the browser, on `openKv`
      (reads, writes, copies, an all-or-nothing write, the move once, the marker on a first
      start, a value written after the move only removed, written before removed, a newer
      value kept); the panel's bundle touches neither `chrome.storage` nor the database
- [x] End-to-end: after an update from iteration 8's storage the same address answers and
      the panel shows the settings; a relay written into `chrome.storage.local` (by a
      content script, refused here, and written there all the same) is never used; Blur
      form fields through the real side panel, for the tools and the open overlays
- [x] Docs

## Left open

- On a Chrome where content scripts could write `chrome.storage.local`, what one wrote
  there while iteration 8 was installed is taken once by the move (DEC-016).

# Citations

- [Chrome extensions: storage access levels](https://developer.chrome.com/docs/extensions/reference/api/storage#method-StorageArea-setAccessLevel)
- [MDN: StorageArea.setAccessLevel()](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/StorageArea/setAccessLevel)
- [Chromium: extensions/common/api/storage.json](https://source.chromium.org/chromium/chromium/src/+/main:extensions/common/api/storage.json)
- [Chrome extensions: WebSockets in service workers (Chrome 116)](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
