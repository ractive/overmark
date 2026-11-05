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
   each followed by a comment. Save the marks as a case with a title. Overmark takes
   screenshots with the marks on them and records each marked element's details.
3. On another build of the page (say `localhost:3000`), open the case in the side panel
   and click "Load onto this tab". Overmark looks for each mark's element and outlines
   it: green when found, amber and dashed when probable or unsure. Show scrolls to it;
   Next candidate tries the next best element. The screenshots stay the record, so a
   mark makes sense even when its element is not found.
4. Export writes `<title>.overmark.zip` (`case.json`, `case.md` and the images) to pass
   on; Import reads one back. An AI app can read `case.md` and the images without the
   extension.

## With an AI app

The side panel offers the cases to an AI app (Claude Code, Claude, ChatGPT, Codex)
through a [tab-mcp](https://github.com/ractive/tab-mcp) relay:

| Tool | What it does |
|---|---|
| `list_cases` | The saved cases |
| `get_case` | A case's marks with their comments, element details and crops |
| `get_image` | One screenshot or crop |
| `load_case` | Finds the marks' elements on the tab in front and outlines them |
| `highlight` | Scrolls to one mark's element (or another candidate) |
| `capture` | A screenshot of the tab in front |
| `add_annotation` | Adds a mark on an element (by CSS selector); asks first |
| `set_verdict` | Records what should change; asks first |
| `delete_case` | Deletes a case; asks first |

No tool runs code an AI app sends. Page text in the results comes from web pages, and
the tools say so to the model.

### A relay on your computer, for Claude Code

The relay must allow Overmark's origin, `chrome-extension://fphhchhlgklidhnodoleiebmdhnfdadg`.
Relays from tab-mcp's next release on take it as a site:

```sh
docker run --rm -p 127.0.0.1:8080:8080 \
  -e NODE_ENV=development \
  -e TAB_MCP_PUBLIC_URL=http://localhost:8080 \
  -e TAB_MCP_STORE=memory \
  -e TAB_MCP_SITES='[{"origin":"chrome-extension://fphhchhlgklidhnodoleiebmdhnfdadg","name":"Overmark"}]' \
  ractive/tab-mcp:<next release>
```

Relay 0.6.1 does not accept extension origins yet; for development, run it open with
`-e TAB_MCP_ALLOWED_ORIGINS='*'` instead of `TAB_MCP_SITES`, bound to `127.0.0.1` as
above. An open relay lets any website open sessions on it, so never expose it.

Then, in the side panel's "AI app" section, keep the relay at `http://localhost:8080`
and click "Connect AI app". Add the address it shows to Claude Code, then run `/mcp`
there and choose Authenticate:

```sh
claude mcp add --transport http overmark <address>
```

Your browser opens the relay's page; type the code from the side panel. "Keep AI access
on" connects again whenever the side panel opens, and when the relay ended an idle
session. "Stop AI access" ends the connection and keeps the pairing, as closing the side
panel does; closing a tab does the same for a web page.

claude.ai, Claude Desktop and ChatGPT connect from their own servers, so they need a
relay with a public HTTPS address that allows Overmark's ID.

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
