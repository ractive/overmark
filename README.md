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
2. "Annotate this page" shows the toolbar: Element (click one), Box, Arrow, Pen and Note,
   each followed by a comment. "Save case…" saves the marks as a new case with a title.
   Overmark takes screenshots with the marks on them and records each marked element's
   details. Saved marks stay on the page, fainter.
3. From then on, and whenever the toolbar was started with "Add marks" in a case, the
   toolbar says "Adding to “<case>”": each mark goes into that case as soon as its
   comment is done (Done, or the comment closed with Escape or a click elsewhere); there
   is no save step, and the case in the side panel shows it at once. Undo takes the last
   mark added since the toolbar was shown out of the case again, while nobody has
   resolved or edited it. A mark that could not be added stays on the page with the
   reason and an "Add mark N" button to try again; it never moves to another case unless
   you click that button. Done tries such marks once more and closes the toolbar when all
   are in; while one is not, the toolbar stays up and says so, and Done again discards
   it. New case stops adding to the case, and the next marks wait for "Save case…".
4. On another build of the page (say `localhost:3000`), click the case in the side panel:
   on the same path it loads at once; a case of another page has a Load button for this
   tab. In the case, "Show marks on this tab" and "Hide marks on this tab" put its marks
   on the page and take them off. On a tab Overmark may not run on yet (after reloading the extension, say), Chrome
   hides the address: click the Overmark icon there and the case loads, or press "Show
   marks on this tab" (or the case's Load button), and Chrome asks whether Overmark may
   run on the case's site from then on; that helps only when the tab is on that site. The case's address asks the same, then opens its page in a new tab and loads
   it there (marks a script draws late are looked for
   again for a few seconds), and when the
   tab's size is not the one the marks were made at, Match size resizes the window to it
   (as far as the screen allows; page zoom is counted). Overmark looks for each mark's element and draws the mark on it again,
   moved and scaled with the element: green when found, amber and dashed when probable
   or unsure. A mark drawn on a large container can land a little off when that
   container changed its size. A mark without an element goes where it was, in amber.
   Show scrolls to a mark; Next candidate tries the next best element. The screenshots
   stay the record, so a mark makes sense even when its element is not found.
5. Each mark in the side panel can be resolved (Fixed, Won't fix or Can't reproduce, with
   an optional note), opened again, have its comment edited, or be deleted. A resolved
   mark is drawn grey on a loaded page and no longer counted as open. A deleted mark's
   number is not given again, and its pin stays on screenshots that other marks share.
6. Export writes `<title>.overmark.zip` (`case.json`, `case.md` and the images) to pass
   on; Import reads one back and, when it is for the page in front, loads it right
   away. An AI app can read `case.md` and the images without the extension.

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
| `list_cases` | The saved cases |
| `get_case` | A case's marks with their comments, element details and crops |
| `get_image` | One screenshot or crop |
| `load_case` | Finds the marks' elements on the tab in front and draws the marks there |
| `highlight` | Scrolls to one mark's element (or another candidate) |
| `get_mark_element` | A mark's element on the tab in front, read from the live page: trimmed HTML, box and window size, computed styles, matching CSS rules, ancestors and children; a CSS selector reads one of its ancestors or an element inside it instead (for a mark without an element, an element of the case's page) |
| `capture` | A screenshot of the tab in front |
| `add_annotation` | Adds a mark on an element (by CSS selector); asks first |
| `set_verdict` | Records what should change; asks first |
| `set_mark_status` | Resolves a mark or opens it again; asks first |
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
  ractive/tab-mcp:0.7.0
```

Then, in the side panel's "AI app" card, set the relay to `http://localhost:8080`
and click "Turn on AI access" (or flip the AI access switch). With no AI app paired yet,
the card shows the address and a code at once; with apps paired, "+ Add another AI app"
shows them. Add the address to Claude Code, then run `/mcp` there and choose
Authenticate:

```sh
claude mcp add --transport http overmark <address>
```

Your browser opens the relay's page; type the code from the side panel. The connection
stays when you close the side panel (the icon shows "on"), until you turn the switch off
or click "Stop AI access" (either keeps the pairing), the relay's end of an idle session, or the browser closes; an update
or reload of the extension (or turning it off) ends it too. "Keep AI access on" connects
again by itself after all of these but "Stop AI access".

A tool that changes something (marked "asks first" above) asks every time: in the side
panel when it is open and on screen in the window in front (another extension's panel,
such as Claude in Chrome's, can cover it), otherwise in a system notification with
Don't allow and Allow (the icon shows "?" while a question waits). No answer within 60
seconds is Don't allow.

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
