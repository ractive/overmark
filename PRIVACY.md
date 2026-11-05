# Overmark privacy policy

Overmark is a browser extension for annotating web pages. It has no server, no
account and no analytics. Its author receives nothing from it.

## What Overmark keeps, and where

When you save marks as a case, Overmark stores in your browser, on your computer
(IndexedDB of the extension):

- the case's title, your comments, the verdict, when the case and its screenshots were
  made and changed, and for an imported case when it was imported;
- the page's address, its title, its language, the window size and pixel density, and
  the browser's user agent. The address is kept without its query string or fragment,
  which can carry personal data or tokens, and without a user name or password. Only a
  fragment that is a route of the page (`#/cases/7`) stays, up to the first `?`, `&`,
  `=` or `#` in it;
- for each marked element: its tag, role, accessible name, up to 200 characters of its
  text, a hand-written `id` and a test id (`data-testid`, `data-test`, `data-test-id`,
  `data-qa`, `data-cy`) if it has them, the readable part of its CSS classes, a few
  attributes (`name`, `type`, `placeholder`, `alt`, `title`, the image file name, and a
  link's path, or the host and path for a link to another site; never a link's query
  string or fragment),
  the heading above it, its landmark, up to six of the elements around it (tag with
  test id or class), its position, the page's size, and a CSS selector;
- screenshots of the visible part of the tab, with the marks on them, and a crop per
  mark.

The side panel also keeps its settings in the extension's local storage: the relay
address, "Blur form fields in screenshots", "Keep AI access on", and the secret from
which the tab-mcp library derives the address an AI app connects to.

Overmark never records what is typed into form fields or text editors: the text it keeps
about an element leaves out every field and editor inside it. A screenshot shows what
was on the screen, though, form fields included. Whenever Overmark takes a screenshot
(when you save marks, and when an AI app asks for one, see below), password fields are
blurred, and with "Blur form fields in screenshots" all form fields and text editors
are. This covers fields in the page itself and inside its web components, not fields
inside embedded frames (for example a payment form from another site).

## When data leaves your computer

Only in two cases, both started by you:

1. **Export.** "Export" writes a case to a zip file. Where it goes from there is up to
   you.
2. **An AI app.** If you connect an AI app (for example Claude) in the side panel,
   Overmark answers that app's tool calls: the cases' contents and screenshots, and the
   address (cut as above), title, element details and screenshots of the tab in front.
   They travel
   through the relay whose address you entered, and on to the AI app you paired with a
   code. The tab-mcp relay software forwards them without storing them; a relay that
   someone else runs is subject to its operator's practices. The AI app's provider
   handles the data under its own privacy policy.

   Changes the AI app wants to make (adding a mark, recording a verdict, deleting a
   case) are shown to you in the side panel first, every time, naming the case and the
   page; nothing changes until you allow it. The side panel shows the app's last call.

   Closing the side panel, or "Stop AI access" at the top of it, pauses the connection;
   it does not end the pairing. "Stop AI access" also turns "Keep AI access on" off. The
   paired AI app can use the tools again when the side panel connects again, which
   happens by itself while "Keep AI access on" is checked: when the side panel opens, and
   when the relay ended a session that was idle or too old. Disconnect, next to the app
   in the AI connection dialog, removes the app.

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
