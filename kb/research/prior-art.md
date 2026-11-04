---
type: research
title: "Prior art: annotation tools, standards and element matching"
description: >-
  Tools that annotate pages for coding agents (Vibe Annotations, Pointa, Agentation,
  pi-annotate, Scrawl), the W3C Web Annotation model, Hypothesis's text anchoring and
  Similo's similarity-based element matching, and what Overmark takes from each.
tags:
  - research
timestamp: 2026-11-04T17:00:00+01:00
---

# Prior art: annotation tools, standards and element matching

Researched 2026-11-04 while planning Overmark.

## Tools that annotate pages for coding agents

- **Vibe Annotations** (Chrome extension, PolyForm Shield 1.0.0, about 6000 users).
  Localhost and a few local domains are allowed at install; other sites can be switched
  on per site or for all sites through an optional permission. Annotations are keyed by
  their exact URL (`fetchAnnotations` filters `a.url === url`), so a case from prod never
  shows on localhost. An element is found by one CSS selector (test id, text, classes,
  then a structural `nth-of-type` path). On dev builds it reads React and Vue internals
  for the source file and line. Agents get annotations through a local npm server
  (MCP). No drawing. The licence forbids a competing product built on it, so Overmark
  uses none of its code. Rejected by the owner as too limited (2026-11-04).
- **Pointa** (Chrome extension, MIT): localhost, a local MCP server, annotations in
  `~/.pointa`; captures the selector, CSS, a source file reference and a screenshot.
- **Agentation**: an npm package installed into the app (so not on prod pages); Markdown
  output with selectors, source paths, the React component tree and computed styles.
- **pi-annotate**: the same idea for the Pi coding agent.
- **Scrawl** (desktop app, MIT): records the screen, voice and drawings and packs them
  into a bundle for agents (a contact sheet of keyframes, `summary.md`, a JSON manifest,
  single frames). Not tied to page elements; its bundle shape informed Overmark's export.
- **Marker.io, BugHerd, Usersnap, Punchlist, MarkUp.io, Jam**: annotated screenshots plus
  page metadata sent to trackers. The "capture and forward" part is a solved product
  category; none of them reloads a case onto another build.

None of the agent tools covers a PO annotating prod and a dev loading that case onto a
different build, which is Overmark's reason to exist.

## Standards

- **W3C Web Annotation Data Model** (Recommendation, 2017): an annotation is a body plus
  a target (source plus selectors). Selectors include `CssSelector`, `XPathSelector`,
  `TextQuoteSelector`, `TextPositionSelector`, `RangeSelector`, `FragmentSelector` and
  `SvgSelector`; several selectors on one target are alternatives, `refinedBy` narrows.
  It says what to store, not how to find an element again.
- **Text Fragments** (`#:~:text=`) carry a text quote in a URL; text only.

## Finding things again

- **Hypothesis** anchors text with `TextQuoteSelector` (exact text plus prefix and suffix)
  and ranks matches by quote, prefix and suffix similarity and distance from the
  expected position. A 2015 study (Aturban, Nelson, Weigle) found about 27% of its text
  annotations could no longer be attached to their live pages: losing some is normal,
  so a lost annotation must still make sense on its own.
- **Testing Library and Playwright** identify elements by role and accessible name,
  label, text and test id, and avoid classes and DOM structure.
- **Similo** (Nass, Alégroth, Feldt, Leotta, Ricca; ACM TOSEM 2023) stores many
  attributes per element and scores candidates on the new version by weighted
  similarity; it failed far less often than single locators on popular sites, at about
  4 ms per element. Overmark's matching follows it.

# Citations

- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)
- [Hypothesis anchoring discussion](https://github.com/hypothesis/product-backlog/issues/1022)
- [Quantifying orphaned annotations in Hypothes.is](https://de.slideshare.net/maturban/quantifying-orphaned-annotations-in-hypothes)
- [Similo (arXiv 2208.00677)](https://arxiv.org/abs/2208.00677)
- [Vibe Annotations](https://github.com/RaphaelRegnier/vibe-annotations)
- [Pointa](https://dev.to/julien_berthomier_33cb099/i-built-a-chrome-extension-that-lets-you-annotate-localhost-and-have-ai-fix-everything-309m)
- [Agentation](https://www.agentation.com/)
- [pi-annotate](https://pi.dev/packages/pi-annotate)
- [Scrawl](https://github.com/kitlangton/scrawl)
- [Punchlist](https://punchlist.com/doc/markup-tool/)
