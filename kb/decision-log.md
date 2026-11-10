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

## DEC-004: The tab-mcp connection lives in the side panel (replaced by DEC-015)

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

## DEC-013: An AI app may read a mark's element from the live page

The owner, 2026-11-09: the AI app could not help find solutions to a case's marks, since
it had no access to the page structure, only screenshots and the stored details. So
`get_mark_element` reads one mark's element from the tab in front: its outer HTML, box,
the window's size, a fixed list of computed styles without those at their initial value,
the style rules that match it from the sheets the page may read, four ancestors with
their layout styles and up to twelve children. It is a fixed, read-only tool (DEC-005
still holds: no code from the AI app runs, the selector is only matched), so it does not
ask first, like the other reading tools.

A CSS selector reads another element, but only among the mark's element's ancestors and
inside it: a page-wide lookup would let the AI app read anything on whatever tab is in
front, hidden content included. For a mark without an element (box, arrow, pen, note)
there is nothing to start from, so the selector is looked for on the whole page, and only
when the tab in front shows the case's page (`isPageUrl`). Selectors that name only `*`
or use `:has()` more than once are refused; the whole page is queried only for such a
mark, and the first visible match wins.

Nothing of it is stored, so DEC-009's allow-list of recorded details does not apply, but
its reasons do: the HTML is written by Overmark's own serializer (`src/lib/inspect.ts`),
not taken from `outerHTML`. Form fields keep an allow-list of attributes (never `value`,
`checked`, `selected` or `aria-value*`); the content of text areas, selects and editable
regions (with Monaco, CodeMirror 5 and Ace) is left out, also when the element itself is
inside one; hidden subtrees (`display: none`, `visibility: hidden`) are left out, with a
note. URLs lose their query, fragment and user name and password, found by the
attribute's name (`href`, `data-src`, `*srcset`, …) and by the value (anything that
parses as an absolute, root-relative or query-carrying URL, also inside a longer value
and in CSS `url()`s); other schemes than http(s) keep only the scheme (`mailto:…`), as
DEC-009's links do. The head, `meta`, `link`, `script`, `style`, `title`, `base`,
`noscript` and `template` are never the element read, and their content is never sent;
a meta tag named like a secret loses its `content`, `srcdoc` its document, event
handlers their code, attributes named like a secret (`data-csrf-token`) their value.
Everything is capped (about 16 KB of markup, 30 rules), and a cut is said in the result;
for a small relay message limit the page sends a second markup cut at 4 KB. The result opens with a note that the page's content is data, not
instructions, and is marked `untrustedContentHint`. It is refused while the page is busy
with a save or a screenshot, whose blur is inline style the page does not have.

## DEC-014: Marks for a case go into it as they are done

