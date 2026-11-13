# Overmark

Annotate any web page, load the annotations onto another build of the page, and talk
them through with your AI app.

A PO marks an issue on the live site: picks an element, draws a box, an arrow or a
freehand mark, writes a comment, and saves it all as a named case with annotated
screenshots. A dev loads the case onto `localhost:3000` and sees what was meant on their
own build. After the rollout the PO loads it onto the dev and prod sites and checks the
fix. An AI app such as Claude reads and extends cases through a
[tab-mcp](https://github.com/ractive/tab-mcp) relay, or a case travels as a zip file.

Status: in development. The plan is in [kb/](kb/index.md).

## Install for development

Requires [Bun](https://bun.sh) 1.4.

```sh
bun install
bun run build      # builds dist/ (extension ID fphhchhlgklidhnodoleiebmdhnfdadg)
```

In Chrome, open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and
choose `dist/`. Click the Overmark icon on a tab (or press Alt+Shift+O) to open the side
panel there.

`bun run zip` packs `overmark-<version>.zip` for sharing; unzip it and load the folder
the same way.

Without building: every CI run has the zip as the artifact `overmark-unpacked` on its
page (Actions → the run → Artifacts), and every release has it under Releases. Each also
has `overmark-store`, the package for the Chrome Web Store; publishing it is described
in [kb/operations/chrome-web-store.md](kb/operations/chrome-web-store.md).

## Use

1. Click the Overmark icon on a tab. The side panel opens there.
2. "Annotate this page" shows the toolbar for a new case: Element (click one), Box,
   Arrow, Pen and Note, each followed by a comment. "Save case…" saves the marks as a new
   case with a title, and the side panel opens it. Overmark takes screenshots with the
   marks on them and records each marked element's details. Saved marks stay on the
   page, fainter.
3. The toolbar adds to a case only while that case is open in the side panel: from the
   save on, and whenever the toolbar was started with "Add marks" in a case, the
   toolbar says "Adding to “<case>”" ("Done adding" in the side panel stops it), and
   each mark goes into that case as soon as its
   comment is done (Done, or the comment closed with Escape or a click elsewhere); there
   is no save step, and the case in the side panel shows it at once. Undo takes the last
   mark added since the toolbar was shown out of the case again, while nobody has
   resolved or edited it. A mark that could not be added stays on the page with the
   reason and an "Add mark N" button to try again; it never moves to another case unless
   you click that button. Done tries such marks once more and closes the toolbar when all
   are in; while one is not, the toolbar stays up and says so, and Done again discards
   it. "← All cases" at the top of the side panel closes the case: the toolbar finishes
   as with Done and adds to no case any more, and the case's marks leave the tab, also
   those an AI app drew; with a mark not in the case yet the panel stays and says so,
   and a second click leaves without it. A new case starts there, with "Annotate this
   page". Closing the side panel leaves marks and toolbar on the page; opening it again
   opens the case the page shows.
4. On another build of the page (say `localhost:3000`), click the case in the side panel:
   its marks are drawn on the tab in front, whatever page that is. While the case is open
   they follow the tab in front: another tab, a reload or a navigation draws them there
   and takes them off the tab before; "← All cases" takes them off the page.
   "Hide marks" takes them off, and they stay off on that tab, also through a reload,
   until "Show marks" or the case is opened again. When none of the case's marks is
   found, the case says it is probably for another page and offers to open the case's
   page. On a tab Overmark may not run on yet (after reloading the extension, say),
   Chrome hides the address, and the side panel says so with a warning: click the
   Overmark icon there (or press Alt+Shift+O) and the marks are drawn, or press "Allow
   on all sites" in that notice; until then what needs the page is off. The case's
   address opens its page in a new tab (Chrome asks whether Overmark may run on that
   site from then on) and draws the marks there (marks a script draws late are looked
   for again for a few seconds), and when the
   tab's size is not the one the marks were made at, Match size resizes the window to it
   (as far as the screen allows; page zoom is counted). Overmark looks for each mark's element and draws the mark on it again,
   moved and scaled with the element: green when found, amber and dashed when probable
   or unsure. A mark drawn on a large container can land a little off when that
   container changed its size. A mark without an element goes where it was, in amber.
   Show scrolls to a mark; Next candidate tries the next best element. The screenshots
   stay the record, so a mark makes sense even when its element is not found.
5. Each mark in the side panel has a status: open, fixed and to verify, verified, won't
   fix or can't reproduce. Resolve… sets it (Fixed, to verify; Fixed and verified; Won't
   fix; Can't reproduce; with an optional note). The tester on the new build then
   clicks Verified on a fix that holds, or Reopen… with a note on what is still wrong;
   the claimed fix and its note stay in the mark's history. The status chips under the
   case's bar (Open, To verify, Verified, Closed) count the marks and filter the list:
   the developer works through Open, the tester through To verify. On a loaded page a
   mark to verify is drawn in full in violet; a verified or closed one is drawn grey and
   faded, and no longer counted. Both sides should run this version: an older one
   reading the file shows a verified mark as Fixed and a reopened one as open without
   its note (`case.md` in the file still has them). A mark can also have its comment
   edited, or be deleted. A deleted mark's
   number is not given again, and its pin stays on screenshots that other marks share.
   Under the comment a mark shows its AI findings: what a connected AI app found out
   about it, each with the app's name and when it was written. An AI app never changes
   your comment, and changes only its own findings; you can delete any finding (click
   Delete twice).
6. The case's "Summary for the developer" says what should change overall, as agreed;
   whoever loads the case sees it first. You or the AI app write it.
7. Export writes `<title>.overmark.zip` (`case.json`, `case.md` and the images) to pass
   on; "Import a case…" reads one back, opens it and draws its marks on the tab in
   front. An AI app can read `case.md` and the images without the extension.
   "Export all cases", next to "Import a case…", writes every case into one
   `overmark-cases-<date>.overmark.zip`, a folder per case laid out as a single export;
   "Import a case…" reads that too, case by case, asking about each case that is here
   already (Replace it, Keep both or Skip). At the first Export, Chrome asks whether
   Overmark may manage your downloads (an optional permission): with a yes the side
   panel shows where the file went, with Copy (its full path) and Show in folder; with
   a no the file is saved as before and Chrome asks again only at the next Export.
8. "Sync to a folder…", under the case list, writes every case to a folder you choose
   once (one in iCloud Drive or Dropbox, say): each case as its own file, the same
   `<title>.overmark.zip` as Export writes, and again whenever the case changes, also
   when an AI app changed it. The folder is a mirror: Overmark never reads from it, and
   a deleted case keeps its file there, so "Import a case…" can bring it back. A case
   whose title changed gets a file of the new name and its old file goes; two cases of
   the same title get `-2`, `-3`, and a file Overmark did not write is never
   overwritten. The side panel shows "Syncing to <folder>" with when it last synced,
   "Change folder…" and "Stop syncing" (the files stay). Chrome lets Overmark write to
   the folder only while its side panel is open, and asks for the folder again after
   the side panel was closed or the browser restarted: the panel then says "Sync paused:
   allow access again", and "Allow access" writes what changed meanwhile.

## With an AI app

Overmark offers the cases to an AI app (Claude Code, Claude, ChatGPT, Codex) through a
[tab-mcp](https://github.com/ractive/tab-mcp) relay. The connection is held by the
extension's background service worker, so it stays while the side panel is closed; the
side panel shows it and sets it up. Overmark uses the hosted relay
`https://tab-mcp.ractive.ch` unless you enter another one in the side panel. It allows
only builds with the fixed key in `manifest-key.txt` (ID
`chrome-extension://fphhchhlgklidhnodoleiebmdhnfdadg`); the store package has none, so
it gets another ID and needs a relay of its own until the store's key is set.
The tools:

| Tool | What it does |
|---|---|
| `list_cases` | The saved cases, with their marks by status |
| `get_case` | A case's summary for the developer and its marks with their comments, statuses, reopens, AI findings, element details and crops |
| `get_image` | One screenshot or crop |
| `load_case` | Finds the marks' elements on the tab in front and draws the marks there |
| `highlight` | Scrolls to one mark's element (or another candidate) |
| `get_mark_element` | A mark's element on the tab in front, read from the live page: trimmed HTML, box and window size, computed styles, matching CSS rules, ancestors and children; a CSS selector reads one of its ancestors or an element inside it instead (for a mark without an element, an element of the case's page) |
| `capture` | A screenshot of the tab in front |
| `add_annotation` | Adds a mark on an element (by CSS selector); asks first |
| `set_summary` | Records the summary for the developer: what should change overall, as agreed; asks first |
| `set_mark_status` | Sets a mark fixed, verified (a fixed one, when you say so), won't fix or can't reproduce, or reopens it with a note; asks first |
| `add_finding` | Adds a finding of the AI app to a mark, apart from your comment; asks first |
| `edit_finding` | Changes one of the app's own findings; asks first |
| `delete_finding` | Deletes one of the app's own findings; asks first |
| `delete_case` | Deletes a case; asks first |

No tool runs code an AI app sends. Page text in the results comes from web pages, and
the tools say so to the model. `get_mark_element` sends no form field values, no
text typed into editable regions, no hidden elements and nothing of the page's head,
and URLs without their query string, fragment or user name and password.

### A relay on your computer, for Claude Code

The relay must allow Overmark's origin, `chrome-extension://fphhchhlgklidhnodoleiebmdhnfdadg`.
Relay 0.7.0 and later take it as a site:

```sh
docker run --rm -p 127.0.0.1:8080:8080 \
  -e NODE_ENV=development \
  -e TAB_MCP_PUBLIC_URL=http://localhost:8080 \
  -e TAB_MCP_STORE=memory \
  -e TAB_MCP_SITES='[{"origin":"chrome-extension://fphhchhlgklidhnodoleiebmdhnfdadg","name":"Overmark"}]' \
  ractive/tab-mcp:0.9.0
```

Then, in the side panel's "AI app" card, set the relay to `http://localhost:8080`
and click "Turn on AI access" (or flip the AI access switch). With no AI app paired yet,
the card shows the address and a code at once; with apps paired, "+ Add another AI app"
shows them. Under the address, "How do I add it?" opens the steps for Claude, ChatGPT,
Claude Code and Codex (the tab-mcp client library's, with the address in them), each
command with its own Copy, and a link to the step-by-step guide. Add the address to
Claude Code, then run `/mcp` there and choose Authenticate:

```sh
claude mcp add --transport http overmark <address>
```

Your browser opens the relay's page; type the code from the side panel. The connection
stays when you close the side panel (the icon shows "on"), until you turn the switch off
or click "Stop AI access" (either keeps the pairing), the relay's end of an idle session, or the browser closes; an update
or reload of the extension (or turning it off) ends it too. "Keep AI access on" connects
again by itself after all of these but "Stop AI access".

A tool that changes something (marked "asks first" above) asks first: in the side
panel when it is open and on screen in the window in front (another extension's panel,
such as Claude in Chrome's, can cover it), otherwise in a system notification with
Allow and Always allow, where closing it is Don't allow (the icon shows "?" while a
question waits). With no answer within 60 seconds the call does not run, and the AI
app is told you did not answer. "Always allow" lets that
tool run without asking for that AI app from then on; "Allow all changes", under the
app in the side panel's AI app card (in Settings, which the AI pill at the top
opens), does so for every tool that changes something, deleting a case too. The card lists the tools always allowed for each app, each with
"Ask again". Both last until you disconnect the app (or make a new address), also
across browser restarts. An AI app can be steered by text on a page it reads, so allow
always only what you would not need to check.

Overmark needs Chrome 116 or later. The connection's settings and its address secret
are in a database of the extension's own (IndexedDB in the extension's origin), which
only its background service worker uses and the scripts Overmark runs in web pages
cannot reach; the side panel changes them through the worker. Whether AI access is on
until the browser closes is in Chrome's session storage, also out of those scripts'
reach.

Permissions for this: `alarms` wakes the service worker once a minute while AI access is
on, so the connection comes back after a sleep; `notifications` asks the questions when
the side panel is not in front (Chrome mentions it when installing: "Display
notifications"). In earlier builds the connection lived in the side panel, and its
address secret in the panel's own storage; the first time the side panel opens after the
update, it hands the secret over, so the address an AI app has stays the same. An
unreleased build kept the settings in the extension's local storage; Overmark deletes
them there and does not take them over, so such a build's AI apps pair once more.

claude.ai, Claude Desktop and ChatGPT connect from their own servers, so they need a
relay with a public HTTPS address that allows Overmark's ID, such as the hosted one.

## Development

```sh
bun run verify     # Biome, type check, tests
bun run fix        # format and apply safe lint fixes
```

The end-to-end tests load the extension into Chrome for Testing or Chromium
(`CHROME_PATH`, or Playwright's download in its usual cache). Branded Chrome ignores
`--load-extension`, so without one of them the tests are skipped locally; CI runs them.

## Licence

MIT, see [LICENSE](LICENSE) and [AI_NOTICE](AI_NOTICE).
