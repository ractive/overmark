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
   need a relay with a public HTTPS address that allows Overmark's extension ID. The
   hosted `tab-mcp.ractive.ch` allows the development build's ID since relay 0.7.1 and is
   the side panel's default; the store build's ID still has to be added there
   (`kb/operations/chrome-web-store.md`, step 5). Open: does Acme accept that relay
   for POs, or run its own?
2. **Acme IT.** Is Developer mode allowed on company machines ("Load unpacked")? Is
   Chrome managed by policy, so IT could install Overmark?
3. **Test ids.** Do the Acme frontends have `data-testid` (or similar) attributes?
   They make finding elements again far more reliable.
4. **Visibility.** The repository was created private. Make it public (MIT, like
   tab-mcp)?
5. **Store account.** Publish under which Chrome Web Store developer account (one-time
   US$5, trader declaration)?
6. **To try by hand after iteration 17** (none of it can be run in the headless test
   browser). (a) In the real build, click "Sync to Downloads" and say yes to Chrome's
   question: are the cases written at once? It is not verified that a service worker
   that is already running gets `chrome.downloads` right after the grant; if it does
   not, the sync says so and starts when Chrome restarts Overmark's background
   (DEC-025). (b) Does Chrome's downloads bubble open on each write (changes are
   gathered for 2 s first)? (c) With Chrome's "Ask where to save each file" on, the
   sync fails and says to turn it off or choose a folder: is that acceptable?
7. **Decided overnight without the owner, to confirm or change.** (a) A Chrome
   notification whose question's arguments do not fit offers only "Don't allow" and
   sends the user to the side panel (DEC-018, amended): otherwise text is allowed
   unseen. (b) An AI app changes a verified mark only by reopening it (DEC-023).
   (c) `get_mark_element` refuses `:has()` and `:empty` altogether, and state
   pseudo-classes and value attributes in a selector (DEC-013, amended). (d)
   `PRIVACY.md` now says that computed styles and positions can reflect a field's
   state where the page's own CSS styles it by state, as a screenshot does. (e) "Stop
   syncing" gives the `downloads` permission back when the sync was what asked for it.
   (f) Not done, the stronger option: keeping Allow off until a question's arguments
   were scrolled to their end.
8. **Left from the code review** ([the review](research/code-review-2026-11.md)).
   Medium: CR-02, a content script orphaned by an update puts its toolbar back and its
   listeners stay (needs one teardown for every listener in `annotator.ts`,
   `overlay.ts`, `review.ts`). Low: CR-04, CR-05, CR-06, CR-10, CR-11, CR-12, CR-14,
   CR-15, and the six unverified ones (P-01 to P-06). Its architecture section names
   the cause of most of the bugs the reviews found that night: the page's adding queue
   and the panel's follow variables are a second, untested state beside the one state
   object each side was given (DEC-010, DEC-011).
9. **CI is flaky, about one run in four.** A `beforeAll` of the suites that pair an AI
   app over the test relay sometimes hangs for its 60 s (seen on main before iteration
   17 too; `mcpClient`'s connect has no time limit and is the likeliest place), and
   `shipped.test.ts` sometimes times out at the icon's click. Fixed that night: the
   review tests leaking a patched `getBoundingClientRect` into later files, and one
   failing end-to-end test taking the next twenty with it. Still there: two tests of
   `test/view.test.ts` fail when its tests run in another order (`--randomize`), and an
   export test's sizes leave about 470 bytes of margin for a longer `case.md` preamble.
10. **Dependabot's Biome 2.6.6** pull request fails CI and was not looked at.
