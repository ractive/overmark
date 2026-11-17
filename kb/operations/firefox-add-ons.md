---
type: operations
title: "Publishing on addons.mozilla.org"
description: >-
  The one-time setup by hand for the Firefox add-on (AMO developer account, the first
  version and the listing, the API key, the GitHub environment firefox-add-ons), what the
  release's job publish-firefox does, how to rerun it, and what to check on its first real run.
tags:
  - operations
  - release
  - firefox
timestamp: 2026-11-17T12:00:00+01:00
---

# Publishing on addons.mozilla.org

Firefox's counterpart to [the Chrome Web Store and Edge runbook](chrome-web-store.md)
(DEC-034, DEC-035). A release uploads itself there once the setup below is done by hand;
the add-on's id is `sitegloss@ractive.ch` (the manifest's `browser_specific_settings.gecko.id`),
desktop Firefox only (FIREFOX_MIN or later).

## One-time setup

1. **An AMO developer account** at <https://addons.mozilla.org/developers/> (a Mozilla
   account, two-step authentication on).
2. **The first version, by hand.** The workflow adds versions to an add-on that exists; it
   does not create one. At <https://addons.mozilla.org/developers/> choose "Submit your
   first add-on", "On this site" (listed), and upload:
   - the Firefox store zip of a release, `sitegloss-firefox-<version>-store.zip`;
   - when asked whether the code is minified or bundled: yes, and the release's
     `sitegloss-<version>-source.zip`, with the notes from `publish-firefox`'s `notes`
     in `.github/workflows/release.yml` (what the extension does, how to try it, how to
     build it);
   - desktop Firefox only (no Firefox for Android).
3. **The listing:** name Sitegloss; summary and description as for the other stores (the
   summary is the manifest's `description`; the store may take it from the package);
   categories (Developer Tools; the next best if AMO has none of that name); licence MIT
   (the repository's `LICENSE`); privacy policy
   <https://github.com/ractive/sitegloss/blob/main/PRIVACY.md> (the same page as for the
   other stores); notes to the reviewers as above. Say "environment", not "build", for
   another environment of a page.
4. **The API key** at <https://addons.mozilla.org/developers/addon/api/key/>: "Generate new
   credentials" gives a JWT issuer and a JWT secret. The secret is shown once; keep both in
   the password manager.
5. **The GitHub environment `firefox-add-ons`** (repository settings → Environments), as
   for `chrome-web-store` and `edge-add-ons`: a required reviewer (the owner), deployment
   tags `v*` only, and two environment secrets, `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`.
   Nothing in the repository's own secrets.

## What a release does

`release.yml` builds the Firefox store zip (`bun scripts/build.ts --firefox --store --zip`)
and `sitegloss-<version>-source.zip` (`git archive` of the built commit), attests every zip
and attaches them to the release. The job `publish-firefox` then waits for the owner's
approval and calls `firefox-extension-publish.yml` of ractive/release-workflows. It checks
the zips' attestations, then uploads the zip as a new listed version of the add-on and
attaches the source archive in the same request. AMO has no draft: the version goes to review
at once. The job ends successfully when AMO already has that version number (a rerun after
an upload that went through). A version number must be higher than the last one AMO has.

The source archive builds the zip again, byte for byte (the zip's entries have a fixed time):
the README's "Building the Firefox package from source" is what the reviewers follow, with
Bun 1.4.4, the version `release.yml` pins.

## By hand

Actions → "Publish to the stores" → Run workflow, the release's tag under "Use workflow
from", store `firefox` (or `all` for Chrome, Edge and Firefox). The "Submit" input does not
apply to Firefox.

## Before the first real run

The job has not run against AMO yet (ractive/release-workflows PR 17, pinned to its head
commit in both workflow files until v0.8.0 is released: then pin that release's commit).
On the first real run, check in AMO's Developer Hub:

- the new version is there with the source archive;
- **the notes to the reviewers arrived with the version.** AMO documents only `source`,
  `upload` and `license` for that multipart request. If the notes are missing, the workflow
  needs a follow-up PATCH, and the notes go in by hand for that version meanwhile;
- the data collection permissions in the version's details (nothing required, website
  content and browsing activity optional) match what the manifest says;
- AMO's validation shows no errors that the local build does not.

# Citations

- [Extension Workshop: Source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/)
- [AMO's API v5, versions and uploads](https://mozilla.github.io/addons-server/topics/api/addons.html)
