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

## DEC-008: Every change an AI app asks for is confirmed, every time (replaced in part by DEC-018)

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
  allow do not apply: every change asks each time (DEC-008). (Replaced by DEC-018: Allow
  and Always allow, closing it is Don't allow.)

## DEC-018: Always allow, per tool or for all, until the AI app is disconnected (owner)

The owner, 2026-11-10: bring "Always allow" back, per tool and also as "allow
everything" for an AI app, lasting until that app is disconnected. This replaces
DEC-008's "every time"; its reason stays true and is the risk accepted here: an AI app
steered by instructions hidden in page text (or in a case's own texts) can run an
always-allowed tool, `delete_case` included, without the user seeing it. The user takes
that on knowingly, for one app and one tool at a time, or for all of one app's changes.

- **Per AI app and tool.** A question in the side panel has "Don't allow", "Allow" and
  "Always allow", with one line under them: "Always allow: <tool> runs without asking for
  <app>, until you disconnect it." Always allow arms with Allow (the panel visible and
  focused for 750 ms). A notification has "Allow" and "Always allow" (Chrome allows two
  buttons); closing it or a click on its body is Don't allow, and either button within
  500 ms of showing does not count, as before. The app is the grant (one pairing), not
  its name: an app paired again, or another app with the same name, is asked again.
  Unlike the tab-mcp extension's Always allow, it is not tied to the page: Overmark's
  tools are fixed and act on cases, not on a page's own tools.
- **Allow all changes.** Under each app in the AI app card, a switch "Allow all
  changes" lets every tool that changes something run without asking (adding a mark,
  the verdict, a mark's status, deleting a case), with a line saying so while it is on.
  Below it, the tools always allowed for the app, each with "Ask again".
- **Where and how long.** In the worker's settings database (`overmark-settings`, key
  `alwaysAllowed`, by grant id; DEC-016), so it survives the panel closing, a worker
  restart and a browser restart. An app's entry goes when its grant goes: each list of
  grants the relay sends (at every connection, and when one is added or removed) drops
  the entries of apps not on it. That covers Disconnect, New address (which revokes
  every grant), and a takeover the user answers with New address. "Stop AI access" and
  the AI access switch keep the pairing, and so keep the entry. Switching to another
  relay drops the entries of the first relay's apps at its first connection (the safe
  side: they ask again after switching back).
- **What limits it.** Only tools that change something ask at all; the reading tools
  never did. An Always allow from a question is kept only if the app is still connected
  when the answer comes; the panel's switch works only for an app the card lists, so
  nothing is allowed that the card does not show. The panel changes them only over its
  port, its commands checked in `protocol.ts` (DEC-015). A write that fails changes
  nothing: the call that was answered runs, the next one asks. The last AI call shows in
  the panel's header as before, also for calls that did not ask.

## DEC-019: AI findings on marks, and the summary for the developer (owner)

The owner, 2026-11-10: an AI app records what it finds out about a mark as findings of
its own, apart from the user's comment; and the case's "Verdict" becomes the "Summary for
the developer".

- **Findings per mark.** A mark has a list of findings (`findings`, oldest first, absent
  when there are none): each with its text (at most 5,000 characters), the AI app that
  wrote it (`app`: its client id, its declared name and the verified host, as the relay
  gave them for the call), when it was written (`at`) and last changed (`editedAt`). A
  mark holds at most 20. The user's comment stays the user's: no tool changes it.
