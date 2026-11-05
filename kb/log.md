# Log

## 2026-11-04

- Planned with the owner: design, prior art, DEC-001 to DEC-007, iterations 1 to 5, open questions; repository `ractive/overmark` created
- Iterations 1 to 4 built and reviewed (claude + glm through background forks), every finding fixed; PRs #1 to #4 stacked, CI green; DEC-008 (every AI change confirmed each time). Iteration 5 in part (PR #5): PRIVACY.md, store listing, release workflow. Merges wait for the owner. tab-mcp iteration 17 (relay accepts `chrome-extension://` origins) is tab-mcp PR #72
- Second review of the review-fix commits (claude 22 findings, glm 7; 26 distinct, all fixed): typed text left out of element details, one counted blur per page that reaches shadow roots, saves and AI screenshots no longer interfere, size budgets for list_cases and load_case, abandoned pending screenshots swept; PR #7. tab-mcp #72: only real extension ids are worded as extensions
- Full review of the whole codebase (four Claude reviewers by area, GLM over everything): 70 findings, 57 distinct, 5 high. DEC-012: a mark's screenshot is taken when it is drawn. Fixed in PR #9. The machine was killed during the fixes; all work was recovered from the worktrees
