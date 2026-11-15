/**
 * Injected into a page by `pilot.ts`: Sitegloss's element details and
 * matching, the same code the extension runs, as a global for the measurement.
 */

import { createSearch, findCandidates } from "../../src/lib/candidates.ts";
import { createContext, describeElement } from "../../src/lib/element.ts";
import { classify, rank } from "../../src/lib/match.ts";

declare global {
	var __siteglossPilot: unknown;
}

globalThis.__siteglossPilot = {
	createContext,
	createSearch,
	describeElement,
	findCandidates,
	classify,
	rank,
};
