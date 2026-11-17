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

- Firefox end-to-end tests (`test/e2e/firefox/`, through the ff-rdp CLI, headless, a
  temporary profile): 9 tests, about a minute; three runs in a row on macOS (61 s, 59 s,
  58 s) and two in a Debian arm64 container with 2 CPUs (56 s, 59 s). The install without
  a manifest warning, an element mark and a box with screenshot and crop (also at 150 %
  zoom), the marks found again after a reload, export and import, the sync to Downloads
  rewriting a file in place, AI access against a test relay with a question and 35 s of
  idle, no error in the background, and the store package refusing its panel page in a
  tab. Skipped locally without ff-rdp or Firefox, required in CI, which installs Firefox
  160.0 by its checksum and ff-rdp 0.5.0 by its attestation.
- The Firefox store zip built from the unpacked source archive is byte for byte the same
  in another directory and at another time, and on another system: the zip CI built on
  Ubuntu (x86_64) and one built on macOS (arm64) from the same commit have the same
  SHA-256. Before the fix the zips of two builds differed in the entries' time only.
- The review (Claude 8, GLM 1): the release's build job ran the tests without Firefox and
  ff-rdp, so a tag would have made no release (it installs them now, and a test keeps its
  pins equal to CI's); a notification's click cannot open the sidebar (no user gesture),
  so the text names the icon; `shadowOf` read Firefox's property in Chrome too, where a
  form's control of that name answered for it; a Firefox start that outlived its hook was
  never stopped; the tests' error record died with the idle event page (it is in
  `storage.session` now, warnings included).
- Not available in Firefox for Android. `file:` pages work once the user turns on "Access
  local files on your computer" in Firefox's add-on settings (tried in Firefox 160 with
  the grant written into the profile; the toggle itself is out of automation's reach).

## Left open

- Whether addons.mozilla.org keeps the notes sent with the upload (DEC-035).
- Where a download that no click started shows in Firefox: by its source it does not open
  the downloads panel (the toolbar's downloads button only flashes); headless testing could
  not show the panel itself.

# Citations

- [Extension Workshop: Source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/)
