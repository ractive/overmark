---
type: iteration
title: "Iteration 7: full review"
status: completed
description: "A review of the whole codebase by four Claude reviewers and GLM: 70 findings, 57 distinct. Screenshots moved to the moment a mark is drawn, which removed the cause of the worst ones; the rest fixed or answered."
timestamp: 2026-11-05T09:00:00+01:00
tags: [iteration, review]
---
# Iteration 7: full review

The owner asked for the full review left open after iteration 6, then for its findings to
be fixed and the result tested in the browser.

## Scope

- Reviewers per area (page, data, side panel and tools, build and documents) and GLM over
  everything. 70 findings, 57 distinct, 5 high.
- DEC-012: a mark's screenshot is taken when it is drawn.
- Every finding fixed, or answered with a reason.

## Tasks

- [x] Review of the whole codebase
- [x] Screenshots at the mark; marks follow their element; unsaved marks ask before leaving
- [x] Matching, side panel and AI tools, build and documents
- [x] Review of the fixes (claude 7, glm 4, 9 distinct), merge (PR #9)
- [x] More testing in the browser: the store package on a real site's dev pages, the
  measurement of iteration 6 again with the stricter matching

## Left open

- Marks live in the page until saved: an extension update replaces the content script and
  they are gone with it. Saving them with the pending screenshots would need a way to
  offer them again.
- Keys pressed in the comment field can still be seen by a page's own capture listeners;
  the privacy policy says so. Keeping them away would need the comment field in an
  extension frame.
- A click on an icon picks the `path` inside it, not the `svg` or the button: such a mark
  is honest about it (at most probable), but a person would have meant the button.
- Editors other than Monaco, CodeMirror 5 and Ace that draw typed text as page content
  are not recognised; the privacy policy says so.
- Prod → dev and prod → localhost by a person in their own Chrome.
