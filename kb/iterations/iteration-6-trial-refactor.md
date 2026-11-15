---
type: iteration
title: "Iteration 6: trial on dev pages and the refactor"
status: completed
description: "Overmark on the dev pages of a real site (matching measured, a scale bug found and fixed), then three refactors the reviews asked for: an allow-list of recorded details, one state machine per page, and a side panel drawn from one state."
timestamp: 2026-11-04T23:00:00+01:00
tags: [iteration, pilot, refactor]
---
# Iteration 6: trial on dev pages and the refactor

After two review rounds (60 and 26 findings) the owner chose a trial on real pages and a
refactor of the three areas the findings kept coming from, instead of a third round.

## Scope

- Trial on four dev pages of a real site: 24 or 25 of 25 marks found their element
  again after a reload, 22 to 24 at phone width, in about 30 ms; with a reusable
  measurement `test/e2e/pilot.ts` that uses the extension's own search
  (`src/lib/candidates.ts`, moved out of the reviewer).
- Fixes from the trial: crops at the captured image's scale; of tied candidates the
  visible one wins.
- An allow-list of what is recorded about an element (DEC-009).
- One state machine per page in the content script (DEC-010).
- The side panel drawn from one state (DEC-011).

## Tasks

- [x] Matching measurement on four dev pages; UI on a real page
- [x] Scale fix with an end-to-end test that fails without it; visible ties
- [x] `ATTRIBUTE_RULES` and the recorded-fields table; links without query; test
- [x] `PageActivity` replaces the save and AI flags; unit tests
- [x] `PanelState`, `Latest`, `view.ts`; end-to-end test for typing during a change and delete

## Left open

- A full review of the whole codebase (the owner's step 3).
- Prod → dev and prod → localhost by a person in their own Chrome.
