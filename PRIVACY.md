# Overmark privacy policy

Overmark is a browser extension for annotating web pages. It has no server, no
account and no analytics. Its author receives nothing from it.

## What Overmark keeps, and where

When you save marks as a case, Overmark stores in your browser, on your computer
(IndexedDB of the extension):

- the case's title, your comments, the verdict, and when the case and its screenshots
  were made and changed;
- the page's address and title, its language, the window size and pixel density, and
  the browser's user agent;
- for each marked element: its tag, role, accessible name, up to 200 characters of its
  text, a hand-written `id` and a test id (`data-testid`, `data-test`, `data-test-id`,
  `data-qa`, `data-cy`) if it has them, the readable part of its CSS classes, a few
  attributes (`name`, `type`, `placeholder`, `alt`, `title`, the image file name, and a
  link's path with its query string, or the host and path for a link to another site),
  the heading above it, its landmark, up to six of the elements around it (tag with
  test id or class), its position, the page's size, and a CSS selector;
- screenshots of the visible part of the tab, with the marks on them, and a crop per
  mark.

The side panel also keeps its settings in the extension's local storage: the relay
address, "Blur form fields in screenshots", "Keep AI access on", and the secret from
which the tab-mcp library derives the address an AI app connects to.

Overmark never reads what is typed into form fields or text editors. A screenshot shows
what was on the screen, though, form fields included. When you save marks, "Blur form
fields in screenshots" blurs the page's form fields while the screenshots are taken,
and password fields are always blurred. This covers fields in the page itself, not
fields inside embedded frames (for example a payment form from another site). The
screenshots an AI app takes through Overmark (see below) are not blurred.

## When data leaves your computer

Only in two cases, both started by you:

1. **Export.** "Export" writes a case to a zip file. Where it goes from there is up to
   you.
2. **An AI app.** If you connect an AI app (for example Claude) in the side panel,
   Overmark answers that app's tool calls: the cases' contents and screenshots, and the
   address, title, element details and screenshots of the tab in front. They travel
   through the relay whose address you entered, and on to the AI app you paired with a
   code. The tab-mcp relay software forwards them without storing them; a relay that
   someone else runs is subject to its operator's practices. The AI app's provider
   handles the data under its own privacy policy.

   Changes the AI app wants to make (adding a mark, recording a verdict, deleting a
   case) are shown to you first. The prompt also offers "Always allow": once you choose
   it for a tool, that AI app may use the tool without asking until you disconnect the
   app or reload the side panel.

   Closing the side panel pauses the connection; it does not end the pairing. The paired
   AI app can use the tools again when the side panel connects again, which happens by
   itself when "Keep AI access on" is checked. Disconnect, next to the app in the AI
   connection dialog, removes the app.

Overmark does not sell data, use it for advertising, or pass it to anyone else.

## Permissions

- **activeTab:** Overmark runs on a tab only after you click its icon there (or press
  its shortcut), and only until that tab navigates elsewhere.
- **scripting:** to add its toolbar and outlines to that tab.
- **sidePanel:** for its side panel.
- **All sites (optional, off by default):** only if you choose "allow on all sites", so
  that Overmark works on a tab without clicking its icon first.

## Deleting

Delete a case in the side panel; its screenshots go with it. Removing the extension
deletes everything it stored.

## Contact

Jean-Pierre Bergamin, <https://ractive.ch>, james@ractive.ch.
Source code: <https://github.com/ractive/overmark>.
