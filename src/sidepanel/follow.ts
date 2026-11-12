/**
 * The open case's marks follow it to the tab in front (DEC-022): what the
 * panel does when a case opens, another tab comes to the front, or the tab in
 * front loads; and whether what the draw found says the case is for another
 * page. Pure: main.ts carries the steps out.
 */

import type { AnnotationMatch } from "../lib/messages.ts";

/** Where the panel's own marks of a case are drawn. */
export interface Drawn {
	tabId: number;
	caseId: string;
}

export interface FollowInput {
	/** The case open in the panel, once read. */
	caseId: string | undefined;
	/**
	 * The tab in front; `url` is empty where Chrome hides it (Overmark may not
	 * run there yet), `loading` while it loads.
	 */
	tab: { id: number; url: string; loading: boolean } | undefined;
	/** Where the panel drew marks last, and they may still be. */
	drawn: Drawn | undefined;
	/** The case whose marks the page in front shows (the page says so). */
	pageCase: string | undefined;
	/** Tabs the user took the open case's marks off ("Hide marks on this tab"). */
	hidden: ReadonlySet<number>;
	/**
	 * The page in front has just loaded (or navigated): what was drawn on it
	 * before went with the old page.
	 */
	reloaded: boolean;
}

export interface FollowStep {
	/** Take these marks off first: they are on a tab no longer in front. */
	clear: Drawn | undefined;
	/**
	 * `draw`: find the case's marks on the tab in front and draw them;
	 * `wait`: Overmark may not run there, the icon's click or "Allow on all
	 * sites" lets it (the panel says so); `none`: leave the tab as it is.
	 */
	action: "draw" | "wait" | "none";
}

/** Pages a content script can run on, given access. */
export function canDrawOn(url: string): boolean {
	try {
		const { protocol } = new URL(url);
		return (
			protocol === "https:" || protocol === "http:" || protocol === "file:"
		);
	} catch {
		return false;
	}
}

/** What to do for the open case and the tab in front. */
export function followStep(input: FollowInput): FollowStep {
	const { caseId, tab, drawn } = input;
	const action = nextAction(input);
	// A draw on the same tab replaces what is there; marks anywhere else go.
	const clear =
		drawn !== undefined &&
		(drawn.tabId !== tab?.id || (drawn.caseId !== caseId && action !== "draw"))
			? drawn
			: undefined;
	return { clear, action };
}

function nextAction({
	caseId,
	tab,
	drawn,
	pageCase,
	hidden,
	reloaded,
}: FollowInput): FollowStep["action"] {
	// No case open: the panel draws nothing.
	if (caseId === undefined || tab === undefined) return "none";
	if (hidden.has(tab.id)) return "none";
	// A tab that is still loading is drawn on once it has.
	if (tab.loading) return "none";
	if (tab.url === "") return "wait";
	if (!canDrawOn(tab.url)) return "none";
	if (!reloaded) {
		// There already: a draw again would drop the candidates chosen.
		if (drawn?.tabId === tab.id && drawn.caseId === caseId) return "none";
		// An AI app's load_case drew it there.
		if (pageCase === caseId) return "none";
	}
	return "draw";
}

/** A match that has its element on the page, sure or not. */
export const isFound = (m: AnnotationMatch): boolean =>
	m.status !== "lost" && m.status !== "no-element";

/**
 * None of the case's marks was found on the page: at least one mark recorded
 * an element, and none of those is there. Resolved marks count as any other.
 * A case of marks without elements (boxes, arrows on nothing) says nothing
 * about the page.
 */
export function noneFound(matches: readonly AnnotationMatch[]): boolean {
	const withElement = matches.filter((m) => m.status !== "no-element");
	return withElement.length > 0 && !withElement.some(isFound);
}
