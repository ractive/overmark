---
type: iteration
title: "Iteration 18: a Firefox build and its release"
status: in-progress
description: "Sitegloss in desktop Firefox from one codebase (an event page, a sidebar, Firefox's data collection consent for AI access, sync to Downloads), and a release that publishes itself to addons.mozilla.org with a source archive (DEC-034, DEC-035)."
timestamp: 2026-11-17T12:00:00+01:00
tags: [iteration, firefox, release]
---
# Iteration 18: a Firefox build and its release

## Goal (the owner)

Sitegloss in Firefox too, once the hosted relay admits Firefox extensions (tab-mcp's
DEC-189, 2026-11-16), and published on addons.mozilla.org by the release itself like in the
Chrome Web Store (DEC-032) and Edge Add-ons (DEC-033). Decisions: DEC-034 (the build, which
amends DEC-003) and DEC-035 (the release).

## Tasks

- [x] One codebase, the difference decided at build time (`--firefox`, `SITEGLOSS_FIREFOX`,
      `src/lib/browser.ts`); an event page, a sidebar, no offscreen document
- [x] Firefox's data collection consent asked at the click that turns AI access on
- [x] Sync to a subfolder of Downloads only; notifications without buttons; the tab's size
      read every 3 s
- [x] A development launcher with one kept profile (`scripts/firefox-dev.ts`)
- [x] The package for addons.mozilla.org: not minified, no source maps
      (`--firefox --store --zip`)
- [x] A reproducible zip: entries with a fixed time, checked from the source archive in two
      directories, with a rebuild three seconds later (the same SHA-256)
- [x] `release.yml`: the Firefox store zip and the source archive, attested and attached;
      the job `publish-firefox`; `publish.yml` with store `firefox` and `all`
- [x] README (In Firefox, Building the Firefox package from source) and PRIVACY
- [x] Runbook [firefox-add-ons.md](../operations/firefox-add-ons.md)
- [ ] The first version and the listing by hand on addons.mozilla.org, the environment
      `firefox-add-ons` with the API key
- [ ] The first real run of `publish-firefox` (the reviewers' notes arrive with the version?)
- [ ] Pin ractive/release-workflows v0.8.0's commit instead of PR 17's head

## Results

- Firefox end-to-end tests: `E2E_RESULTS`
- The Firefox store zip built from the unpacked source archive is byte for byte the one
  built again anywhere else. Before the fix the zips of two builds differed in the entries'
  time only.
- Not available in Firefox for Android. No "Allow access to file URLs" button in Firefox
  for now.

## Left open

- Whether addons.mozilla.org keeps the notes sent with the upload (DEC-035).
- Where a download that no click started shows in Firefox: by its source it does not open
  the downloads panel (the toolbar's downloads button only flashes); headless testing could
  not show the panel itself.

# Citations

- [Extension Workshop: Source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/)
