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
2. Publish [PRIVACY.md](https://github.com/ractive/overmark/blob/main/PRIVACY.md) at a
   stable URL (a page on ractive.ch).
3. Build the store package: `bun scripts/build.ts --store --zip --outdir dist-store`
   writes `overmark-<version>-store.zip` (no `key` in the manifest; the store would
   reject it). Without `--outdir` it would replace `dist/`, the unpacked development
   build, with a keyless one: Chrome would give that a new ID, and its cases and relay
   origin would seem gone. A release attaches the same zip (`release.yml`).
4. New item → upload the zip → fill in the listing below → visibility **Unlisted** →
   submit for review.
5. After the first upload: Package → "View public key". Put that key into
   `manifest-key.txt`, so unpacked builds get the store's ID. Update the README, the
   design note and `test/build.test.ts` with the new ID, and every relay's
   `TAB_MCP_SITES` entry. Edge Add-ons gives the extension a different ID again.

## Where the packages come from

- **Every CI run** (each push to a PR or to main) attaches two artifacts to its run
  page: `overmark-unpacked` (the zip for "Load unpacked", with the fixed key) and
  `overmark-store` (the store package, without it).
- **A release:** bump `version` in `package.json` in a PR, merge it, then
  `git tag vX.Y.Z <merge commit> && git push origin vX.Y.Z`. The release workflow
  checks the tag, runs `verify`, and creates the GitHub release with both zips.

## Updates through the publish workflow

The API only updates an item that exists, so the first version goes in by hand (steps
above). After that, "Publish to Chrome Web Store" (`publish.yml`, run by hand with a
release tag) downloads the release's store zip, checks that its manifest has the tag's
version and no key, and uploads it with
[mnao305/chrome-extension-upload](https://github.com/mnao305/chrome-extension-upload)
(Chrome Web Store API v2), pinned to a commit. With "submit" off the upload stays a
draft in the dashboard; with it on, the version is submitted for review and published
when approved. The store rejects an upload whose version is not higher than the last.

One-time setup:

1. In a Google Cloud project, enable the **Chrome Web Store API**. Configure the OAuth
   consent screen (External) and set its publishing status to **In production**: while
   it is "Testing", Google expires refresh tokens after seven days. An unverified app is
   fine for this personal use.
2. Create an OAuth client ID (type "Web application", with
   `https://developers.google.com/oauthplayground` as redirect URI).
3. In the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground), under
   the settings, use your own client ID and secret; authorize the scope
   `https://www.googleapis.com/auth/chromewebstore` with the store's developer account
   and exchange the code for a refresh token.
4. The publisher ID is under Publisher → Settings in the developer dashboard; the
   extension ID is the item's ID.
5. In the repository: Settings → Environments → new environment `chrome-web-store`.
   Secrets `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`; variables
   `CWS_PUBLISHER_ID`, `CWS_EXTENSION_ID`. Add yourself as required reviewer, and limit
   deployments to tags `v*`.

The upload action receives the client secret and the refresh token, which can publish
every item of the developer account. That is why it is pinned to a commit and runs in a
job that checks out nothing and installs nothing; Dependabot proposes its updates as
PRs (`.github/dependabot.yml`).

## Listing

- **Name:** Overmark
- **Summary:** the store takes it from the manifest's `description`, which
  `createManifest` in `scripts/build.ts` sets: "Annotate any web page, load the
  annotations onto another build of it, and talk them through with your AI app." (at
  most 132 characters). Change it there.
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
> make are shown to you first, every time.
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

- Collected:
  - **Web history:** the address, title and time of each page saved as a case, and the
    address and title of the tab in front when an AI app asks for them.
  - **Website content:** screenshots, page text excerpts and element details (see
    PRIVACY.md for the full list).
  - **User activity:** limited to the marks the user draws and their comments.
- Stored locally in the browser. Transmitted only to the relay and AI app the user
  configures and pairs, and only while connected. Every screenshot blurs password
  fields, and all form fields when the user turns that on, except fields inside
  embedded frames. Text typed into fields and editors is never recorded.
- Not sold, not used for anything but the extension's purpose, not used to determine
  creditworthiness.

**Screenshots for the listing (1280×800):** the toolbar with marks on a page; the side
panel with a case; a case loaded onto another build with green and amber outlines.

# Citations

- [Chrome Web Store program policies](https://developer.chrome.com/docs/webstore/program-policies)
