# Index

<!-- okf:index:begin -->

## iteration

* [Iteration 1: skeleton](iteration-1-skeleton.md) - The repository's tooling, a build that produces the unpacked extension with a fixed ID, the service worker that opens the side panel and injects the content script on a click, icons, CI, and an end-to-end harness that loads the extension into Chromium.
* [Iteration 2: annotate and save](iteration-2-annotate.md) - Drawing tools on the page (element, box, arrow, pen, note) with a comment each, element details, and saving a named case with annotated screenshots and crops into IndexedDB; the side panel lists and shows cases.
* [Iteration 3: export, import and loading onto another build](iteration-3-reload.md) - Export a case as a zip with case.json, case.md and WebP images; import it; load a case onto the tab in front, find each annotation's element by a weighted similarity score, and highlight it with its confidence.
* [Iteration 4: AI apps through tab-mcp](iteration-4-mcp.md) - TabMcp in the side panel with a relay setting and the connect dialog, and the tools list_cases, get_case, get_image, load_case, highlight, capture, add_annotation, set_verdict and delete_case.
* [Iteration 5: pilot and store](iteration-5-pilot.md) - A first pilot with a PO and a dev on real Acme pages, measuring how often elements are found; the privacy policy and the store listing; the extension unlisted in the Chrome Web Store and the store's key in the manifest.
* [Iteration 6: trial on dev pages and the refactor](iteration-6-trial-refactor.md) - Overmark on real Acme dev pages (matching measured, a scale bug found and fixed), then three refactors the reviews asked for: an allow-list of recorded details, one state machine per page, and a side panel drawn from one state.

<!-- okf:index:end -->
