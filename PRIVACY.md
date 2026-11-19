# Sitegloss privacy policy

Sitegloss is a browser extension for annotating web pages, for Chrome, Edge and
Firefox. It works without an account and has no analytics. What it keeps stays in your
browser, unless you export it, sync it, connect an AI app or sign in to sitegloss.dev
to share your cases with a team. Its author receives nothing from it, except what
passes through the hosted relay when you connect an AI app through it, and what you
send to sitegloss.dev when you sign in there.

## What Sitegloss keeps, and where

Sitegloss stores in your browser, on your computer:

- the case's title, your comments, the summary for the developer, a link you attach,
  and a connected AI app's findings;
- the address, title and language of each page you mark, the window size, and the
  browser's user agent. An address is kept without its query string or fragment (only a
  fragment that is a route of the page stays);
- for each marked element: its tag, role, name, a short piece of its text, a few
  attributes, its position, and a CSS selector;
- screenshots of the visible part of the tab, with the marks on them;
- its settings, and where it syncs to;
- if you sign in to sitegloss.dev: your name and e-mail address there, your teams, the
  tokens that keep you signed in, and what the service last had of each case.

The exact fields are defined in the source code ([`src/lib/`](src/lib/)).

## When data leaves your computer

Only in four cases, all started by you:

1. **Export.** Export writes a case, or every case, to a zip file. Where it goes from
   there is up to you.
2. **Sync.** If you turn on the sync, Sitegloss writes each case as the same zip file to
   the browser's downloads folder, or in Chrome and Edge to a folder you choose (in
   Firefox, a subfolder of Downloads). If a cloud service syncs that
   folder, it uploads the files under its own privacy policy.
3. **An AI app.** If you connect an AI app (for example Claude), it can read your cases
   and their screenshots, and the address (cut as above), title, element details and
   screenshots of the tab in front. For a mark, it can also read the HTML and CSS of
   the marked element, or of another element it names on that page, without form field
   values.

   This travels through a tab-mcp relay to the AI app. Unless you enter another relay,
   that is `tab-mcp.ractive.ch`, run by Sitegloss's developer, which forwards the data
   without storing it ([its privacy statement](https://ractive.ch/tab-mcp/privacy/)).
   The AI app's provider handles it under its own privacy policy.

   Changes the AI app wants to make are asked first, unless you chose "Always allow".

   In Firefox, the browser first asks, at the click that turns AI access on, for its own
   data collection consent for website content and browsing activity. Without it AI
   access does not start, and it ends when you take the consent back in Firefox's add-on
   settings. Nothing is required at install.

4. **A team at sitegloss.dev.** If you sign in ("Sign in" in the side panel's Account
   section), Sitegloss sends your cases to the service at `app.sitegloss.dev`, run by
   Sitegloss's developer, and fetches your team's: titles, links, summaries, the
   addresses, titles and languages of the pages, the window size and the browser's user
   agent, the marks with their comments, statuses, notes, element details and AI
   findings, and the screenshots and crops. The members of the team you choose can see
   and change them, in the extension and on the website; the service keeps them until
   they are deleted, with who made or changed what, and under
   [its own privacy policy](https://sitegloss.dev/privacy/).

   Cases that were in your browser before you signed in are sent only when you say so
   ("Sync them"); "Keep them on this device" leaves them where they are. Cases you make
   while signed in go to the team once they have a mark. Deleting a case that the team
   has deletes it for the team. "Sign out" stops this: the cases stay in your browser,
   the team keeps its copies, and the tokens are deleted.

   You sign in on the service's own page, in a window of the browser: Sitegloss never
   sees your password. If you enter another server's address, all of this goes to that
   server instead.

   In Firefox, the browser asks at "Sign in" for the same data collection consent as for
   an AI app (website content and browsing activity); taking it back signs you out.

Sitegloss itself sends nothing else. It does not sell data, use it for advertising or
for anything but annotating pages and reviewing the annotations, or use it to determine
creditworthiness.

## Limits

- A screenshot shows what was on the screen, form fields included. Password fields are
  always blurred, all form fields only with "Blur form fields in screenshots", and
  fields inside embedded frames (a payment form, for example) never.
- Sitegloss does not record what is typed into form fields and editable regions. An
  editor that draws its text as ordinary page content counts as page text, unless
  Sitegloss recognises it.
- The page's own scripts can see what Sitegloss shows in the page and the keys you
  press there, such as a comment while you type it.

## Permissions

- **activeTab:** to run on the tab where you click the Sitegloss icon, until that tab
  navigates elsewhere.
- **scripting:** to add its toolbar and outlines to that tab.
- **sidePanel:** for its side panel (Chrome and Edge; Firefox has a sidebar instead).
- **storage:** session storage, forgotten when the browser closes: what Undo can take
  back, and whether AI access is on.
- **alarms:** so the AI app's connection comes back after the computer slept, and, if
  you are signed in to sitegloss.dev, to look for your team's changes every few minutes.
- **identity:** for the browser's own sign-in window when you sign in to sitegloss.dev.
  Sitegloss does not read your browser's or your Google account's identity with it.
- **notifications:** to ask whether the AI app may make a change when the side panel
  is not in front.
- **unlimitedStorage:** so the browser does not delete your cases to free disk space.
- **offscreen:** to make the files for the sync to Downloads (Chrome and Edge; Firefox's
  background page makes them itself).
- **Downloads (optional):** to save exports and synced files. It does not read, change
  or open your other downloads.
- **Single sites (optional):** asked when you open a case's page, so Sitegloss may run
  on that site.
- **All sites (optional):** so Sitegloss works on a tab without clicking its icon
  first.

## Deleting

Delete a case in the side panel; its screenshots go with it. Removing the extension
deletes everything it stored in the browser. Files it wrote (exports, synced files)
stay until you delete them. A case your team has at sitegloss.dev is deleted there too
when you delete it while signed in; what is at the service otherwise stays until it is
deleted there.

## Contact

Jean-Pierre Bergamin, <https://ractive.ch>, james@ractive.ch.
Source code: <https://github.com/ractive/sitegloss>.

Last changed: 19 November 2026.
