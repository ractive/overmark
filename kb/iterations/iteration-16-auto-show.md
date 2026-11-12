---
type: iteration
title: "Iteration 16: opening a case shows its marks on the tab in front"
status: completed
description: "Opening a case draws its marks on the tab in front, whatever page that is, and they follow the tab in front while the case is open (another tab, a reload, a navigation); All cases takes them off, a Hide holds on its tab; a case with none of its marks found says it is probably for another page; without access to the tab a notice with a warning sign and Allow on all sites, and only what needs the page is off (DEC-022)."
timestamp: 2026-11-12T18:00:00+01:00
tags: [iteration, ui, loading]
---
# Iteration 16: opening a case shows its marks on the tab in front

The owner, 2026-11-12: a case should never be open without its marks on the page, the
marks should come along when another tab comes to the front, and a case whose marks are
nowhere on the page should say so. The side panel without access to the tab gets a
notice with a warning sign and "Allow on all sites". The decision is DEC-022; the
branch is `feat/auto-show`.

## Scope

- `src/sidepanel/follow.ts`: `followStep`, what the panel does for the open case and the
  tab in front (draw, wait for access, nothing; the marks to take off the tab before),
  and `noneFound`, whether the draw found none of the case's marks. Pure, with unit
  tests.
- `src/sidepanel/main.ts`: `follow`, run when a case is first read, when a tab of the
  panel's window comes to the front, when the tab in front has loaded or navigated, when
  a permission is added and when the icon's click lets Overmark into the tab the case
  waits for. The panel remembers where it drew the marks (`drawn`) and the tabs the user
  hid them on (`hiddenOn`); "← All cases" takes them off. `openPage` only opens the tab:
  `follow` draws there once it has loaded. The case list's Load and `openAndLoad` go.
- `src/sidepanel/view.ts`: the access notice (home and case view, a warning sign as
  inline SVG, "Allow on all sites" or, where Chrome keeps the tab off limits, no
  button), the page-dependent buttons off with a tooltip, the "none found" warning with
  "Open the case's page", "This page" as the one heading.
- Unit tests for `follow.ts` and the view; end-to-end tests for drawing on another page
  without a click, following to another tab, Hide holding through a switch and a
  reload, back to the list taking the marks off, the warning on a page without the
  marks, the notice in the store package and its Allow on all sites.
- README, the design overview, DEC-022, the log.

## Tasks

- [x] `followStep` and `noneFound` with unit tests
- [x] Opening a case draws on the tab in front; the marks follow `onActivated` and
      `onUpdated`; the tab before is cleared; back to the list clears; Hide holds
- [x] The "none found" warning after the searches again, with "Open the case's page"
- [x] The access notice with a warning sign and "Allow on all sites"; only the
      page-dependent buttons off, with a tooltip
- [x] The panel reads the tab again when the icon's click lets Overmark in, so the
      notice goes and the buttons come on (it kept the hidden address before)
- [x] "This page" instead of "This tab" above "This page"
- [x] End-to-end tests updated and added
- [x] Docs

## Left open

- Closing the side panel with a case open leaves its marks on the page, as before, until
  the page reloads or "Hide" on the page's bar. Opening the case again in a new panel
  finds them there and does not draw again, so that panel does not count them as its
  own and "← All cases" leaves them. Taking them off when the panel closes would need
  the worker to know where the panel drew them.
- Hide holds on its tab until the case is opened again; a user who hid the marks and
  then reloads the tab gets no marks, by design. The owner may want a reload to count
  as a fresh start.
- An AI app's `load_case` of the same case onto the tab where the panel drew it: the
  panel takes those marks off with its own at "← All cases", since they are the same
  case on the same tab.
- The yes of "Allow on all sites" is covered by `permissions.onAdded` only by reading:
  the store package's end-to-end test can click the button and see the request, but no
  test can answer Chrome's prompt with a yes.

# Citations

- [Chrome for Developers: The activeTab permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome for Developers: chrome.tabs, `Tab.url` needs the tabs permission or host access](https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab)
- [Chrome for Developers: chrome.permissions, `request` only during a user gesture](https://developer.chrome.com/docs/extensions/reference/api/permissions#method-request)
