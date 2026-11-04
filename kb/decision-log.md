---
type: decision-log
title: "Decision log"
description: Decisions for Overmark with their reasons, newest last. Owner decisions are marked as such and are not reopened.
tags:
  - decisions
timestamp: 2026-11-04T17:00:00+01:00
---

# Decision log

## DEC-001: Scope, name and home (owner)

Owner, 2026-11-04, in the planning conversation:

- A Chrome extension for annotating any page (elements, boxes, arrows, freehand,
  comments), saving named cases, loading a case onto another build of the page, and
  talking it through with an AI app over tab-mcp. Forwarding cases to a team is handled
  elsewhere.
- The user opens the other environment's page themselves and loads the case; there are
  no "open on local/dev/prod" buttons and no environment settings.
- Its own repository, `ractive/overmark`, not under Acme. The name is Overmark
  ("Folie" was dropped: hard to say for English speakers).
- Vibe Annotations was checked and found too limited ([prior art](research/prior-art.md)).
- Before/after evidence per check, a backend with share links, and links to Jira and
  GitHub are follow-ups.

## DEC-002: The annotated screenshot is the record; matching is best effort

Finding an element again across builds cannot be made reliable (generated classes and
ids, different content, layouts, and the fix itself). A case therefore centres on
annotated screenshots plus a crop per annotation; element details are hints and the
input of a similarity score (after Similo). The case format is Overmark's own
(`overmark/1`); the CSS selector is named after the W3C `CssSelector`, and a full W3C
Web Annotation export waits for a consumer that needs it.

## DEC-003: Chrome and Edge, Manifest V3, `activeTab` first

Firefox and Safari give every install a random extension ID, which a relay's allow
list cannot name. `activeTab` covers drawing, reading the page and `captureVisibleTab`
after a click on the icon; `<all_urls>` is optional and asked for at runtime. This keeps
Chrome's install warning small and the store review short.

## DEC-004: The tab-mcp connection lives in the side panel

A content script's WebSocket carries the page's origin, so the relay would have to allow
every site. The side panel is an extension page (origin `chrome-extension://<id>`), has
a document for the connect dialog and the confirmations, `localStorage` for the address
secret and `BroadcastChannel`. The service worker has no document.

## DEC-005: Fixed tools only

No tool runs JavaScript sent by the AI app: the Chrome Web Store forbids remotely hosted
code, and it would hand the page to whoever controls the AI app's context. General page
inspection (clicking, scripting, network) stays with Claude in Chrome or a DevTools MCP.

## DEC-006: A fixed extension ID from our own key

`manifest-key.txt` holds a public key (base64 DER) that development and test builds put
into the manifest's `key`, so the ID is `fphhchhlgklidhnodoleiebmdhnfdadg` everywhere and
a relay can allow it. The private key was not kept: it is not needed for unpacked
extensions. Store builds leave `key` out; after the first upload the store's key replaces
ours (iteration 5).

## DEC-007: No runtime dependency besides the tab-mcp client

Zip reading and writing (store and deflate through `CompressionStream`), base64, images
(`OffscreenCanvas`) and the UI are a few hundred lines of own code; the owner prefers
that to packages for such things. The only runtime dependency is
`@ractive-ch/tab-mcp-client`.

## DEC-008: Every change an AI app asks for is confirmed, every time

The PR #4 review found that `alwaysAllow: true` let one click on "Always allow" wave
through every later `delete_case` of that AI app, for example one steered by
instructions hidden in page text. tab-mcp-client 0.10.0 offers "Always allow" for every
consequential tool of a `TabMcp` or for none, so Overmark turns it off: `add_annotation`,
`set_verdict` and `delete_case` ask in the side panel each time. The question names the
case and the page (an `onConfirm` that adds them to the description, then hands over to
`confirmInPage`). A per-tool "Always allow" would need a client release that offers it.

## DEC-009: What is recorded about an element is an allow-list

The reviews found typed text leaking into element details twice (through an editor's
wrapper, through a textarea's text). Instead of subtracting cases from "the element's
text", `src/lib/element.ts` names every recorded field with its source and limit, and
`ATTRIBUTE_RULES` every recorded attribute with its rule; an attribute without a rule is
never read. Text comes only from `pageText`, which skips fields, editors, scripts and
styles. Links keep their path only: a query string or fragment can carry personal data
or tokens. Matching compares link paths, which is enough to tell links apart.

## DEC-010: The page's one state machine

The content script guarded the user's save against an AI app's screenshot (and the
other way round) with flags spread over three files (`#saving`, `#hideAfterSave`,
`#showAfterSave`, the temporary mark, blur holders); every review found another race.
`PageActivity` (`src/content/activity.ts`) holds exactly one of idle, saving, an AI
mark or an AI capture. What arrives during a save is refused (AI) or recorded as what
to do afterwards (toolbar: show another case, or hide if the save worked). An AI
activity ends by itself after 10 s, so a side panel that crashed cannot block saving.

## DEC-011: The side panel draws one state

The panel kept its state in a dozen module variables (the tab, the overlay, the open
case, the loaded results, object URLs, render counters) and re-rendered from several
places; the second review found five races there. Now `PanelState` (`src/sidepanel/state.ts`)
holds all of it, actions in `main.ts` change it only through `update`, which schedules
one `render` (`view.ts`), and every asynchronous read goes through a `Latest`, so an
older read never overwrites a newer one. The verdict field stays the same element while
its case is open, so typing, focus and cursor survive every render; the other parts are
redrawn when what they show changed.

