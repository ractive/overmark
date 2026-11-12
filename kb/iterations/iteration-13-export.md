---
type: iteration
title: "Iteration 13: Export says where the file went, Export all cases, tooltips"
status: completed
description: "Export shows the saved file's path with Copy and Show in folder, through the optional downloads permission asked at the first Export (a no saves as before); Export all cases writes one zip with a folder per case, which Import a case… reads case by case; the side panel's buttons get tooltips (DEC-020)."
timestamp: 2026-11-12T12:00:00+01:00
tags: [iteration, export, ui]
---
# Iteration 13: Export says where the file went, Export all cases, tooltips

The owner decided on 2026-11-10 that Export should say where the file went, that all
cases should go out in one file, and that the panel's buttons should say what they do.
The decision is DEC-020.

## Scope

- `downloads` as an optional permission (`scripts/build.ts`; the test build has it at
  install); `src/sidepanel/download.ts` asks for it in the click and saves through
  `chrome.downloads` or, without it, as before.
- Under Export and under Export all cases: "Saved as", the path, Copy and Show in
  folder; while Chrome's prompt is open, what the answer does.
- `exportAllCases`, `readExports` and `caseFolders` in `src/lib/export.ts`: one zip with
  a folder per case in the single-case layout; Import a case… reads either kind, and a
  file of several cases goes in case by case with the usual question for a case that is
  here already (Skip instead of Cancel), then says how many were imported.
- Tooltips on the side panel's buttons (index.html, view.ts, ai.ts).
- README, PRIVACY.md, the store listing's permission table, DEC-020, the log.

## Tasks

- [x] The optional permission, asked in the click; saving through downloads or as before
- [x] The path with Copy and Show in folder, for one case and for all
- [x] Export all cases and its import, with unit tests (round trip, a single-case file
      still imports, a bad file refused with a message naming the folder, a case twice)
- [x] Tooltips
- [x] End-to-end: the path, Copy and Show in folder after Export and Export all cases;
      Export with Chrome's prompt answered no saves the old way and shows no path; all
      cases imported into an empty store and again with Skip for each
- [x] Docs
- [x] Review of PR 35: the unpacked size of a file of all cases counted for the whole
      file (declared sizes before unpacking, then what was unpacked), at most 256 MB
      (was 512 MB); Export all refuses naming the cases too large to import again, and
      counts the zip's headers; the import checks every case first without keeping its
      images, then unpacks and stores one case at a time; one import at a time, with
      Import a case… and Export all cases disabled meanwhile. Unit tests for each, and
      the end-to-end test chooses a second file while the first one's question is open

## Left open

- Chrome's real prompt for `downloads` is not tested end to end (CDP cannot answer it);
  the test build has the permission at install. Whether `chrome.downloads` is there in
  the panel right after a yes in the same page, without a reload, is Chrome's binding
  behaviour; it was not tried by hand in branded Chrome.
- Importing a file of all cases into a browser that has them all asks once per case;
  there is no "the same for all".
- Export of a single case does not check its size: a case over 150 MB still gets a file
  that Import a case… refuses (Export all cases checks each case, see DEC-020).

# Citations

- [Chrome extensions: chrome.downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads)
- [Chrome extensions: chrome.permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