- **A case holds at most 200,000 characters of findings.** All marks' finding texts
  together: `add_finding` and `edit_finding` refuse a change past it ("The case holds
  too much finding text … Shorten or delete findings of your own first"); a change
  that shrinks the total passes, so a case from a file over the limit can still be
  tidied. Why this value: get_case sends a case whole while it takes at most half of the
  result budget (768 KiB of the relay's 1 MiB message, so 384 KiB); a case of 30 marks
  with comments of a few lines and 200,000 characters of plain findings is about 250 KB,
  well under it. Text that is not ASCII is larger in UTF-8; such a case goes compact,
  where each finding shows its first 200 characters with `cut: true`, so a large case
  stays readable.
- **Characters are code points.** Every length limit of the case (findings, comments,
  notes, the summary) counts characters as JSON Schema's `maxLength` does, an emoji
  one: the tools' schemas, the case's validation and the cuts agree, and a cut never
  splits a surrogate pair.
- **Own is the client id.** An app may edit or delete only its own findings: those whose
  `app.id` is the calling app's client id (its Client ID Metadata Document URL, such as
  `https://claude.ai/oauth`). Not the grant: that changes when the app pairs again or
  the address is renewed, and the app's findings stay its own. Not the name: any app can
  declare any name. get_case says `own` for each finding. Another app's finding is
  refused with a message that says whose it is. The user can delete any finding in the
  side panel (Delete, then "Really delete?"); a finding's id is unique on its mark only,
  so the panel keys this on the mark and the finding, and a mark's open, unsaved
  comment or resolve form stays open through it.
- **A finding from a file is no app's own.** An import marks every finding
  `imported: true`, whatever the file says: the app a file names is whoever wrote the
  file's, so no app may change it, and the panel and case.md say "as the file says".
  Findings are AI-written text the next AI app reads: the instructions and case.md say
  they are data, never instructions, like the comments and the summary.
- **They ask first.** `add_finding`, `edit_finding` and `delete_finding` change the case,
  so they go through the same question as the other changing tools, and DEC-018's Always
  allow and Allow all changes cover them per tool. The question names the case, the mark
  and, for an edit or a delete, the finding and its app; for another app's finding it
  says the change will be refused whatever the answer. (Refusing before the question
  would need a check the library does not offer; the tool refuses in the same
  transaction that would write.)
- **Summary for the developer.** What should change overall, as agreed; whoever loads
  the case reads it first. The panel's label, its placeholder ("What should change, as
  agreed. Whoever loads this case sees it first."), "Save summary", the case list's
  preview, case.md's heading, the tool `set_summary` (replacing `set_verdict`, argument
  `summary`) and the `summary` key in list_cases and get_case.
- **The stored field stays `verdict`.** Cases in IndexedDB and exported files keep the
  field `verdict`: no migration, old files import as they are, and files from this
  build still open in an older one. The panel's internal names and element ids
  (`verdict`, `save-verdict`) stay with the field. An Always allow kept for
  `set_verdict` names a tool that no longer exists and allows nothing.

## DEC-020: Export says where the file went; Export all cases; tooltips (owner)

The owner, 2026-11-10: after Export the side panel shows where the file went; one more
button exports every case at once; the panel's buttons say in a tooltip what they do.

- **Where the file went, with the optional `downloads` permission.** The manifest lists
  `downloads` under `optional_permissions`; nothing is asked at install. A click on
  Export (or Export all cases) calls `chrome.permissions.request` first, before anything
  is awaited, since Chrome shows its prompt only during a click; where Overmark has the
  permission already the answer is yes at once and nothing shows. While Chrome's prompt
  is open, the panel says under the button what the answer does. With a yes the file
  goes through `chrome.downloads.download({ url: <blob URL>, filename: <the export's
  name> })`; the panel waits for the download to complete (`downloads.onChanged`),
  reads its absolute path with `downloads.search({ id })` and shows it under the button
  ("Saved as", the path, Copy and Show in folder, `downloads.show(id)`), then revokes
  the blob URL. Chrome's own settings decide the folder, and a name that exists already
  becomes `name (1)`, which is why the path is worth showing.
