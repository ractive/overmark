# Overmark privacy policy

Overmark is a browser extension for annotating web pages. It has no server, no
account and no analytics. Its author receives nothing from it.

## What Overmark keeps, and where

When you save marks as a case, Overmark stores in your browser, on your computer
(IndexedDB of the extension):

- the case's title, your comments and the verdict;
- the page's address and title, the window size and the browser's user agent;
- for each marked element: its tag, role, accessible name, up to 200 characters of its
  text, the readable part of its CSS classes, a few attributes (`name`, `type`, link
  path, image file name, `placeholder`, `alt`, `title`), the heading above it, its
  landmark, its position and a CSS selector;
- screenshots of the visible part of the tab, with the marks on them, and a crop per
  mark.

Overmark never reads what is typed into form fields or text editors. A screenshot shows
what was on the screen, though, form fields included. "Blur form fields in screenshots"
in the side panel blurs them while a screenshot is taken; password fields are always
blurred.

## When data leaves your computer

Only in two cases, both started by you:

1. **Export.** "Export" writes a case to a zip file. Where it goes from there is up to
   you.
2. **An AI app.** If you connect an AI app (for example Claude) in the side panel,
   Overmark answers that app's tool calls: case contents, screenshots, and details and
   screenshots of the tab in front. They travel through the tab-mcp relay whose address
   you entered, and on to the AI app you paired with a code. A tab-mcp relay forwards
   them without storing them. The AI app's provider handles them under its own privacy
   policy. Changes the AI app wants to make (adding a mark, recording a verdict,
   deleting a case) are shown to you first. Closing the side panel or clicking
   Disconnect ends the connection.

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
