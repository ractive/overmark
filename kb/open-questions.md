---
type: questions
title: "Open questions for the owner"
description: Decisions the plan needs from the owner or from Acme IT before the pilot and the store listing.
tags:
  - questions
timestamp: 2026-11-04T17:00:00+01:00
---

# Open questions for the owner

1. **Relay for POs.** claude.ai and Claude Desktop connect from Anthropic's servers and
   need a relay with a public HTTPS address that allows Overmark's extension ID. Who runs
   it, or do POs start with file export only? The hosted `tab-mcp.ractive.ch` serves only
   ractive.ch's examples.
2. **Acme IT.** Is Developer mode allowed on company machines ("Load unpacked")? Is
   Chrome managed by policy, so IT could install Overmark?
3. **Test ids.** Do the Acme frontends have `data-testid` (or similar) attributes?
   They make finding elements again far more reliable.
4. **Visibility.** The repository was created private. Make it public (MIT, like
   tab-mcp)?
5. **Store account.** Publish under which Chrome Web Store developer account (one-time
   US$5, trader declaration)?