- **A no changes nothing.** Declined, or no `downloads` API, or `downloads.download`
  refusing the file: the export is saved exactly as before (a link's `download`) and the
  panel shows nothing more. Overmark asks again only at the next click on Export, never
  otherwise: Chrome shows its own prompt each time, the panel nags in no other way. A
  Save as dialog cancelled by the user shows nothing; a download Chrome stopped
  (`interrupted`) says so under the button.
- **Export all cases: one zip, a folder per case.** `overmark-cases-<YYYY-MM-DD>.overmark.zip`
  holds one folder per case, named after its title as an export's file name is
  (`login-button-contrast/`), with `-2`, `-3` for a title that comes again; inside each,
  exactly the single-case layout (`case.json`, `case.md`, `shots/`, `crops/`). Nothing
  else at the top: a single-case export has `case.json` at the top, a file of all cases
  does not, which is how Import tells them apart. Cases in the order of the list (newest
  change first). A file Import would refuse is no use, so Export all checks first, from
  the sizes of what is stored, what Import checks: a case that unpacks to more than
  150 MB (or whose `case.json` is over 20 MB) refuses the export, naming each such case
  by its title ("too large to be imported again … Export the other cases one at a
  time"); all cases together may unpack to at most 256 MB, and the zip itself, with its
  headers, may be at most 256 MB too ("Export them one at a time"). 256 MB, not more, as
  the panel holds the file in memory: the cases' files while the zip is built (let go as
  soon as it is), then the zip, put into a Blob at once for saving. The button sits next
  to "Import a case…" and is disabled with no cases.
- **Import a case… reads both.** A `case.json` at the top: one case, as before (at most
  150 MB). Otherwise each `<folder>/case.json` is a case, read and checked with the same
  rules as a single case; one bad case, or a case id twice, refuses the whole file with
  a message naming the folder (`In login-button-contrast/: The export lacks
  crops/a1.webp.`), and nothing is stored. The file may be at most 256 MB, and what it
  unpacks to is counted for the whole file, not per case: the sizes its cases' entries
  declare are added up before anything is unpacked (an entry never unpacks to more than
  it declares), and what each case did unpack to is added up as it is read; past 256 MB
  the file is refused (`The cases in the file unpack to more than 256 MB.`), so a small
  zip of zero-padded images cannot unpack to gigabytes. The check reads every case and
  its images and lets the images go again; each case's images are unpacked (and
  checked) once more when that case is stored, one case at a time, so the panel never
  holds the images of all cases at once. Then the cases go in one after the other: one
  that is not here is stored at once; one whose id is here already asks the same
  question as a single import ("Replace it", "Keep both", and "Skip" instead of
  "Cancel"), saying which case of the file it is. Each case is stored in its own
  transaction, as a single import. At the end the panel says how many were imported
  (`Imported all 3 cases of …`, or `Imported 1 of the 3 cases of …, 2 left as they
  were`); a file of several cases opens none of them. A file with one folder imports
  as a single file does. One import at a time: while a file is read or its cases stored,
  or while its question is open, "Import a case…" and "Export all cases" are disabled,
  their tooltips say why, and the panel shows `Importing <file>…` under them; a file
  chosen anyway is not read.
- **Tooltips.** A `title` on the buttons whose label does not say enough: Export and
  Export all cases (what the file holds, that it is one .zip, that Import a case… reads
  it), Import a case…, Show and Hide marks on this tab and the list's Load, Delete (case,
  mark, finding), New address, Connect again, + Add another AI app, Done, the copy
  buttons, Stop AI access (pauses from any view; the same as the AI access switch, both
  turn Keep AI access on off), the switch, Keep AI access on, Blur form fields, Match
  size, Resolve, Reopen, Change, Show, Next candidate, Disconnect, Allow all changes, Ask
  again, the question's three answers, the import prompt's answers and the header's
  status. What a user needs before clicking stays visible text (the note while Chrome
  asks, the import prompt, the AI card's explanations). The page's toolbar keeps its
  tooltips as they were.
- **The test build has `downloads` at install** (required, not optional), since CDP
  cannot answer Chrome's prompt; the end-to-end tests stub `chrome.permissions.request`
  to answer no for the old way. The test browser's profile sends downloads to a folder
  of its own: under CDP's `Browser.setDownloadBehavior` "allow" the `downloads` API's
  `filename` is ignored and files are named by a GUID.

## DEC-021: One-way sync of the cases to a folder the user chose (owner)

The owner, 2026-11-10: Overmark keeps the cases in a folder the user picks once with the
File System Access API (`showDirectoryPicker({ mode: "readwrite" })` from the side
panel), one in iCloud Drive or Dropbox for instance; no `downloads` permission and no
download UI for it. One-way: Overmark writes, the folder is a mirror. Each case is its
own file in the single-case Export format, overwritten when the case changes; a deleted
case keeps its file, so a mistaken delete can be undone with Import a case…; nothing is
read back from the folder. After a browser restart Chrome may want the permission again
(it can be asked only in a window, with a click): the panel says "Sync paused: allow
access again" with a button, never failing silently. The rest was worked out here:

- **What Chrome does, tried in Chrome for Testing 151 (headless and headed).** A
  `FileSystemDirectoryHandle` is structured-cloned through IndexedDB: the side panel
  stores it, the service worker reads it back and uses it. `FileSystemHandle`,
  `queryPermission`, `requestPermission` and `createWritable` all exist in the
  extension's service worker. The permission is the extension origin's, shared by the
  panel and the worker: a real folder (handed to the panel by a dropped folder, since
  CDP cannot answer the picker: `Page.setInterceptFileChooserDialog` sees the picker but
  only aborts it) granted for reading in the panel was listed by the worker, and a folder
  of the origin's private file system was written by the worker. Write access to a real
  folder needs Chrome's dialog ("Save changes to …?"), which `requestPermission` from the
  panel showed and, clicked by hand, answered "granted"; the worker's write after it was
  not recorded (the Mac's screen locked before the run was repeated), so the worker
  writing a real folder rests on the shared grant shown for reading. And: **Chrome takes
  the grant back the moment the extension's last page closes.** One second after the
  panel closed the worker got `prompt` (and `NotAllowedError` listing the folder), and a
  panel opened again too. So the worker can write only while the side panel (or another
  Overmark page) is open, unless Chrome keeps the permission ("Allow on every visit", if
  its prompt offers it for an extension; not tried).
- **The worker writes, always.** One writer for every change, wherever it comes from:
  saves and Undo from a page and the AI tools (`deps.onChange`, through
  `ConnectionDeps.changed`) are the worker's own; the side panel's changes reach it as
  the `cases:changed` it announces anyway (accepted only from an extension page, never
  from a content script), and the panel sends `sync:run` when it opens and after Allow
  access, Try again and a new folder. Runs never overlap: a change during a run starts
  one more run after it (`Sync.request`). The zip is built in the worker, so a large
  case never blocks the panel. Each run compares every case with what was written, so
  writing from the panel and catching up on open, the fallback the owner named, is what
  the worker's run does anyway: whatever changed while the grant was gone (an AI app's
  change with the panel closed, a browser restart) is written on the first run that has
  it again.
- **Where it lives.** A database of its own, `overmark-sync` (a `Kv` of `src/lib/kv.ts`, store
  `settings`), in the extension's origin: the panel writes `folder` (the handle, its
  name and an id) and `folders` (every folder chosen so far, each with its handle and
  id); the worker writes `files:<folder id>`, one record for each folder synced, and
  `status`. The AI settings' database stays the worker's alone (DEC-016); content
  scripts reach neither. It is opened at its first use, and opened again at the next
  use after an open that failed; the panel shows "Could not read the sync's state"
  while it cannot read it.
