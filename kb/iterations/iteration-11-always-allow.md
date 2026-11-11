---
type: iteration
title: "Iteration 11: Always allow for AI apps"
status: completed
description: "Always allow comes back (DEC-018): per AI app and tool from a question in the side panel or a notification, and Allow all changes per app in the AI app card, with Ask again for each tool; kept in the worker's settings database until the app is disconnected."
timestamp: 2026-11-10T16:00:00+01:00
tags: [iteration, mcp, ui]
---
# Iteration 11: Always allow for AI apps

Every change an AI app asked for was confirmed each time (DEC-008). The owner decided on
2026-11-10 to bring "Always allow" back, per tool and for all of an app's changes, until
the app is disconnected. The decision is DEC-018; the model is the tab-mcp extension's
Always allow (`always.ts`, `decide.ts`, its question card and notifications), kept per
grant and tool instead of per page, and stored.

## Scope

- `src/worker/always.ts`: `AlwaysAllowed`, per grant the tools always allowed and Allow
  all changes, in the worker's settings database (`alwaysAllowed`), changed one after
  the other, in memory only once written; `keepGrants` with each list of grants.
- `src/worker/decide.ts`: no question for a tool always allowed or an app with Allow all
  changes; Always allow kept only for an app still connected.
- Questions: "Always allow" in the panel with its one-line explanation, armed with
  Allow; notifications with Allow and Always allow, closing one is Don't allow.
- The AI app card: under each app the switch "Allow all changes" and the tools always
  allowed, each with "Ask again". Panel commands `allow-all` and `ask-again`, checked in
  `protocol.ts`; the answer `always`.
- README, PRIVACY.md, DEC-018, the log.

## Tasks

- [x] The store and the decision, with unit tests
- [x] Always allow in the panel's questions and in notifications
- [x] Allow all changes and Ask again in the AI app card
- [x] Entries gone with the grant (Disconnect, New address, the relay's list)
- [x] End-to-end: Always allow skips the next question of that tool for that app but
      not another tool; Allow all changes skips every tool; Ask again asks again; the
      notification's Always allow, also after a worker restart; Disconnect forgets it
- [x] Tests that asserted the old buttons updated
- [x] Docs

## Left open

- Overmark has no "turn AI access off and forget the apps": Stop AI access and the
  switch keep the pairing, so they keep Always allow too.
- By hand in branded Chrome: the notification's two buttons and closing it.

# Citations

- [tab-mcp extension: Always allow per page and tool (src/worker/always.ts, decide.ts)](https://github.com/ractive/tab-mcp/tree/main/packages/tab-mcp-extension/src/worker)
- [Chrome extensions: notifications, at most two buttons](https://developer.chrome.com/docs/extensions/reference/api/notifications#type-NotificationOptions)