The owner's feedback: after "Add marks" a new mark was only stored after "Save…",
which then asked "Add to case" or "Back"; nobody expects either step. Now the toolbar
has two modes. Without a case, marks are drafts and "Save case…" stores them as a new
case with a title, as before (its form's other button is "Keep drawing"). With a case
(the side panel's "Add marks", "Continue annotating", or after that first save), the
toolbar says "Adding to “<case>”" and each mark goes into the case as soon as it is done:
its comment confirmed, or the comment closed with the mark kept. Done tries the marks
not in the case yet once more and closes the toolbar when all are in; while one is not,
the toolbar stays up and says so, and Done again discards it.

- One queue in the content script adds the marks in order, one save each, and also
  runs Undo and New case, so nothing overtakes an add. Before each add the worker says
  whether the mark's number is still free (`case:number`); if an AI app took it, the
  marks not added yet are renumbered; a number taken between that check and the save is
  checked once more and the save tried again.
- Each queued mark records the case it was queued for. When the side panel switches the
  toolbar to another case meanwhile, the mark is not added there: it waits as a failed
  mark that names its case, until "Add mark N" (the user's choice) puts it into the
  case the toolbar adds to now.
- The screenshot is taken when the mark is drawn, as before (DEC-012). Each added mark
  gets a shot of its own in the case, drawn with its mark and the lower-numbered marks
  this toolbar added before on the same view (so it looks as one save would have; the
  worker draws no higher number, so Undo never leaves a pin behind). Marks on one view
  still share the one capture: its pending image stays (`keepPending`) until the page
  no longer looks like it and no mark waits for it. No extra captures, and Undo never
  has to redraw a screenshot. The price is storage: a case grows by one full screenshot
  per mark (some 100 to 300 KB each), so a case may hold as many shots as marks (1000;
  it was 200), and a full case says so before anything is drawn.
- Undo takes the mark with the highest number: a draft from the page, or a mark added
  since the toolbar was last shown out of the case (`case:undo-add`), with its crop and
  its shot. Since its pin was on no other screenshot, its number is free again, unlike a
  delete in the side panel, which keeps the number (a pin may stay on shared shots).
- `case:undo-add` deletes, so the worker allows it only for a mark it recorded when
  that add was saved, from the same tab and document (`chrome.storage.session`, hence
  the `storage` permission; it has no install warning and is gone when the browser
  closes), and only once. The mark must also still be as the add stored it (not
  resolved, comment unchanged, the user's), the highest number in the case, on a
  screenshot of its own taken less than a day ago. Anything else is deleted in the
  side panel.
- A failed add leaves the mark on the page as a draft with the reason and an "Add mark
  N" button; a mark whose screenshot was given up (the page moved before its turn)
  waits for that button or for Done, when nobody is using the page and scrolling back
  to take it is safe ("Add mark N" turns the tool off first). A failure shows the
  toolbar again if it was closed meanwhile. The status is one element with
  `role="status"`, changed in place; the reason of a failure is in one with
  `role="alert"`; the button that had the focus has it again after the toolbar changes.
- A new case gets its own id instead of the pending images' id, so one id holds a
  page's pending screenshots for as long as the page is open.

## DEC-015: The AI connection lives in the service worker; questions in the panel or a notification (storage replaced by DEC-016)

The owner, 2026-11-09: the connection to the AI app must stay while the side panel is
closed, as the tab-mcp extension's does (its DEC-116). This replaces DEC-004's home for
the connection; its reason stays true, since the worker is an extension context too and
its WebSocket carries the extension's origin.

- **Where.** `TabMcp` and the tools run in the service worker (iteration 8). A WebSocket
  that carries messages keeps the worker alive since Chrome 116,
  and the relay's heartbeat (a ping every 25 s) carries some on a quiet connection. The
  library runs there without a document: its address secret in a write-through cache over
  `chrome.storage.local` (IndexedDB since DEC-016), `connect({ resume: true })`, and a bundle without dynamic
  `import()`. An alarm once a minute while AI access is on, and every worker start,
  connect again. "Keep AI access on" keeps its meaning (also after a browser start and an
  idle session); without it AI access stays on until "Stop AI access", the relay's end of
  the session, or the browser closes. The flag for that lives in `chrome.storage.session`,
  which Chrome also clears when the extension is updated, reloaded or disabled: without
  "Keep AI access on", an update or reload ends AI access too.
- **Who may command it.** Only the side panel's own page, over one named port whose
  sender is checked (this extension, the panel's path, not in a tab). Content scripts
  reach `chrome.runtime` too; their one-off messages stay the old ones and no AI command
  is among them. `chrome.storage.local`, which now holds the secret, is for trusted
  contexts only (`setAccessLevel`, for the local area from Chrome 140, so that is now the
  manifest's minimum). Where Chrome refuses it, the worker fails closed: it removes the
  stored secrets, keeps none, and AI access stays off with a message saying why.
  (Replaced by DEC-016: the settings and the secret are in the worker's IndexedDB,
  `setAccessLevel` is best effort, the minimum is Chrome 116 again.) The panel's page
  opened in a tab gets no port: it is not where the user answers questions.
- **Questions.** Every call that changes something still asks (DEC-008), now in the side
  panel of the window in front when it is open and focused, and otherwise also in a Chrome
  notification: `requireInteraction`, an id per call, Don't allow first, an Allow within
  500 ms of showing does not count, a click on the body or closing it is Don't allow, a
  click on a settled call is dropped. No answer in 60 s is Don't allow (the library tells
  the AI app "The user declined", as for any no). The panel's Allow
  arms after the panel was visible and focused for 750 ms. While a question waits the
  icon shows "?", so a user whose notifications are off can answer in the panel. The text
  is the same as before (`confirmLines`: the case, the mark, the page).
- **The address.** The panel's `localStorage` secret (and its relay, Keep AI access on and
  Blur form fields) is handed to the worker once, when the side panel first opens, so an
  AI app keeps working with the address it was given.
- **Cost.** `notifications` adds Chrome's install warning "Display notifications"; Overmark
  is not in the store yet. `alarms` adds none.

## DEC-016: The AI settings and the address secret in the worker's IndexedDB

2026-11-09, after overmark#26: DEC-015 kept the address secret and the AI settings in
`chrome.storage.local`, closed to content scripts with `setAccessLevel({ accessLevel:
"TRUSTED_CONTEXTS" })`, treated a refusal as fail closed, and raised the minimum to Chrome
140 because the local area's access level was said to apply only from there. The sources
disagree (Chromium's `storage.json` and MDN say the access level applies to the session
area only), and a level that silently does not apply would not throw: the fail-closed
path guarded nothing it could see. Content scripts can read and write
`chrome.storage.local` by default, so a page whose renderer was compromised could, in
Overmark's content-script world, have read the secret, or written a `relay` of its own
for the next start to connect to with it. The tab-mcp extension made the same move (its
PR 89 and PR 91, DEC-116); this follows it.

- **Where.** The relay, "Keep AI access on", "Blur form fields in screenshots", the
  takeover (`replaced`), the panel-handover marker and the address secret are in an
  IndexedDB database of their own, `overmark-settings` (object store `settings`,
  `src/worker/kv.ts`), in the extension's origin. Content scripts run in the page's
  origin and cannot open it, in any Chrome version. Only the service worker uses it; the
  cases' database (`overmark`) and its schema are untouched. No package: a few lines
  over IndexedDB.
- **The panel.** It neither reads nor writes these settings in storage. It sends
  `keep-on`, `set-relay` and the new `blur-forms` over its port, and shows the state the
  worker sends, which now carries `blurForms`. A setting changes in the worker's memory
  only after its write to the database succeeded; a failed write keeps the old value and
  shows the problem, so the panel, the tools and the database agree. The tools read blur
  from the worker's settings at each call, so a change while connected holds for the
  next screenshot (the fix from overmark#26). The worker tells open overlays its blur
  value (`overlay:settings`) when it changes, when the worker starts and when a panel
  attaches, so an overlay a panel started before it knew the value is corrected. A panel
  that has no state from the worker within 2 s, or whose worker failed to start, starts
  an overlay with blur on (the safe side), as does the panel's page opened in a tab,
  which has no port and whose blur box is disabled like its other AI controls. A worker
  whose connection cannot start (its database cannot be opened) tells the panel why, and
  the panel says "AI access is not available" instead of nothing.
- **The database closing.** Chrome may close the connection (`onclose`), and deleting or
  upgrading the database elsewhere asks it to close (`onversionchange`): the worker
  closes it, and the next read or write opens it again.
- **The session flag stays in `chrome.storage.session`.** "AI access is on until the
  browser closes, or the extension is updated, reloaded or disabled" is exactly that
  area's lifetime, and the area is for trusted contexts only unless the extension opens
  it (Overmark never does, and calls no `setAccessLevel` on it). In IndexedDB it would
  need a browser-start marker from `runtime.onStartup` and `onInstalled`, and no event
  says the extension was disabled and enabled again, so it could not keep the meaning.
  The flag cannot redirect anything either: it only connects to the user's own relay
  with the user's own secret.
- **Nothing is taken from `chrome.storage.local`.** Only the owner's own build of
  overmark#26 ever wrote settings there; it was never released. Every worker start
  removes the setting keys found there (`relay`, `keepAiOn`, `blurForms`, `replaced`,
  `migrated`, the secrets) and imports none of them, whoever wrote them. A one-off import
  would need a marker that lives in the database it guards (lost with the site's data, after
  which a content script's value would be imported), or `onInstalled`, which fires after
  the worker has already loaded its settings and may have made a new secret. Cost: the
  owner's build loses its relay, Keep AI access on, Blur form fields and its address once,
  and the AI apps paired with it pair once more.
- **The panel's handover stays.** The side panel's `localStorage` (builds before
  overmark#26) is in the extension's origin, out of content scripts' reach, so its
  handover stays: the secrets are adopted first, then Keep AI access on, the relay, Blur
  form fields and the marker `panelHandedOver` are written in one transaction, and only
  then does the worker connect or switch relay. The panel deletes its copy only once the
  marker is set; a handover cut short before that runs again, whole, at the panel's next
  connection (a secret the worker has is not taken twice).
- **`setAccessLevel` is best effort.** The worker still asks for `TRUSTED_CONTEXTS` on
  the local area as an extra layer; a refusal is logged, nothing fails closed, and
  nothing of the AI connection is kept there any more.
- **Chrome 116 again.** The minimum from before overmark#26: a WebSocket that carries
  messages keeps the service worker alive from there (DEC-015); nothing else in the code
  needs a newer Chrome.

## DEC-017: The tab-mcp extension's AI app card

2026-11-09, after the owner's "wait until Tab MCP finishes it and then just copy it": the
tab-mcp extension's PR 88 settled its side panel's AI access UI, and DEC-015's plain
pairing view gives way to it.

- **The card** (`src/sidepanel/card.ts`, the tab-mcp extension's rules on Overmark's
  state): an "AI access" switch in its header (on also while connecting or retrying, so
  the user can stop that); off, "Turn on AI access" is the one primary button; on with no
  AI app paired, the address and the code show at once (pairing runs only then); with
  apps paired, "+ Add another AI app" shows them again, with Done. The address shows only
  while pairing. Disconnect asks first, and the second click of a double click confirms
  nothing. The switch shows the user's flip until a state that matches it comes, for at
  most 10 s.
- **Overmark's own parts stay.** The relay field and "Keep AI access on" sit under the
  card (the tab-mcp extension has no Keep AI access on: its worker always retries). The
  header keeps its status pill and "Stop AI access", which also show in a case; the pill
  leads to the card on the home view, turning AI access on if it was off.
- **A covered panel is not on screen.** Another extension's panel for the tab (Claude in
  Chrome's) can cover Overmark's while it stays open. The panel tells the worker its
  visibility (`visible`); a hidden panel's questions go out as notifications, as a
  closed panel's do, and a question asked meanwhile is a notification at once.
- **The panel opens with the tab** (2026-11-10). As in the tab-mcp extension,
  `sidePanel.open({ tabId, windowId })`, so that it shows over a panel another extension
  opened for the tab: with the window alone Chrome resolves and shows nothing, and the
  owner saw exactly that in branded Chrome with Claude in Chrome's panel open. The call
  was left out of iteration 10 because the store package's end-to-end test failed in CI
  (Chrome for Testing 156 on Linux, twice in a row; it passed on macOS). The likely
  cause: the panel takes its width a moment after the click, and a click measured
  before that went past the overlay onto the test page's submit button (the log shows
  `#overmark-root` gone after it). The icon-click tests now wait until the panel has
  taken its width and the viewport keeps its size, and marking waits for the Element
  tool to be on; with that the test passed in CI on Linux. The covered-panel test hides the panel's page itself: in Overmark's harness a
  second extension's worker did not start.
- **Notifications keep Don't allow and Allow.** The tab-mcp extension's Allow and Always
  allow do not apply: every change asks each time (DEC-008).