- **What was written, per case.** A folder's record holds the folder's id and, by case id, the
  version written (`updatedAt`, and `importedAt`: an import may keep `updatedAt`) and
  the file's name, saved after each file so that a worker stopped in the middle goes on
  from there. A case whose version matches is not written again. Deleted cases stay in
  it, as their files stay in the folder. Since nothing is read from the folder, a file
  the user deletes or changes there is not noticed: the case's next change writes it
  again.
- **File names.** Export's own: `exportFileName`, `login-button-contrast.overmark.zip`.
  A name another case has already (a deleted one too) gets `-2`, `-3`; so does a name of
  a file in the folder that Overmark did not write for that case (only whether the name
  exists is looked at, `getFileHandle` without `create`): such a file is never
  overwritten. A case keeps its file while its title gives the same name.
- **A renamed case**: its file of the new name is written, then its old file is
  removed. It is the same case, so two files of it would only mislead; deleted cases
  keep theirs.
- **Another folder starts afresh** (a new id: nothing written to the old one counts).
  Choosing a folder synced before, at any time (Change folder… back to it, after Stop
  syncing, after other folders in between), gives it its id back, compared with
  `isSameEntry` against every folder in `folders`; its record is still there, so
  Overmark's files in it are its own and are updated in place, never written again
  under `-2` names.
  Stop syncing keeps the files, and a run under way stops before its next file.
- **Writing.** `getFileHandle(name, { create: true })`, `createWritable()`, one
  `write` of the zip, `close()`: Chrome writes to a temporary file and moves it into
  place on `close`, so the folder never holds half a case; on an error the stream is
  aborted.
- **Failures, in the panel with what to do.** No permission (`queryPermission` not
  `granted`, or `NotAllowedError` / `SecurityError` while writing): "Sync paused: allow
  access again", why Chrome asks again, Last synced, and Allow access (primary), Change
  folder…, Stop syncing; Allow access calls `requestPermission` in the click and, with a
  yes, asks the worker to run; a no says so. The folder gone (`NotFoundError`): "The
  folder “…” is no longer there: it was moved, renamed or deleted. Click Change folder…
  to choose it again, or another one." No space (`QuotaExceededError`), a locked file
  (`NoModificationAllowedError`), anything else: what happened, and Try again; Overmark
  also tries again at the next change. A case that cannot be exported (an image
  missing) is named, and the other cases are still written.
- **The panel.** Under the case list, apart from Export and Import by a rule: "Sync to a
  folder…" (its tooltip says what it does: a file per case as Export writes it, a deleted
  case keeps its file, nothing is read); then "Syncing to <folder>" with "Last synced
  <date>" or "Writing 3 cases…", Change folder… and Stop syncing, each with a tooltip;
  the paused and failed states as above. Colours from the panel's tokens, so light and
  dark alike; the paused line in the warning colour.
