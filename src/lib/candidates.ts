/**
 * Looking for a stored element on a page and in its shadow roots: first among
 * the elements likely to be it (same test id, id, role or tag), then, when none
 * is even probable, in the whole page while the search has time left. Shared by
 * loading a case (content/review.ts) and the matching measurement
 * (test/e2e/pilot.ts).
 */

import type { ElementDetails } from "./case.ts";
import {
	createContext,
	type DescribeContext,
	describeElement,
	escapeCss,
	LIMITS,
	TEST_ID_ATTRIBUTES,
	withinLimits,
} from "./element.ts";
import {
	classify,
	isFound,
	type MatchStatus,
	PROBABLE,
	type Ranked,
	rank,
	TIE,
} from "./match.ts";
import { shadowTrees } from "./shadow.ts";

/** More candidates than this are not scored for one element. */
export const MAX_CANDIDATES = 8000;
/** After this long, elements are not searched for in the whole page. */
export const FULL_SCAN_BUDGET_MS = 4000;

/** One page, searched for several stored elements. */
export interface PageSearch {
	readonly doc: Document;
	readonly context: DescribeContext;
	/** Element details without the (slow) selector, remembered per element. */
	describe(el: Element): ElementDetails;
	/** Elements the search may return (not Overmark's own). */
	own(el: Element): boolean;
	/** The page's body and every shadow root, collected once. */
	trees(): ParentNode[];
	/** The whole page's elements, collected once. */
	all(): { elements: Element[]; truncated: boolean };
	/** Whole-page scans stop after this moment (`performance.now()`). */
	readonly deadline: number;
}

export function createSearch(
	doc: Document,
	options: { exclude?: Element; budgetMs?: number } = {},
): PageSearch {
	const context = createContext(doc);
	const cache = new Map<Element, ElementDetails>();
	const exclude = options.exclude;
	const own = (e: Element) =>
		exclude === undefined || (e !== exclude && !exclude.contains(e));
	let everything: { elements: Element[]; truncated: boolean } | undefined;
	let collected: ParentNode[] | undefined;
	const trees = () => {
		collected ??= shadowTrees(doc.body, exclude);
		return collected;
	};
	return {
		doc,
		context,
		describe(el) {
			let d = cache.get(el);
			if (d === undefined) {
				d = describeElement(el, context, { selector: false });
				cache.set(el, d);
			}
			return d;
		},
		own,
		trees,
		all() {
			if (everything === undefined) {
				const list = trees()
					.flatMap((tree) => [...tree.querySelectorAll("*")])
					.filter(own);
				everything = {
					elements: list.slice(0, MAX_CANDIDATES),
					truncated: list.length > MAX_CANDIDATES,
				};
			}
			return everything;
		},
		deadline:
			(globalThis.performance?.now() ?? Date.now()) +
			(options.budgetMs ?? FULL_SCAN_BUDGET_MS),
	};
}

function quote(value: string): string {
	return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

/**
 * Elements likely to be the stored one, strongest reason first (the cut to
 * `MAX_CANDIDATES` keeps the start): same test id, id, role, then tag.
 */
function likely(search: PageSearch, stored: ElementDetails): Element[] {
	const found = new Set<Element>();
	const add = (selector: string) => {
		try {
			for (const tree of search.trees())
				for (const e of tree.querySelectorAll(selector)) found.add(e);
		} catch {
			// An odd value that is no valid selector.
		}
	};
	if (stored.testId) {
		// A value at the limit was cut: the page's own may go on.
		const equal = stored.testId.length < LIMITS.testId ? "=" : "^=";
		for (const name of TEST_ID_ATTRIBUTES)
			add(`[${name}${equal}${quote(stored.testId)}]`);
	}
	if (stored.id) add(`[id=${quote(stored.id)}]`);
	if (stored.role) add(`[role=${quote(stored.role)}]`);
	add(escapeCss(stored.tag));
	return [...found];
}

export interface Candidate {
	element: Element;
	score: number;
	/** Sure enough to be drawn as found (match.ts `isFound`). */
	found: boolean;
}

export interface Found {
	status: MatchStatus;
	/** The best score (0 when nothing was scored). */
	score: number;
	/** The candidates worth showing, best first; none for `lost`. */
	candidates: Candidate[];
	/** Not every element of the page was scored. */
	truncated: boolean;
}

/** Rendered with a size: not `display: none`, not collapsed to nothing. */
function isVisible(el: Element): boolean {
	const r = el.getBoundingClientRect();
	return r.width > 0 && r.height > 0;
}

export function findCandidates(
	search: PageSearch,
	details: ElementDetails,
): Found {
	const stored = withinLimits(details);
	let elements = likely(search, stored).filter(search.own);
	let truncated = elements.length > MAX_CANDIDATES;
	elements = elements.slice(0, MAX_CANDIDATES);
	let ranked = rank(stored, elements.map(search.describe));
	if ((ranked[0]?.score ?? 0) < PROBABLE) {
		// The tag or role may have changed: score the whole page, while there is time.
		const now = globalThis.performance?.now() ?? Date.now();
		if (now < search.deadline) {
			({ elements, truncated } = search.all());
			ranked = rank(stored, elements.map(search.describe));
		} else {
			truncated = true;
		}
	}
	let status = classify(ranked);
	if (status === "ambiguous") {
		// A layout often keeps a hidden copy (desktop and mobile versions of the
		// same block): of tied candidates, the one the user can see wins.
		const best = ranked[0]?.score ?? 0;
		const tied = ranked.filter((r) => best - r.score < TIE);
		const visible = tied.filter((r) => isVisible(elements[r.index] as Element));
		if (visible.length === 1) {
			const winner = visible[0] as Ranked;
			ranked = [winner, ...ranked.filter((r) => r !== winner)];
			status = isFound(winner) ? "found" : "probable";
		}
	}
	const kept =
		status === "lost"
			? []
			: ranked.filter((r, i) => i === 0 || r.score >= PROBABLE);
	return {
		status,
		score: ranked[0]?.score ?? 0,
		candidates: kept.map((r) => ({
			element: elements[r.index] as Element,
			score: r.score,
			found: isFound(r),
		})),
		truncated,
	};
}
