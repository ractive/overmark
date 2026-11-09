---
type: iteration
title: "Iteration 10: the tab-mcp extension's AI app card"
status: completed
description: "The side panel's plain pairing view gives way to the tab-mcp extension's AI app card (DEC-017): an AI access switch, Turn on AI access, the address and code at once with no app paired, + Add another AI app, Disconnect asking first; a panel covered by another extension's panel hands its questions to notifications; the icon opens the panel with the tab."
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
- `sidePanel.open({ tabId, windowId })` on the icon's click.
- README, PRIVACY.md, DEC-017, the log.

## Tasks

- [x] The card and its rules, with unit tests
- [x] The header pill and the view's AI parts on the card
- [x] `visible` in the protocol, the worker and the questions
- [x] The panel opened with the tab
- [x] End-to-end: pairing flows on the card (the address at once, "+ Add another AI app"
      and Done with an app listed), a covered panel's questions as notifications and the
      panel asking again once on screen, the switch disabled when the worker failed
- [x] Docs

## Left open

- Overmark's harness could not run the tab-mcp extension's test with a second
  extension's panel (that extension's worker did not start reliably, and its icon click
  hung); the open call is the tab-mcp extension's, which its CI tests that way.
- By hand in branded Chrome with Claude in Chrome's panel open.

# Citations

- [tab-mcp PR 88: panel over another's, clearer AI app card](https://github.com/ractive/tab-mcp/pull/88)
- [Chrome extensions: sidePanel.open()](https://developer.chrome.com/docs/extensions/reference/api/sidePanel#method-open)
