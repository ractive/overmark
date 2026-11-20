/**
 * Which page element a mark is about: the element under a point, or for a
 * box or a freehand mark, the element whose box overlaps it best; for a
 * drawn mark, the element that means something there rather than a piece of
 * it (DEC-047).
 */

import type { Rect } from "../lib/case.ts";
import { readableClasses } from "../lib/classes.ts";
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

/** Page elements at a point of the window, deepest first, without Sitegloss's own. */
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
	const found =
		best ??
		elementAt(rect.x + rect.width / 2, rect.y + rect.height / 2, host, doc);
	// The picture, not a path of it; the button, not its label (DEC-047).
	return found === null ? null : usefulElement(found);
}

/** What can be clicked or chosen: a mark on a piece of it is about all of it. */
const INTERACTIVE =
	"a[href], button, label, summary, select, textarea, input, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=option], [role=switch]";
/** Text formatting: a word in bold is part of the text it is in. */
const FORMATTING = new Set([
	"span",
	"strong",
	"em",
	"b",
	"i",
	"small",
	"sub",
	"sup",
	"mark",
	"abbr",
	"s",
	"u",
	"font",
]);

/**
 * The element a drawn mark on `el` is about (DEC-047): a whole picture, not a
 * path of it; the link or button a piece of it is in; the text a bold word or
 * a span is in, unless that piece has an id, a test id or a readable class of
 * its own (a badge). `el` otherwise.
 */
export function usefulElement(el: Element): Element {
	let at = el;
	// An SVG's parts: the picture.
	const svg = at.closest("svg");
	if (svg !== null) {
		let outer: Element = svg;
		for (
			let up = svg.parentElement?.closest("svg");
			up;
			up = up.parentElement?.closest("svg")
		)
			outer = up;
		at = outer;
	}
	const control = at.closest(INTERACTIVE);
	if (control !== null) return control;
	while (
		FORMATTING.has(at.localName) &&
		!at.id &&
		!at.hasAttribute("data-testid") &&
		readableClasses(at.getAttribute("class") ?? "").length === 0 &&
		at.parentElement !== null &&
		!IGNORED.has(at.parentElement.localName)
	)
		at = at.parentElement;
	return at;
}

/** The element under a point a mark is drawn at: a note, an end of an arrow or a stroke. */
export function markedElementAt(
	x: number,
	y: number,
	host: Element,
	doc: Document = document,
): Element | null {
	const el = elementAt(x, y, host, doc);
	return el === null ? null : usefulElement(el);
}

/**
 * The element a freehand stroke (in window coordinates) is about. A flat
 * stroke is an underline or a strike-through: the element is the line of
 * text over it, so the box looked at reaches up a line's height. Otherwise,
 * as a box around it.
 */
export function elementForStroke(
	bounds: Rect,
	host: Element,
	doc: Document = document,
): Element | null {
	const rect = isFlatStroke(bounds)
		? {
				x: bounds.x,
				y: bounds.y - 24,
				width: bounds.width,
				height: bounds.height + 24,
			}
		: bounds;
	return elementForRect(rect, host, doc);
}

/** A stroke that is an underline or a strike-through: low and long. */
export const isFlatStroke = (bounds: Rect) =>
	bounds.height < 16 && bounds.width >= bounds.height * 3;

/**
 * Whether a stroke goes from one place to another (a line, a tick), rather
 * than round something (a circle): then its ends say what it links.
 */
export function isOpenStroke(
	points: readonly { x: number; y: number }[],
): boolean {
	const first = points[0];
	const last = points.at(-1);
	if (first === undefined || last === undefined || points.length < 2)
		return false;
	let minX = first.x;
	let maxX = first.x;
	let minY = first.y;
	let maxY = first.y;
	for (const p of points) {
		minX = Math.min(minX, p.x);
		maxX = Math.max(maxX, p.x);
		minY = Math.min(minY, p.y);
		maxY = Math.max(maxY, p.y);
	}
	const diagonal = Math.hypot(maxX - minX, maxY - minY);
	return (
		diagonal > 0 &&
		Math.hypot(last.x - first.x, last.y - first.y) > diagonal * 0.4
	);
}
