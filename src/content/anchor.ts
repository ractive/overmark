/**
 * Which page element a mark is about: the element under a point, or for a
 * box or a freehand mark, the element whose box overlaps it best.
 */

import type { Rect } from "../lib/case.ts";
import { shadowOf } from "../lib/shadow.ts";

const IGNORED = new Set(["html", "body"]);

/**
 * The elements at a point of one tree, each shadow root's before its host. A
 * document only reports the host; a root also repeats the elements around it.
 */
function hitsIn(
	root: Document | ShadowRoot,
	x: number,
	y: number,
	host: Element,
	seen: Set<Element>,
): Element[] {
	const hits = root.elementsFromPoint(x, y).filter((e) => !seen.has(e));
	for (const e of hits) seen.add(e);
	return hits.flatMap((e) => {
		const inner = e === host ? null : shadowOf(e);
		return inner === null ? [e] : [...hitsIn(inner, x, y, host, seen), e];
	});
}

/** Page elements at a point of the window, deepest first, without Overmark's own. */
export function pageElementsAt(
	x: number,
	y: number,
	host: Element,
	doc: Document = document,
): Element[] {
	return hitsIn(doc, x, y, host, new Set()).filter(
		(e) => e !== host && !host.contains(e) && !IGNORED.has(e.localName),
	);
}

export function elementAt(
	x: number,
	y: number,
	host: Element,
	doc: Document = document,
): Element | null {
	return pageElementsAt(x, y, host, doc)[0] ?? null;
}

/** Intersection over union of two rectangles (0 to 1). */
export function overlap(a: Rect, b: Rect): number {
	const x = Math.max(
		0,
		Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
	);
	const y = Math.max(
		0,
		Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
	);
	const inter = x * y;
	const union = a.width * a.height + b.width * b.height - inter;
	return union <= 0 ? 0 : inter / union;
}

/** The element a box (in window coordinates) is drawn around. */
export function elementForRect(
	rect: Rect,
	host: Element,
	doc: Document = document,
): Element | null {
	const points = [
		[0.5, 0.5],
		[0.25, 0.25],
		[0.75, 0.25],
		[0.25, 0.75],
		[0.75, 0.75],
	] as const;
	const candidates = new Set<Element>();
	for (const [fx, fy] of points) {
		for (const e of pageElementsAt(
			rect.x + rect.width * fx,
			rect.y + rect.height * fy,
			host,
			doc,
		))
			candidates.add(e);
	}
	let best: Element | null = null;
	let bestScore = 0.05;
	for (const e of candidates) {
		const score = overlap(rect, e.getBoundingClientRect());
		if (score > bestScore) {
			best = e;
			bestScore = score;
		}
	}
	return (
		best ??
		elementAt(rect.x + rect.width / 2, rect.y + rect.height / 2, host, doc)
	);
}
