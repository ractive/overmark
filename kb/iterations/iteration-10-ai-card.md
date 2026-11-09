---
type: iteration
title: "Iteration 10: the tab-mcp extension's AI app card"
status: completed
description: "The side panel's plain pairing view gives way to the tab-mcp extension's AI app card (DEC-017): an AI access switch, Turn on AI access, the address and code at once with no app paired, + Add another AI app, Disconnect asking first; a panel covered by another extension's panel hands its questions to notifications."
timestamp: 2026-11-09T18:00:00+01:00
tags: [iteration, mcp, ui]
---
# Iteration 10: the tab-mcp extension's AI app card

Iteration 8 gave the side panel a plain pairing view of its own until the tab-mcp
extension settled its AI access UI. Its PR 88 did; the owner asked to copy it once done.
The decision is DEC-017.

## Scope

- `src/sidepanel/card.ts`: the tab-mcp extension's card rules on Overmark's `AiState`
  (`cardStatus`, `cardView`, `confirms`, `switchShown`).
- The home view's "AI app" section becomes the card: the switch, the state, the apps
  with Disconnect, the takeover notice and problems, "Turn on AI access", "+ Add another
  AI app", the address and code with Done and New address; the relay and "Keep AI access
  on" under it. The pairing box above the home view goes.
- The header pill leads to the card (leaving an open case), turning AI access on if it
  was off; "Stop AI access" stays in the header.
- The panel tells the worker whether it is on screen (`visible`); a hidden panel's
  questions go out as notifications.
- README, PRIVACY.md, DEC-017, the log.

## Tasks

- [x] The card and its rules, with unit tests
- [x] The header pill and the view's AI parts on the card
- [x] `visible` in the protocol, the worker and the questions
- [ ] The panel opened with the tab (left out: it broke the store package's e2e test in
      CI, see DEC-017)
- [x] End-to-end: pairing flows on the card (the address at once, "+ Add another AI app"
      and Done with an app listed), a covered panel's questions as notifications and the
      panel asking again once on screen, the switch disabled when the worker failed
- [x] Docs

## Left open

- `sidePanel.open({ tabId, windowId })`, so the icon shows Overmark's panel over Claude
  in Chrome's: it made "a click on the icon opens the side panel, and marks can be saved
  on that tab only" (`test/e2e/shipped.test.ts`) fail in CI on Linux, where a click with
  the Element tool went past the overlay; not reproduced on macOS.
- Overmark's harness could not run the tab-mcp extension's test with a second
  extension's panel (that extension's worker did not start, and its icon click hung).
- By hand in branded Chrome with Claude in Chrome's panel open (covered panel,
  notifications).

# Citations

- [tab-mcp PR 88: panel over another's, clearer AI app card](https://github.com/ractive/tab-mcp/pull/88)
- [Chrome extensions: sidePanel.open()](https://developer.chrome.com/docs/extensions/reference/api/sidePanel#method-open)
