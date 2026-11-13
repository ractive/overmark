# Overmark privacy policy

Overmark is a browser extension for annotating web pages. It has no account and no
analytics. Its author receives nothing from it, except what passes through the hosted
relay when you connect an AI app through it (see "An AI app" below).

## What Overmark keeps, and where

When you save marks as a case, or add marks to a case, Overmark stores in your browser, on your computer
(IndexedDB of the extension):

- the case's title, your comments, the summary for the developer, when the case and its
  screenshots were made and changed, and for an imported case when it was imported;
- the findings a connected AI app wrote on a mark: their text, when they were written
  and changed, and the app's id, name and host as the relay gave them;
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

Overmark also keeps its settings in a database of its own in the browser (IndexedDB in
the extension's origin), which only its background service worker uses; the scripts
Overmark runs in web pages cannot reach it: the relay address, "Blur form fields in
screenshots", "Keep AI access on", and the secret from which the tab-mcp library derives
the address an AI app connects to. Whether AI access is on until the browser closes (or
the extension is updated, reloaded or turned off) is in the browser's session storage,
which those scripts cannot reach either.
(Earlier builds of Overmark kept them in the side panel's own local storage; the first time
the side panel opens after the update it hands them over and deletes its copy. Where an
unreleased build kept them in the extension's local storage, Overmark deletes them.)

Overmark does not record what is typed into form fields and editable regions: the text
it keeps about an element leaves them out. Of the editors that draw their text as
ordinary page content, it recognises only Monaco, CodeMirror 5 and Ace; to Overmark the
text of any other such editor is page text, and it is kept when you mark it (and sent
when an AI app reads that element). A
screenshot shows what was on the screen, though, form fields included. Whenever Overmark
takes a screenshot (when you draw a mark, and when an AI app asks for one, see below),
password fields are blurred, and with "Blur form fields in screenshots" all form fields
and text editors are. This covers fields in the page itself and inside its web
components, not fields inside embedded frames (for example a payment form from another
site).

If you turn on the sync ("Sync to Downloads" or "Choose a folder…"), Overmark also keeps
where it syncs to (Downloads, or that folder's handle: Chrome's reference to the folder
you picked, with its name), which file it wrote for each case and when, the sync's last
status and, for Downloads, the id of the newest entry it left in Chrome's download list,
in another database of its own in the browser (IndexedDB in the extension's origin,
`overmark-sync`). The scripts Overmark runs in web pages cannot reach it.

## When data leaves your computer

Only in three cases, all started by you:

1. **Export.** "Export" writes a case to a zip file, "Export all cases" every case to
   one. Where it goes from there is up to you.
2. **Sync.** If you choose "Sync to Downloads", Overmark writes each case into a folder
   `Overmark` in Chrome's downloads folder; if you choose a folder with "Choose a
   folder…", into that folder. Each case is the same zip file Export writes (its marks,
   comments, AI findings, summary, screenshots and `case.md`), written again whenever
   the case changes, and nowhere else. It writes only there, only files named after its
   cases, and never reads the files there. A deleted case's file stays; "Stop syncing"
   stops the writing and leaves the files. To Downloads it writes through Chrome's
   downloads (the optional `downloads` permission, asked when you click "Sync to
   Downloads"), with the side panel closed too; each file is built in an offscreen
   document of the extension (the `offscreen` permission), which only makes the file's
   address for the download and sends nothing anywhere. If the folder is synced by a
   cloud service (iCloud Drive, Dropbox, OneDrive), that service uploads the files under
   its own privacy policy: that is your choice of folder, not something Overmark sends.
3. **An AI app.** If you connect an AI app (for example Claude) in the side panel,
   Overmark answers that app's tool calls: the cases' contents and screenshots, and the
   address (cut as above), title, element details and screenshots of the tab in front.
   When the app asks about a mark's element, Overmark also reads that element from the
   page in front and sends it without storing it. Instead of the element, the app can
   name (by a CSS selector) one of the elements around it or inside it; for a mark not
   drawn on an element (a box, an arrow, a pen mark or a note), any element of the
   case's page, and only while the tab in front shows that page. What is sent: up to
   about 16 KB of the element's HTML with the page's text, its position and size, the
   window's size, a list of its computed styles, up to 30 of the page's CSS rules that
   apply to it, and the tag, id, classes, position and layout styles of up to four
   elements around it and twelve inside it (with up to 80 characters of each one's
   text). Hidden elements (`display: none`, `visibility: hidden`) are left out. That HTML
   holds no form field values: form fields keep only attributes such as their name,
   type and placeholder, and what is inside text areas, selects and editable regions is
   left out. Addresses in it, wherever they appear in attributes and in CSS, lose their
   query string, fragment, user name and password; of a mail, phone or other address
   that is not a web address only its kind stays (`mailto:`). The page's head (with its
   meta tags), comments, the content of scripts, styles and embedded documents, and the
   values of attributes named like a token or secret are never sent. The HTML and the
   CSS rules never carry what was typed or chosen; the computed styles and the position
   of an element can reflect a field's state where the page's own CSS styles it by state
   (a ticked checkbox's colour, an autofilled field's background), as a screenshot does.
   They travel
   through a tab-mcp relay and on to the AI app you paired with a code. Unless you enter
   another relay in the side panel, that is `tab-mcp.ractive.ch`, run by Overmark's
   developer: it forwards the data without storing it or writing it to its logs, and
   stores for each pairing only the AI app's id and name and hashes of its tokens
   ([its privacy statement](https://ractive.ch/tab-mcp/privacy/)). A relay that someone
   else runs is subject to its operator's practices. The AI app's provider handles the
   data under its own privacy policy.

   The connection is held by Overmark's background service worker, so it stays while the
   side panel is closed; the Overmark icon shows "on" while it is up. Changes the AI app
   wants to make (adding a mark, recording the summary for the developer, changing a
   mark's status, adding, changing or deleting one of its findings, deleting a case) are asked first, naming the case and the page: in the side panel when it is
   open in the window in front, otherwise also in a notification of your system (with
   Allow and Always allow, closing it is Don't allow; the icon shows "?" meanwhile).
   Nothing changes until you allow it; no answer within 60 seconds is Don't allow. If
   you choose "Always allow" for a tool, or turn on "Allow all changes" for an app in
   the side panel, that app's calls of it run without asking until you disconnect the
   app; Overmark keeps which, by the app's pairing, in its own database on your
   computer, and forgets it with the pairing. The side panel shows the app's last call.

   "Stop AI access" at the top of the side panel, or the AI access switch, pauses the connection; it does not end
   the pairing, and it turns "Keep AI access on" off. Without "Keep AI access on" the
   connection also ends when the relay ends a session that was idle or too old, when
   the browser closes, and when Overmark is updated, reloaded or turned off. With it,
   Overmark connects again by itself after all of these: when the browser starts, after
   an update or reload, and when the relay ended such a session. Disconnect, next to the app in the
   side panel's AI connection view, removes the app.

Overmark itself sends nothing else. It does work inside the page you annotate, though, so
that page's own scripts can see what Overmark shows there and the keys you press there,
such as a comment while you type it. What they do with that is up to the site.

Overmark does not sell data, use it for advertising, or pass it to anyone else.

## Permissions

- **activeTab:** Overmark runs on a tab only after you click its icon there (or press
  its shortcut), and only until that tab navigates elsewhere.
- **scripting:** to add its toolbar and outlines to that tab.
- **sidePanel:** for its side panel.
- **storage:** for the browser's session storage, which forgets everything when the
  browser closes: Overmark notes there which marks the toolbar on a tab just added (case,
  mark, screenshot and comment), so that the toolbar's Undo can take back those marks
  and no others, and whether AI access is on. Overmark keeps nothing in the extension's
  local storage any more: it only deletes what an unreleased build kept there.
- **alarms:** while AI access is on, Overmark's background service worker wakes once a
  minute, so the connection to the AI app comes back after the computer slept.
- **notifications:** to ask whether the AI app may make a change when the side panel is
  not open in front (see "An AI app" above). Chrome mentions it when installing
  ("Display notifications").
- **unlimitedStorage:** so that the browser does not delete your cases and screenshots to
  free disk space, and they may grow beyond its usual limit. They stay in your browser.
- **offscreen:** while the sync writes your cases to Downloads, Overmark's background
  service worker opens a hidden page of the extension that builds one case's file and
  gives it an address for the download (a service worker cannot); it closes once the
  cases are written. No install warning.
- **Downloads (optional):** asked for at the first Export (or Export all cases), or when
  you click "Sync to Downloads"; Chrome calls it "Manage your downloads". Overmark uses
  it only to save its own export through Chrome's downloads and then read that one
  download's path, to show you where the file went (with Copy and Show in folder), and
  for the sync to write each case to `Overmark` in your downloads folder, overwriting
  that case's earlier file, and to take its own previous entry out of Chrome's download
  list (the file stays). It does not read, change or open your other downloads. With a
  no, the export is saved as before, without the path, the sync to Downloads does not
  start, and Chrome asks again only when you click again. "Stop syncing" gives it back
  when the sync went to Downloads; Export or "Sync to Downloads" asks for it again.
- **Single sites (optional):** when you open a case's page from its address, or show a
  case's marks on a tab where Overmark may not run yet ("Show marks on this tab" or the
  case's Load button), Chrome asks whether Overmark may run on that case's site from
  then on. Only a yes allows it; you can take it back in Chrome's extension settings.
  After a no, Overmark does not ask for that site again until the side panel reopens.
- **All sites (optional, off by default):** only if you choose "allow on all sites", so
  that Overmark works on a tab without clicking its icon first.

## Deleting

Delete a case in the side panel; its screenshots go with it. Removing the extension
deletes everything it stored in the browser. Files it wrote (an export, the synced
files in Downloads or your folder) stay where they are until you delete them.

## Contact

Jean-Pierre Bergamin, <https://ractive.ch>, james@ractive.ch.
Source code: <https://github.com/ractive/overmark>.
