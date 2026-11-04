---
type: operations
title: "Publishing in the Chrome Web Store"
description: >-
  The store listing for Overmark: texts, category, single purpose, permission
  justifications, data disclosures, and the steps to submit it unlisted and to take
  over the store's key afterwards.
tags:
  - operations
  - release
timestamp: 2026-11-04T19:00:00+01:00
---

# Publishing in the Chrome Web Store

## Steps

1. A Chrome Web Store developer account (one-time US$5, two-step verification, the
   trader declaration). Which account is an open question
   ([open questions](../open-questions.md)).
2. Publish [PRIVACY.md](../../PRIVACY.md) at a stable URL (a page on ractive.ch).
3. Build the store package: `bun scripts/build.ts --store --zip` writes
   `overmark-<version>-store.zip` (no `key` in the manifest; the store would reject it).
4. New item → upload the zip → fill in the listing below → visibility **Unlisted** →
   submit for review.
5. After the first upload: Package → "View public key". Put that key into
   `manifest-key.txt`, so unpacked builds get the store's ID. Update the README, the
   design note and `test/build.test.ts` with the new ID, and every relay's
   `TAB_MCP_SITES` entry. Edge Add-ons gives the extension a different ID again.

## Listing

- **Name:** Overmark
- **Summary (≤ 132 characters):** Annotate any web page, load the marks onto another
  build of it, and talk them through with your AI app.
- **Category:** Developer Tools
- **Language:** English

**Description:**

> Mark what is wrong on a web page and carry the marks to the build where it gets fixed.
>
> Pick an element, draw a box, an arrow or a freehand mark, add a note, and comment on
> each. Overmark saves them as a case with screenshots of the page with the marks on
> them, and records each marked element's details.
>
> Open the same page on another build, such as localhost or a test environment, and
> load the case: Overmark finds each mark's element and outlines it, green when found,
> amber when only probable. The screenshots stay the record, so every mark makes sense
> even when the page has changed.
>
> Export a case as a zip with a Markdown summary and the images, or connect an AI app
> such as Claude through a tab-mcp relay: it can read the cases, find the marks on the
> page in front, take screenshots, and record what should change. Changes it wants to
> make are shown to you first.
>
> Everything stays in your browser unless you export a case or connect an AI app.

**Single purpose:** Annotating web pages and reviewing the annotations on other builds
of the same pages, alone or with an AI app the user connects.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `activeTab` | Add the annotation toolbar to the tab where the user clicked the icon, read the marked elements' details, and take screenshots of that tab. |
| `scripting` | Inject the toolbar and outlines into that tab. |
| `sidePanel` | The side panel lists cases, loads them onto the tab and connects the AI app. |
| `<all_urls>` (optional) | Only when the user turns on "allow on all sites", so Overmark works without clicking its icon on each tab. |

**Remote code:** No. All code is in the package; the connection to the relay carries
data only, and no tool runs code an AI app sends.

**Data usage (Privacy practices tab):**

- Collected: website content (screenshots, page text excerpts, page addresses) and user
  activity limited to the marks the user draws.
- Stored locally in the browser. Transmitted only to the relay and AI app the user
  configures and pairs, and only while connected.
- Not sold, not used for anything but the extension's purpose, not used to determine
  creditworthiness.

**Screenshots for the listing (1280×800):** the toolbar with marks on a page; the side
panel with a case; a case loaded onto another build with green and amber outlines.

# Citations

- [Chrome Web Store program policies](https://developer.chrome.com/docs/webstore/program-policies)
