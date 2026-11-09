# Log

## 2026-11-04

- Planned with the owner: design, prior art, DEC-001 to DEC-007, iterations 1 to 5, open questions; repository `ractive/overmark` created
- Iterations 1 to 4 built and reviewed (claude + glm through background forks), every finding fixed; PRs #1 to #4 stacked, CI green; DEC-008 (every AI change confirmed each time). Iteration 5 in part (PR #5): PRIVACY.md, store listing, release workflow. Merges wait for the owner. tab-mcp iteration 17 (relay accepts `chrome-extension://` origins) is tab-mcp PR #72
- Second review of the review-fix commits (claude 22 findings, glm 7; 26 distinct, all fixed): typed text left out of element details, one counted blur per page that reaches shadow roots, saves and AI screenshots no longer interfere, size budgets for list_cases and load_case, abandoned pending screenshots swept; PR #7. tab-mcp #72: only real extension ids are worded as extensions
- Full review of the whole codebase (four Claude reviewers by area, GLM over everything): 70 findings, 57 distinct, 5 high. DEC-012: a mark's screenshot is taken when it is drawn. Fixed in PR #9. The machine was killed during the fixes; all work was recovered from the worktrees

## 2026-11-09

- Owner feedback: adding marks to a case needed "Save…" and then "Add to case" or "Back". DEC-014: marks for a case go into it as each is done, Undo takes the last one out again, failures stay on the page with "Add mark N"; the new-case save keeps its title, its form says "Keep drawing" instead of "Back"
- The owner asked for the AI connection to stay while the side panel is closed. DEC-015, iteration 8: the connection in the service worker, the panel a view with a plain pairing view (the tab-mcp extension's AI access UI replaces it later), questions in the panel or a Chrome notification, the panel's address kept
- DEC-016, iteration 9: the AI settings and the address secret move from chrome.storage.local into the worker's own IndexedDB (what an unreleased build kept there is deleted, never taken over; the panel's localStorage handover stays, in one transaction), the side panel changes them only over its port, setAccessLevel is best effort and Chrome 116 the minimum again; ported from the tab-mcp extension's PR 89
