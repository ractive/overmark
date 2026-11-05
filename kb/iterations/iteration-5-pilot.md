---
type: iteration
title: "Iteration 5: pilot and store"
status: in-progress
description: "A first pilot with a PO and a dev on real Acme pages, measuring how often elements are found; the privacy policy and the store listing; the extension unlisted in the Chrome Web Store and the store's key in the manifest."
timestamp: 2026-11-04T17:00:00+01:00
tags: [iteration, release]
---
# Iteration 5: pilot and store

## Scope

- Pilot: a PO and a dev go through the workflow once (prod → localhost → dev). Measure
  on 15–20 real elements how often loading a case finds the right one on dev and on
  localhost.
- Privacy policy (`PRIVACY.md`, published on ractive.ch): what is stored (locally only),
  what is sent (only to the AI app the user connects, through the relay the user
  configures), nothing collected by Overmark.
- Store listing text, screenshots, the permission justifications.
- Release: a GitHub release with the zip; the Chrome Web Store (unlisted) with
  `bun run build --store`; then the store's public key into `manifest-key.txt`.

## Tasks

- [x] `PRIVACY.md`, store listing in `kb/operations/`
- [x] Release workflow (zip as a release asset)
- [ ] Pilot and matching measurement (owner, with a PO and a dev)
- [ ] Store submission (owner's developer account) and the store key
