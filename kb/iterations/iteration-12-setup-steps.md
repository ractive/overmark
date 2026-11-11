---
type: iteration
title: "Iteration 12: setup steps per AI app in the pairing box"
status: completed
description: "Client 0.12.1 and relay 0.9.0; the pairing box gets a collapsed \"How do I add it?\" with the client library's steps per AI app (Claude, ChatGPT, Claude Code, Codex), each command with its own Copy, the guide link last; the questions escape with the library's escapeInvisible."
timestamp: 2026-11-11T12:00:00+01:00
tags: [iteration, mcp, ui]
---
# Iteration 12: setup steps per AI app in the pairing box

tab-mcp client 0.12.0 offers the connect dialog's steps per AI app as data
(`@ractive-ch/tab-mcp-client/setup`), and tab-mcp for Chrome shows them in its pairing
box. Overmark's pairing box had only a link to the guide. It now shows the same steps,
as the tab-mcp extension does, adapted to Overmark's `h` helper and style.

## Scope

- `@ractive-ch/tab-mcp-client` 0.12.1 (0.12.0's npm build carried Bun's chunk preload
  map; in Overmark's build it sat in `background.js` as dead code, as a service worker
  has no document, and 0.12.1 drops it), the relay `@ractive-ch/tab-mcp` 0.9.0 (the e2e
  tests' relay) and the README's Docker tag.
- `src/sidepanel/setup.ts`: `setupSteps(address, announce)` from
  `setupInstructions(SERVER_NAME, address)`; `copyText` (Copy, then "Copied" and the
  label too; a refused clipboard selects what the button copies and says "Selected:
  copy it with Ctrl+C or ⌘C"); `startSetup()`, which makes the list again only when the
  address changes (a "Copied" and the focus stay) and sets the guide link from
  `SETUP_GUIDE`.
- The pairing box: a collapsed `<details>` "How do I add it?" under the address, the
  guide link last in it ("Step by step, and what to do when it fails") instead of the
  separate how-to link; a `role="status"` line outside it for what a Copy did, also for
  the address's and the code's Copy. One line is kept for it, so the box does not move.
- `SERVER_NAME` ("overmark") in `src/worker/protocol.ts`, for the worker's `TabMcp` and
  the steps' commands.
- The questions escape with the library's `escapeInvisible` (`/visible`, new in 0.12.0)
  instead of Overmark's own pattern: it also escapes variation selectors and the other
  default-ignorable characters, private-use, unassigned and lone surrogate code points,
  and writes characters beyond U+FFFF as JSON's surrogate pairs.

## Tasks

- [x] Dependencies and the README's relay tag
- [x] `setup.ts` and the pairing box, light and dark, at narrow width
- [x] The questions' escaping from the library
- [x] Unit tests (`test/setup.test.ts`, happy-dom on the panel's page): the apps in
      order, the commands with `dir="ltr"` and their Copy labels, Copy and "Copied", a
      refused clipboard selecting the command, the list kept for the same address and
      made again for another, an address that is not shell-plain without commands, the
      guide link last and the status line outside the details
- [x] Docs: README, this file, the log

## Left open

- Relay 0.9.0 closes a session that never had a grant, never paired and never got a
  request after 10 minutes (`bye idle`). With "Keep AI access on" and no AI app paired,
  Overmark connects again at once each time, as the relay expects of the extensions.
  Left as it is.

# Citations

- [tab-mcp CHANGELOG: client 0.12.0 and 0.12.1, relay 0.9.0](https://github.com/ractive/tab-mcp/blob/main/CHANGELOG.md)
- [tab-mcp for Chrome: the pairing box's setup steps](https://github.com/ractive/tab-mcp/blob/main/packages/tab-mcp-extension/src/sidepanel/setup.ts)
