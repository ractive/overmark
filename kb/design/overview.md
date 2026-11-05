---
type: design
title: "Overmark design"
description: >-
  What Overmark is for, the workflow from a PO's annotation on prod to a dev's fix on
  localhost and the check on dev and prod, the parts of the extension, the case format,
  how an element is found again on another build, and the tools an AI app gets through
  tab-mcp.
tags:
  - design
  - architecture
timestamp: 2026-11-05T08:00:00+01:00
---

# Overmark design

Overmark is a Chrome (and Edge) extension for annotating any web page: pick an element,
draw boxes, arrows and freehand marks, and comment on each. The annotations are saved
as a named **case**. A case can be loaded onto another build of the page (localhost,
dev, prod), exported as a file, and read or extended by an AI app such as Claude through
a [tab-mcp](https://github.com/ractive/tab-mcp) relay.

## Workflow

1. A PO, designer or PM sees an issue on `https://www.example.com/…`, clicks the
   Overmark icon, annotates the page and saves the case. They talk it through with
   their AI app, which records a verdict in the case.
2. A dev opens `http://localhost:3000/…` themselves, loads the case onto that tab
   (from the extension, or from an exported file), sees what was meant, and fixes it
   with their AI app.
3. After the rollout the PO loads the case onto
   `https://dev.example.com/…`, later prod, and checks the fix.

Overmark never opens or switches environments itself: a case is loaded onto whatever
tab is in front. Forwarding cases to a team (tickets, links) is out of scope for now.

## The screenshot is the record

Finding the same element on another build is unreliable: class names from CSS modules
change, generated ids change, content differs between environments, layouts differ by
window size, and the fix itself changes the element. So the **annotated screenshot**
is what a case is about, and finding the element again is a best-effort extra:

- When saving, Overmark captures the visible part of the page with the drawings on it
  (one screenshot per scroll position that holds annotations) and a crop per
  annotation.
- Shapes are stored in the screenshot's own coordinates (CSS pixels of that viewport).
  They never have to follow the live page.
- Each annotation also stores the details of its element (tag, role, accessible name,
  text, test id, the readable part of its classes, the heading above it, its landmark,
  its ancestors, its position). They are hints for the AI app and the dev to find the
  code, and the input of the matching below.
- Loading a case onto a tab highlights each annotation's element where it can be found
  ("found", "probable", "ambiguous" with candidates, or "not found"). The side panel
  always shows the annotated screenshots, so a case makes sense even when nothing is
  found.

## Parts

| Part | Job |
|---|---|
| Content script (`src/content/`) | Toolbar and drawing overlay in a shadow DOM, element picker, element details, the save pipeline (scroll, capture, shapes), highlighting a loaded case |
| Service worker (`src/background.ts`) | Opens the side panel and injects the content script on the icon click; `captureVisibleTab`; WebP conversion and crops; writes cases |
| Side panel (`src/sidepanel/`) | Case list, case viewer, verdict, export and import, and `TabMcp` (connect dialog, tools, confirmations) |
| Library (`src/lib/`) | Case format, element details, matching, zip, export, IndexedDB store, images |

Storage is IndexedDB in the extension's origin (database `overmark`, stores `cases` and
`images`), shared by the service worker and the side panel. A content script runs in
the page's origin and never touches it directly.

### Permissions

- `activeTab`: clicking the icon (or the keyboard shortcut) on a tab allows Overmark on
  that tab until it navigates: injecting the content script and `captureVisibleTab`.
- `scripting`, `sidePanel`.
- `unlimitedStorage`: IndexedDB holds the only copy of the cases, so the browser must not
  evict it when disk space runs low. Chrome documents the permission as exempt from quota
  and eviction, and it adds no install warning, which keeps DEC-003's small warning.
- Optional `<all_urls>`, asked for in the side panel ("Allow on all sites") only when the
  user wants Overmark without clicking the icon on each tab. `captureVisibleTab` accepts
  `activeTab` or `<all_urls>`, not a single site's permission.

No JavaScript from an AI app or a server ever runs: the tools are fixed (Chrome Web Store
rules on remote code, and safety).

### The tab-mcp connection

`TabMcp` from `@ractive-ch/tab-mcp-client` runs in the side panel, an extension page. Its
WebSocket therefore carries the extension's origin `chrome-extension://<id>`, which a
website cannot fake. A content script's requests would carry the page's origin, so the
connection must not live there. The relay must allow the extension's origin (tab-mcp
iteration 17; `TAB_MCP_ALLOWED_ORIGINS=*` works in development). Closing the side panel
ends the connection, as closing a tab does for a page.

The extension ID is fixed by the `key` in the manifest (`manifest-key.txt`, a public key;
development ID `fphhchhlgklidhnodoleiebmdhnfdadg`). Store builds leave the key out; once
the Chrome Web Store has assigned its key, that key replaces ours so unpacked and store
builds share one ID.