- **Tests.** Unit tests of `Sync` with a folder in memory (writes, skips unchanged,
  import, rename, deleted case, same titles, foreign files, another folder, paused and
  back, permission lost in a run, folder gone, no space, one case failing, no overlap,
  Stop during a run). End to end, as pickers cannot be automated: the test build gives
  the panel `overmarkUseFolder(handle)` (left out of the store package, checked by the
  build test), and the test hands it a folder of the private file system
  (`navigator.storage.getDirectory()`); a case saved on a page appears there as its
  export, an AI app's `set_summary` writes it again (the worker), a case deleted in the
  panel keeps its file, and after Stop syncing nothing more is written.

## DEC-022: Opening a case shows its marks on the tab in front, and they follow it (owner)

The owner, 2026-11-12: "you never want to load a case without showing the marks … When a
tab becomes active and the case is loaded, just try to show the marks. If none of them
are found, show a warning." And, about the side panel without access to the tab: a
warning icon beside "Overmark may not run on this tab yet …", with "Allow on all sites"
there.

- **Opening a case draws its marks on the tab in front, whatever page that is.** Not only
  on the case's own path (`isPageOf`) as before: the main use is another origin, such as
  `localhost`. The same for a case that an import opens. The case list's Load button goes:
  a click on the case does what it did.
- **The marks follow the open case to the tab in front.** While a case is open, a tab
  that comes to the front of the panel's window (`tabs.onActivated`) gets its marks, and
  so does the tab in front once it has loaded, reloaded or navigated (`tabs.onUpdated`
  with `complete` or a new address); the marks are taken off the tab they were on
  before, where it is still there (failures do not matter). A tab still loading is
  drawn on once it has loaded; a page no content script runs on (an extension's own
  page, `chrome://`) is left alone. A tab that shows the case already (the panel drew it,
  or an AI app's `load_case` did) is not drawn on again, which would drop the candidates
  chosen, unless the page loaded again. The searches again at 1 s and 2 s (marks a script
  draws late) run for every such draw.
- **"← All cases" takes the panel's marks off the page.** The panel remembers where it
  drew them; marks an AI app loaded through the tools are the page's (`state.loadedCase`
  in the worker) and stay, as before. Closing the side panel leaves the marks where they
  are, as before.
- **Hide holds on that tab.** "Hide marks on this tab", or the Hide on the page's own
  bar, keeps the case's marks off that tab while the case stays open: through switching
  to other tabs and back, and through reloads of that tab. "Show marks on this tab" on
  it, or opening the case again, ends that. Why through a switch back: the user took
  them off that tab on purpose, and a switch is no change of mind.
- **None found: the case says so.** When the draw is over (after the searches again)
  and none of the marks that recorded an element is there (every one `lost`; resolved
  marks count as any other, a mark without an element says nothing about the page),
  the case shows a warning with a warning sign: "None of this case's marks were found
  on this page. It is probably for another page: <the case's short address>." with
  "Open the case's page" (`openPage`). On a page with the case's own path (another
  build) only the first sentence shows, without the button. Some found: the marks'
  states as before.
- **Without access to the tab, a notice, and only what needs the page is off.** Chrome
  hides a tab's address until Overmark may run there (`activeTab` from the icon or
  Alt+Shift+O; a click in the side panel grants nothing). The home view (above "Annotate
  this page") and the open case (above "Show marks on this tab") then show the notice
  with a warning sign and "Allow on all sites", which asks for `<all_urls>` in the click
  (`chrome.permissions.request`, nothing awaited before it); with a yes the notice goes
  and the open case's marks are drawn (`permissions.onAdded`). The icon's click on that
  tab draws them too, as before. Where Overmark may run on all sites and Chrome still
  hides the address (its own pages, the Web Store), the notice says that Overmark
  cannot run there, without the button. Only the actions that need the page are
  disabled, each with a tooltip pointing at the notice: Annotate this page, Show/Hide
  marks on this tab, Add marks, and a mark's Show. The case list, editing a case,
  import, export, the summary and the AI app card work without the tab. A tab still
  loading has no address yet and shows no notice. The "Allow on all sites" checkbox in
  the options stays. "Show marks on this tab" no longer asks for the case's site on such
  a tab (it is off there); the case's address still does as it opens the page.
- **One heading.** The home view's "This tab" heading becomes "This page"; under it the
  tab's address, else its title, else nothing (it said "This page" a second time).
