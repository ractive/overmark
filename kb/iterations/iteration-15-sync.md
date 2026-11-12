---
type: iteration
title: "Iteration 15: one-way sync of the cases to a folder"
status: completed
description: "Sync to a folder…: the user picks a folder once (File System Access API) and the service worker writes each case there as its single-case export, again whenever it changes; a deleted case keeps its file, nothing is read back; Chrome's permission lasts only while the side panel is open, so the panel shows Sync paused with Allow access, and changes made meanwhile are written then (DEC-021)."
timestamp: 2026-11-12T12:00:00+01:00
tags: [iteration, export, sync, ui]
---
# Iteration 15: one-way sync of the cases to a folder

The owner decided on 2026-11-10 that the cases should be kept in a folder the user picks
once, one-way, a file per case as Export writes it, a deleted case keeping its file. The
decision, with what was found out about Chrome on the way, is DEC-021.

## Scope

- `src/lib/sync.ts`: `Sync`, the one writer (a run compares each case's version with what
  was written; file names, rename, failures, paused), its store in the database
  `overmark-sync` (a record of what was written for each folder), and `chooseFolder`,
  which gives a folder synced before its id back.
- `src/lib/kv.ts`: the small key-value database, out of the worker's settings module,
  so that the side panel's bundle, which opens the sync's database, still never names
  the settings' database (the bundle test checks it). `kvWhenOpen` opens it at the
  first use and again after a failed open.
- The service worker runs it at each start, after its own changes (saves, Undo, the AI
  tools through `ConnectionDeps.changed`), on the side panel's `cases:changed` and on
  `sync:run`.
- `src/sidepanel/sync.ts`: the picker, Change folder…, Stop syncing, Allow access, Try
  again, and the test build's `overmarkUseFolder`; the view under the case list
  (`renderSync`), light and dark.
- README, PRIVACY.md, the store listing's description, DEC-021, the log.

## Tasks

- [x] Find out whether the worker can write with the folder's handle (IndexedDB, the
      grant shared with the panel, the grant gone once the last extension page closes)
- [x] `Sync` with unit tests on a folder in memory: writes, skips unchanged, rename,
      deleted case keeps its file, same titles, foreign files, failures, paused;
      A → B → A and A, Stop, B, A update A's files in place (no `-2` copies); a failed
      open of the database is tried again; the panel shows that it cannot read it
- [x] The worker writes after every change; runs never overlap
- [x] The panel: Sync to a folder…, Syncing to, Last synced, Change folder…, Stop
      syncing, Sync paused with Allow access, failures with Try again; tooltips
- [x] End to end with a folder of the private file system: a saved case appears, an AI
      app's change is written again, a deleted case keeps its file, Stop syncing stops
- [x] Docs

## Left open

- The worker writing a real folder after the user granted write access was not seen
  end to end: CDP cannot answer the picker or Chrome's write dialog, the dialog was
  clicked by hand once (granted) but that run checked the wrong worker, and the Mac's
  screen locked before it was repeated. It rests on the grant being the origin's
  (shown for reading: the panel's grant let the worker list a real folder) and on the
  worker writing the private file system.
- Chrome takes the permission back when the side panel closes, so a user who closes
  the panel sees "Sync paused" at every opening, unless Chrome offers and the user
  chooses "Allow on every visit". Whether Chrome offers that to an extension, and
  whether it then lets the worker write with no page open, was not tried.
- A worker that Chrome stops in the middle of a large write may leave Chrome's
  temporary `.crswap` file in the folder; the case is written again at the next run.
- Changes made while the side panel was closed are written only at its next opening
  (with Allow access), not by themselves.
- `folders` and the records keep every folder ever chosen; nothing removes one that
  the user will not choose again. A handful of folders is what is expected.

# Citations

- [File System Access (WICG): permissions, `queryPermission`, `requestPermission`](https://wicg.github.io/file-system-access/)
- [File System Standard (WHATWG): `FileSystemHandle`, `createWritable`](https://fs.spec.whatwg.org/)
- [Chrome for Developers: The File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
- [Chrome for Developers: Persistent permissions for the File System Access API](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)
