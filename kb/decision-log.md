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

## DEC-012: A mark's screenshot is taken when the mark is drawn

The full review found the same fault behind several findings: screenshots were taken at
saving, sometimes long after the mark. By then a container had scrolled, the app had
moved to another route, the menu the mark was about had closed, or the layout had moved,
and the save put the mark on whatever was there. Since the screenshot is the record
(DEC-002), it has to show what the user saw when marking.

Now each mark gets its screenshot at once, under a pending path, with the element's
details read at the same moment. Marks drawn while nothing scrolled or changed in the DOM
share one screenshot. Screenshots show the page alone: saving draws the marks onto them
(`paintMark`, the same shapes the overlay shows in SVG), so undoing a mark and renumbering
marks for another case never touch an image. Saving no longer scrolls the page, which
made the planning of screenshot windows unnecessary. A shot records the page's address,
because one case can span an app's routes.

The page is never moved while the user works: a first version went back to where a mark
was drawn when the page had moved on before its turn, and a click in that moment hit
the wrong element. Now such a mark waits, and saving takes its screenshot from where it
was drawn, when nobody is using the page. That is the rare case (the screenshot waits
for Chrome's two captures a second, or for an AI app's screenshot); what the page
showed then is gone, but the scroll position is right.

The price: every new view flashes the overlay away for about 100 ms, and pending
screenshots live as long as their marks, so they are swept after 7 days instead of
10 minutes.

## DEC-013: Marks for a case go into it as they are done

The owner's feedback: after "Add marks" a new mark was only stored after "Save…",
which then asked "Add to case" or "Back"; nobody expects either step. Now the toolbar
has two modes. Without a case, marks are drafts and "Save case…" stores them as a new
case with a title, as before (its form's other button is "Keep drawing"). With a case
(the side panel's "Add marks", "Continue annotating", or after that first save), the
toolbar says "Adding to “<case>”" and each mark goes into the case as soon as it is done:
its comment confirmed, or the comment closed with the mark kept. Done closes the
toolbar once the marks are in.

- One queue in the content script adds the marks in order, one save each, and also
  runs Undo and New case, so nothing overtakes an add. Before each add the worker says
  whether the mark's number is still free (`case:number`); if an AI app took it, the
  marks not added yet are renumbered.
- The screenshot is taken when the mark is drawn, as before (DEC-012). Each added mark
  gets a shot of its own in the case, drawn with its mark and the marks this toolbar
  added before on the same view (so it looks as one save would have). Marks on one view
  still share the one capture: its pending image stays (`keepPending`) until the page
  no longer looks like it and no mark waits for it. More shots per case, no extra
  captures, and Undo never has to redraw a screenshot.
- Undo takes the mark with the highest number: a draft from the page, or an added mark
  out of the case (`case:undo-add`), with its crop and its shot. Since its pin was on
  no other screenshot, its number is free again, unlike a delete in the side panel,
  which keeps the number (a pin may stay on shared shots). The worker refuses this for
  marks of an AI app, marks that share a screenshot, or a screenshot older than a day:
  a content script cannot take out older marks this way.
- A failed add leaves the mark on the page as a draft with the reason and an "Add mark
  N" button; a mark whose screenshot was given up (the page moved before its turn)
  waits for that button or for Done, when nobody is using the page and scrolling back
  to take it is safe. A failure shows the toolbar again if it was closed meanwhile.
- A new case gets its own id instead of the pending images' id, so one id holds a
  page's pending screenshots for as long as the page is open.

