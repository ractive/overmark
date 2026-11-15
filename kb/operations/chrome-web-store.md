---
type: operations
title: "Publishing in the Chrome Web Store"
description: >-
  The store listing for Sitegloss: texts, category, single purpose, permission
  justifications, data disclosures, and the steps to submit it unlisted and to take
  over the store's key afterwards.
tags:
  - operations
  - release
timestamp: 2026-11-05T08:00:00+01:00
---

# Publishing in the Chrome Web Store

## Steps

1. A Chrome Web Store developer account (one-time US$5, two-step verification, the
   trader declaration). Which account is an open question
   ([open questions](../open-questions.md)).
2. Publish [PRIVACY.md](https://github.com/ractive/sitegloss/blob/main/PRIVACY.md) at a
   stable URL: it is the page `https://ractive.ch/sitegloss/privacy/`, kept in
   `ractive/ractive.ch` (`src/pages/sitegloss/privacy/`); a change of `PRIVACY.md` goes
   there too.
3. Build the store package: `bun scripts/build.ts --store --zip --outdir dist-store`
   writes `sitegloss-<version>-store.zip` (no `key` in the manifest; the store would
   reject it). Without `--outdir` it would replace `dist/`, the unpacked development
   build, with a keyless one: Chrome would give that a new ID, and its cases and relay
   origin would seem gone. A release attaches the same zip (`release.yml`).
4. New item → upload the zip → fill in the listing below → visibility **Unlisted** →
   submit for review.
5. After the first upload: Package → "View public key". Put that key into
   `manifest-key.txt`, so unpacked builds get the store's ID. Update the README, the
   design note and the tests with the new ID, and every relay's `TAB_MCP_SITES` entry,
   including the hosted relay's `TAB_MCP_ALLOWED_ORIGINS` in ractive/ractive.ch
   (`infra/tab-mcp/variables.tf`). Done on 2026-11-16 for the store item `ldmcfigcnobhnbaigehcaodheklibeon`
   (DEC-031). Edge Add-ons gives the
   extension a different ID again.

## Where the packages come from

- **Every CI run** (each push to a PR or to main) attaches two artifacts to its run
  page: `sitegloss-unpacked` (the zip for "Load unpacked", with the fixed key) and
  `sitegloss-store` (the store package, without it).
- **A release:** bump `version` in `package.json` in a PR, merge it, then
  `git tag vX.Y.Z <merge commit> && git push origin vX.Y.Z`. The release workflow
  checks the tag, runs `verify`, and creates the GitHub release with both zips. It stops
  if the tag has moved off the commit it built.
- **Attestations:** once the repository is public, the release workflow attests both
  zips before it creates the release (build provenance, signed through Sigstore): that
  this workflow built a file with that digest from that commit. Check a downloaded zip
  with `gh attestation verify sitegloss-X.Y.Z.zip --repo ractive/sitegloss`. While the
  repository is private the step is skipped: GitHub has attestations for private
  repositories only on Enterprise Cloud.

Every build, and so every zip, holds `LICENSES.txt`: Sitegloss's licence and those of the
packages in its bundles. A bundled package whose licence the build does not know stops
the build (`LICENCES` in `scripts/build.ts`).

## Updates through the publish workflow

The API only updates an item that exists, so the first version goes in by hand (steps
above). After that, run "Publish to Chrome Web Store" (`publish.yml`) by hand: Actions →
Publish to Chrome Web Store → Run workflow, and pick the release's tag under "Use workflow
from". The default there is `main`, which fails: the tag the workflow runs on is the tag
it uploads, and it has no other way to name one. It downloads that release's store zip,
checks that its manifest has the tag's version and no key, and uploads it with
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
   deployments to tags `v*` (the reason a run starts from the tag, not from `main`).

The upload action receives the client secret and the refresh token, which can publish
every item of the developer account. That is why it is pinned to a commit and runs in a
job that checks out nothing and installs nothing; Dependabot proposes its updates as
PRs (`.github/dependabot.yml`).

## Listing

- **Name:** Sitegloss
- **Store icon:** `assets/store/icon-128.png`, 128 × 128 with 16 px of transparent
  padding (DEC-029). `bun scripts/icons.ts` draws it.
- **Summary:** the store takes it from the manifest's `description`, which
  `createManifest` in `scripts/build.ts` sets: "Mark what is wrong on a web page, open
  the marks in another environment to fix it, and talk them through with your AI app."
  (at most 132 characters). Change it there; the store reads it from the uploaded
  package, so a new summary needs a new version. The repository's About text on GitHub
  is a fourth copy (`gh repo edit ractive/sitegloss --description "…"`).
- **Category:** Developer Tools
- **Language:** English
- **Official URL:** `ractive.ch`. The dashboard offers only sites verified in Search
  Console by the Google account of the store's developer account; `ractive.ch` is
  verified in the owner's.
- **Homepage URL:** `https://ractive.ch/sitegloss/`, beside tab-mcp's page.
- **Support URL:** `https://github.com/ractive/sitegloss/issues`.
- **Privacy policy:** `https://ractive.ch/sitegloss/privacy/` (step 2).

**Description:**

> Mark what is wrong on a web page, and take the marks to where it gets fixed.
>
> Pick an element, draw a box, an arrow or a freehand line, or drop a note, and write a
> comment. Every mark is saved to a case right away, with a screenshot and the details
> of the element you marked.
>
> Then hand the case over. A developer opens it on the same page in their own
> environment, such as localhost or a test system. Sitegloss finds each marked element
> again and outlines it: solid when it is sure, dashed when it is a likely match. The
> screenshots stay as the record, so every mark still makes sense when the page has
> changed.
>
> For the full experience, connect your AI app. With an app such as Claude connected
> both to your browser and to Sitegloss, it looks at the live page and at your marks
> together: it reads your comments, finds the marked elements on the page in front of
> you, inspects their HTML and CSS, and works out what should change. Sitegloss connects
> through a tab-mcp relay, and anything the app wants to change in a case is shown to
> you first, unless you chose to always allow it.
>
> Export a case, or all of them, as a zip with a Markdown summary and the images, or
> keep every case synced to your Downloads or a folder of your choice, in iCloud Drive
> or Dropbox for example.
>
> Your cases stay in your browser unless you export them, sync them or connect an AI
> app. Sitegloss works inside the page, so that page's own scripts can see what it shows
> there and the keys you press there.

**Single purpose:** Annotating web pages and reviewing the annotations on the same pages
in other environments, alone or with an AI app the user connects.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `activeTab` | Add the annotation toolbar to the tab where the user clicked the icon, read the marked elements' details, and take screenshots of that tab. |
| `alarms` | While the user has the AI app connected, wake the background service worker once a minute, so the connection comes back after the computer slept. |
| `notifications` | When the connected AI app wants to change something (add a mark, record the summary for the developer, change a mark's status, add, change or delete one of its findings on a mark, delete a case) and the side panel is not open in front, ask the user in a notification with Allow and Always allow; closing it is Don't allow. Where the call's arguments do not fit in a notification, it offers only Don't allow and says to answer in the side panel, which shows them all (its question has Don't allow, Allow and Always allow). A tool runs without a question only after the user chose Always allow for that tool, or turned on "Allow all changes", for that AI app, until the app is disconnected; otherwise nothing changes without the user's answer. |
| `offscreen` | The sync to Downloads, which the user turns on with "Sync to Downloads": the background service worker cannot make a URL for a case's file (no `URL.createObjectURL`), so while it writes the cases it opens an offscreen document (reason `BLOBS`) that builds one case's export file and makes its blob URL, which the worker downloads; the document closes when the cases are written. |
| `scripting` | Inject the toolbar and outlines into that tab. |
| `sidePanel` | The side panel lists cases, loads them onto the tab, and shows the AI app's connection and its questions. |
| `storage` | Session storage, cleared when the browser closes: which marks the toolbar on which tab just added, so its Undo can take back those marks and no others, and whether AI access is on. (The AI connection's settings and the secret from which its address is derived are in the extension's own IndexedDB, used by its service worker only.) |
| `unlimitedStorage` | Cases and their screenshots exist only in the browser's IndexedDB. This keeps the browser from evicting them when disk space runs low, and lets a user keep more than the default quota. |
| `downloads` (optional) | Asked for when the user clicks Export (or Export all cases) or "Sync to Downloads" in the side panel. Sitegloss saves its own export file through `chrome.downloads.download` and reads that one download's path (`downloads.search` by its id), to show the user where the file went with Copy and "Show in folder" (`downloads.show`). With the sync to Downloads it writes each case as its own file to `Sitegloss/` in the downloads folder, overwriting that case's file when the case changes, and erases its own previous entry from the download list (`downloads.erase`, the file stays). It reads no other download. Without it the export is saved as a plain download, without the path, and the sync can only go to a folder the user chooses. |
| `<all_urls>` (optional) | Asked for one site at a time when the user opens a case's page in a new tab (the case's address in its header, or "Open the case's page" when none of its marks were found on the tab in front), so the case's marks are drawn there without clicking the icon. All sites only when the user clicks "Allow on all sites" (in the side panel's notice on a tab Sitegloss may not run on yet) or turns on the option "Allow on all sites, without clicking the icon on each tab". |

**Remote code:** No. All code is in the package; the connection to the relay carries
data only, and no tool runs code an AI app sends.

**Data usage (Privacy practices tab):**

- Collected:
  - **Web history:** the address, title and time of each page a case is started on, and the
    address and title of the tab in front when an AI app asks for them.
  - **Website content:** screenshots, page text excerpts and element details (the
    exact fields are defined in `src/lib/`); when the AI app asks about a mark, also the marked
    element's (or an element around or inside it) trimmed HTML, computed styles and
    matching CSS rules from the page in front, sent to the AI app and not stored,
    without form field values, text typed into editable regions, hidden elements or
    the page's head, and with addresses cut to their path.
  - **User activity:** limited to the marks the user draws and their comments.
- Stored locally in the browser. Transmitted only to the relay (by default the hosted
  relay tab-mcp.ractive.ch, run by the developer; the user can enter another) and the
  AI app the user pairs, and only while connected. Every screenshot blurs password
  fields, and all form fields when the user turns that on, except fields inside
  embedded frames. Text typed into form fields and editable regions is not recorded; of
  the editors that draw their text as ordinary page content, only Monaco, CodeMirror 5
  and Ace are recognised.
- Not sold, not used for anything but the extension's purpose, not used to determine
  creditworthiness.

**Screenshots for the listing (1280×800):** the toolbar with marks on a page; the side
panel with a case; a case loaded in another environment with its marks outlined, solid
and dashed.

# Citations

- [Chrome Web Store program policies](https://developer.chrome.com/docs/webstore/program-policies)
- [Storage and cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies):
  `unlimitedStorage` "exempts extensions from both quota restrictions and eviction".
- [Permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list):
  `unlimitedStorage` and `alarms` show no warning, `notifications` shows "Display
  notifications". `test/e2e/shipped.test.ts` asks Chrome itself.
