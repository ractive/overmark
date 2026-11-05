---
type: iteration
title: "Iteration 7: full review"
status: in-progress
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
- [ ] Matching, side panel and AI tools, build and documents
- [ ] Review of the fixes, merge
- [ ] More testing in the browser

## Left open

- Marks live in the page until saved: an extension update replaces the content script and
  they are gone with it. Saving them with the pending screenshots would need a way to
  offer them again.
- Prod → dev and prod → localhost by a person in their own Chrome.