## Case format

A case is JSON (`format: "overmark/1"`) with its images referenced by relative path. The
same JSON is stored in IndexedDB and written into the export, so an export is the case
plus its images:

```text
<title>.overmark.zip
  case.json      the case
  case.md        generated: comments, element details, verdict, image links
  shots/s1.webp  annotated screenshots
  crops/a1.webp  one crop per annotation
```

```json
{
  "format": "overmark/1",
  "id": "c_…", "title": "Login button contrast",
  "createdAt": "…", "updatedAt": "…",
  "page": { "url": "https://www.example.com/…", "title": "…", "lang": "de",
            "viewport": { "width": 1440, "height": 900, "dpr": 2 }, "userAgent": "…" },
  "shots": [{ "id": "s1", "image": "shots/s1.webp", "scrollX": 0, "scrollY": 0,
              "viewport": { "width": 1440, "height": 900, "dpr": 2 }, "capturedAt": "…" }],
  "annotations": [{
    "id": "a1", "number": 1, "shot": "s1", "comment": "…", "author": "user",
    "shape": { "kind": "box", "rect": { "x": 10, "y": 20, "width": 200, "height": 40 } },
    "crop": "crops/a1.webp",
    "element": { "tag": "button", "role": "button", "name": "Anmelden", "…": "…" }
  }],
  "verdict": null
}
```

Shape kinds: `element` (a picked element's box), `box`, `arrow` (`from`, `to`), `pen`
(`points`), `note` (`at`). The element details carry a best-effort CSS selector as a
W3C Web Annotation `CssSelector`; a full W3C export is a follow-up if a consumer needs it
(DEC-002).

## Finding an element again

Overmark stores a fingerprint of the element, not a selector, and scores every candidate
on the new page by weighted similarity (after Similo, see
[prior art](../research/prior-art.md)):

| Feature | Weight | Comparison |
|---|---|---|
| test id (`data-testid`, `data-test`, `data-test-id`, `data-qa`, `data-cy`) | 3 | equal |
| hand-written id | 1.5 | equal |
| tag | 1.5 | equal |
| role (explicit or implied) | 1 | equal |
| accessible name | 1.5 | text similarity |
| text | 1.5 | text similarity |
| readable classes | 1 | Jaccard |
| attributes (`name`, `type`, `href` path, `src` file, `placeholder`, `alt`, `title`) | 1 | share equal |
| heading above | 1 | text similarity |
| landmark | 0.5 | equal |
| ancestors | 0.5 | sequence similarity |
| position on the page | 0.5 | distance, relative to the page size |
| size | 0.5 | area ratio |

Only features the stored fingerprint has count. Siblings share most of these
features, so a candidate that shares none of what identifies the stored element (its
test id, id, accessible name or text; similarity below 0.5) keeps only half its score,
rising to all of it at 0.7: the neighbour of a removed element is "not found" rather
than "found". An element whose text the fix rewrote completely is then not found
either; the screenshot still shows what was meant. Classes are reduced to their readable
part (`Button_primary__x7Yz2` → `Button_primary`); random ones (`sc-…`, `css-…`,
`kLmNoP`) and generated ids (React `:r1:`, UUIDs, long numbers) are ignored. A best
score of 0.75 or more is "found", 0.5 or more "probable"; when the second-best score is
within 0.03 of the best, the result is "ambiguous" and the side panel steps through the
candidates.

## Tools for the AI app

| Tool | What it does | Asks first |
|---|---|---|
| `list_cases` | Cases with title, page, number of annotations, verdict | no |
| `get_case` | A case's annotations, element details and crops | no |
| `get_image` | One screenshot or crop, scaled to at most 1568 px | no |
| `load_case` | Loads a case onto the tab in front and reports what was found | no |
| `highlight` | Scrolls to and outlines one annotation's element (or another candidate) | no |
| `capture` | A screenshot of the tab in front | no |
| `add_annotation` | Adds a comment on an element (by CSS selector) to a case | yes |
| `set_verdict` | Writes the case's verdict | yes |
| `delete_case` | Deletes a case | yes |

Every call that changes something asks in the side panel, every time (DEC-008). The
question names the case (title, page, number of marks) and, for `add_annotation`, the page
in front, next to the raw arguments.

The tools that act on the tab (`load_case`, `highlight`, `capture`, `add_annotation`) run
one at a time: they share the page's one loaded case and one temporary mark. An AI app's
screenshots blur form fields as the user's own do (password fields always, all fields
with the side panel's setting), go through the service worker's capture queue, and are
refused when the tab is no longer in front.

Results that carry page content are marked `untrustedContentHint`: page text can contain
instructions aimed at the AI app. A result stays within three quarters of the relay's
message limit (1 MiB by default), its text included: a large case is sent with element
summaries and shortened texts, and crops that do not fit are listed for `get_image`.
Images are WebP; crops of at most 800 px go as they are stored.
