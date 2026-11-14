/**
 * A page asks about a mark of the case drawn on it (DEC-027): which panel
 * answers, and for which mark. Pure, so the rule can be tested.
 */

import type { Annotation, Case } from "../lib/case.ts";
import type { MarkRequest } from "../lib/messages.ts";

export interface Showing {
	/** The case open in this panel, if its view is the case's. */
	open: Case | undefined;
	/** Where this panel drew a case's marks itself. */
	loaded: { caseId: string; tabId: number } | undefined;
}

/**
 * The mark a page's request is about. `undefined`: not this panel's to answer
 * (the request is not from a tab, or not from the tab this panel drew its
 * open case on): a page reaches no other case, and no case the user did not
 * put on it. `"gone"`: this panel's, but the case has no such mark any more.
 */
export function markAsked(
	showing: Showing,
	request: Pick<MarkRequest, "caseId" | "annotationId">,
	tabId: number | undefined,
): Annotation | "gone" | undefined {
	const { open, loaded } = showing;
	if (
		tabId === undefined ||
		open === undefined ||
		open.id !== request.caseId ||
		loaded === undefined ||
		loaded.caseId !== open.id ||
		loaded.tabId !== tabId
	)
		return undefined;
	return open.annotations.find((a) => a.id === request.annotationId) ?? "gone";
}
