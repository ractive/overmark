/**
 * The overlay's DOM: a fixed, full-window layer in a shadow DOM on top of the
 * page with the marks (SVG), the layer that takes the pointer while a tool is
 * active, the comment field and the toolbar. Styles go in through a
 * constructed style sheet, which a page's Content Security Policy does not
 * block, and neither leak in nor out.
 */

import type { Rect, Shape } from "../lib/case.ts";
import {
	arrowHead,
	badgePosition,
	badgeRadius,
	MARK_COLOUR,
	type RenderedMark,
} from "../lib/marks.ts";

declare const OVERMARK_TEST_BUILD: boolean | undefined;

export const HOST_ID = "overmark-root";
export const HOVER_COLOUR = "#1f6feb";
export const FOUND_COLOUR = "#1e8e3e";
export const PROBABLE_COLOUR = "#d97706";
const SVG = "http://www.w3.org/2000/svg";

const STYLE = `
:host { all: initial; }
.layer {
	position: fixed; inset: 0; z-index: 2147483647;
	pointer-events: none;
	font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
	color: #1d2433;
}
svg.marks { position: fixed; inset: 0; width: 100%; height: 100%; overflow: visible; }
.capture { position: fixed; inset: 0; pointer-events: none; cursor: crosshair; }
.capture.active { pointer-events: auto; }
.capture.element { cursor: default; }
.toolbar {
	position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
	display: flex; gap: 2px; align-items: center; flex-wrap: wrap; justify-content: center;
	max-width: calc(100vw - 32px);
	padding: 6px; border-radius: 10px;
	background: #1d2433; color: #fff;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
	pointer-events: auto;
}
.toolbar.top { top: 16px; bottom: auto; }
.toolbar .brand { padding: 0 8px; font-weight: 600; color: #ffb000; }
.toolbar .status { padding: 0 8px; color: #b8c0d0; }
.toolbar .sep { width: 1px; align-self: stretch; margin: 2px 4px; background: #3a4560; }
.toolbar button {
	all: unset; cursor: pointer; padding: 6px 10px; border-radius: 6px;
	color: #fff; font: inherit;
}
.toolbar button:hover, .toolbar button:focus-visible { background: #34405a; }
.toolbar button[aria-pressed="true"] { background: #ffb000; color: #1d2433; }
.toolbar button.primary { background: #ffb000; color: #1d2433; font-weight: 600; }
.toolbar button:disabled { opacity: 0.5; cursor: default; }
.toolbar input {
	font: inherit; padding: 5px 8px; border-radius: 6px; border: 0;
	min-width: 220px; color: #1d2433; background: #fff;
}
.popover {
	position: fixed; width: 280px; padding: 8px; border-radius: 8px;
	background: #fff; color: #1d2433;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3); border: 2px solid ${MARK_COLOUR};
	pointer-events: auto;
}
.popover textarea {
	box-sizing: border-box; width: 100%; min-height: 72px; resize: vertical;
	font: inherit; padding: 6px; border: 1px solid #c8cdd8; border-radius: 6px;
	color: #1d2433; background: #fff;
}
.popover .row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; }
.popover button {
	font: inherit; padding: 4px 10px; border-radius: 6px; cursor: pointer;
	border: 1px solid #c8cdd8; background: #f4f6f9; color: #1d2433;
}
.popover button.primary { background: ${MARK_COLOUR}; border-color: ${MARK_COLOUR}; color: #fff; }
.popover .label { font-weight: 600; margin-bottom: 4px; }
.reviewbar {
	position: fixed; right: 16px; top: 16px;
	display: flex; gap: 8px; align-items: center;
	padding: 6px 6px 6px 12px; border-radius: 10px;
	background: #1d2433; color: #fff;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
	pointer-events: auto; max-width: min(420px, calc(100vw - 32px));
}
.reviewbar .brand { font-weight: 600; color: #ffb000; }
.reviewbar .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reviewbar button {
	all: unset; cursor: pointer; padding: 4px 10px; border-radius: 6px; color: #fff; font: inherit;
}
.reviewbar button:hover, .reviewbar button:focus-visible { background: #34405a; }
/* Screenshots show the page alone. Invisible, not gone: a field keeps its focus. */
.capturing { opacity: 0 !important; }
/* An AI app's screenshot of one element: only its temporary mark shows. */
.marking .toolbar, .marking .popover, .marking .reviewbar { opacity: 0 !important; }
.marking .hover, .marking .review, .marking .drafts { display: none !important; }
[hidden] { display: none !important; }
`;

function svg<K extends keyof SVGElementTagNameMap>(
	doc: Document,
	tag: K,
	attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] {
	const el = doc.createElementNS(SVG, tag);
	for (const [k, v] of Object.entries(attributes))
		el.setAttribute(k, String(v));
	return el;
}

/** A loaded case's mark, drawn where its element was found. */
export interface ReviewItem {
	number: number;
	/** The mark in window coordinates. */
	shape: Shape;
	/** Its element's box in window coordinates; a mark may have no element. */
	rect: Rect | null;
	/** The shown candidate is a confident, unambiguous match. */
	found: boolean;
	focused: boolean;
}

/** What the page must not see: a click on the overlay is no click outside its menu. */
const OWN_EVENTS = [
	"pointerdown",
	"pointerup",
	"mousedown",
	"mouseup",
	"click",
	"dblclick",
	"auxclick",
	"contextmenu",
	"touchstart",
	"touchend",
	"keydown",
	"keyup",
	"keypress",
];

/** A page's focus trap takes focus back from anything outside its modal. */
const FOCUS_EVENTS = ["focus", "blur", "focusin", "focusout"];

/** The page's open modal dialog: everything outside it is inert. */
function modalDialog(doc: Document): Element | null {
	try {
		return doc.querySelector("dialog:modal");
	} catch {
		return null; // The selector is not known here.
	}
}

export class Overlay {
	readonly doc: Document;
	readonly host: HTMLElement;
	readonly root: ShadowRoot;
	readonly layer: HTMLDivElement;
	readonly marks: SVGSVGElement;
	readonly capture: HTMLDivElement;
	readonly toolbar: HTMLDivElement;
	readonly popover: HTMLDivElement;
	readonly reviewBar: HTMLDivElement;
	readonly #drafts: SVGGElement;
	readonly #review: SVGGElement;
	readonly #temporary: SVGGElement;
	#annotating = false;
	#reviewing = false;
	#marking = false;
	#timer: ReturnType<typeof setInterval> | undefined;
	/**
	 * Called after the toolbar or the outlines are shown or hidden, including
	 * by the overlay's own Close and Hide buttons.
	 */
	onChange: (() => void) | undefined;
	/** Called twice a second while something shows: layouts change without a scroll. */
	onTick: (() => void) | undefined;

	constructor(doc: Document = document) {
		this.doc = doc;
		this.host = doc.createElement("div");
		this.host.id = HOST_ID;
		// Closed, so a page's scripts cannot read or drive the overlay. The
		// end-to-end tests reach in through a test build's open root.
		this.root = this.host.attachShadow({
			mode:
				typeof OVERMARK_TEST_BUILD !== "undefined" && OVERMARK_TEST_BUILD
					? "open"
					: "closed",
		});
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(STYLE);
		this.root.adoptedStyleSheets = [sheet];
		this.layer = doc.createElement("div");
		this.layer.className = "layer";
		this.layer.hidden = true;
		this.marks = svg(doc, "svg", { class: "marks" });
		this.#review = svg(doc, "g", { class: "review" });
		this.#drafts = svg(doc, "g", { class: "drafts" });
		this.#temporary = svg(doc, "g", { class: "temporary" });
		this.marks.append(this.#review, this.#drafts, this.#temporary);
		this.capture = doc.createElement("div");
		this.capture.className = "capture";
		this.popover = doc.createElement("div");
		this.popover.className = "popover";
		this.popover.hidden = true;
		this.toolbar = doc.createElement("div");
		this.toolbar.className = "toolbar";
		this.toolbar.setAttribute("role", "toolbar");
		this.toolbar.setAttribute("aria-label", "Overmark");
		this.reviewBar = doc.createElement("div");
		this.reviewBar.className = "reviewbar";
		this.layer.append(
			this.marks,
			this.capture,
			this.popover,
			this.toolbar,
			this.reviewBar,
		);
		this.root.append(this.layer);
		for (const type of OWN_EVENTS)
			this.layer.addEventListener(type, (e) => e.stopPropagation());
		for (const type of FOCUS_EVENTS)
			doc.defaultView?.addEventListener(
				type,
				(e) => {
					if (e.target === this.host) e.stopImmediatePropagation();
				},
				true,
			);
		doc.addEventListener("fullscreenchange", () => this.#place());
		doc.documentElement.append(this.host);
		this.#update();
	}

	/** The toolbar is up: the user is drawing marks. */
	get annotating(): boolean {
		return this.#annotating;
	}

	/** An AI app's temporary mark is up for its screenshot. */
	get marking(): boolean {
		return this.#marking;
	}

	/** A loaded case's marks are drawn. */
	get reviewing(): boolean {
		return this.#reviewing;
	}

	setAnnotating(on: boolean): void {
		this.#annotating = on;
		this.#update();
		this.onChange?.();
	}

	setReviewing(on: boolean): void {
		this.#reviewing = on;
		this.#update();
		this.onChange?.();
	}

	/**
	 * Mark one element for a screenshot an AI app takes, with everything else
	 * of Overmark's hidden; `null` removes it.
	 */
	setTemporaryMark(mark: { number: number; rect: Rect } | null): void {
		this.#marking = mark !== null;
		this.#temporary.replaceChildren(
			...(mark === null
				? []
				: [
						...this.#shape({ kind: "element", rect: mark.rect }),
						this.#badge({
							number: mark.number,
							shape: { kind: "element", rect: mark.rect },
						}),
					]),
		);
		// Its own class: a save's capturing state must survive an unmark.
		this.layer.classList.toggle("marking", this.#marking);
		this.#update();
	}

	#update(): void {
		const shown = this.#annotating || this.#reviewing || this.#marking;
		this.layer.hidden = !shown;
		this.toolbar.hidden = !this.#annotating;
		this.capture.hidden = !this.#annotating;
		this.#drafts.style.display = this.#annotating ? "" : "none";
		this.reviewBar.hidden = !this.#reviewing;
		this.#review.style.display = this.#reviewing ? "" : "none";
		// Stay on top of elements the page appended later.
		if (shown && this.host.nextElementSibling !== null) this.#place(true);
		if (shown && this.#timer === undefined) {
			this.#timer = setInterval(() => {
				this.#place();
				this.onTick?.();
			}, 500);
		} else if (!shown) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	/**
	 * The top layer covers even this overlay: go inside a modal dialog or a
	 * fullscreen element while there is one. `last` also moves the host to the
	 * end of its parent; that costs a field its focus, so not on every tick.
	 */
	#place(last = false): void {
		const doc = this.doc;
		const parent =
			doc.fullscreenElement ?? modalDialog(doc) ?? doc.documentElement;
		if (last || this.host.parentElement !== parent) parent.append(this.host);
	}

	/** Hide all of Overmark while a screenshot is taken. */
	setCapturing(on: boolean): void {
		this.layer.classList.toggle("capturing", on);
	}

	/** Draw the marks (saved ones fainter), the one being drawn and the hovered element's outline. */
	render(
		marks: readonly RenderedMark[],
		preview: Shape | null,
		hover: Rect | null,
		saved: readonly RenderedMark[] = [],
	): void {
		const doc = this.doc;
		const children: SVGElement[] = [];
		if (hover !== null) {
			children.push(
				svg(doc, "rect", {
					class: "hover",
					x: hover.x - 2,
					y: hover.y - 2,
					width: hover.width + 4,
					height: hover.height + 4,
					fill: "rgba(31, 111, 235, 0.08)",
					stroke: HOVER_COLOUR,
					"stroke-width": 2,
					"stroke-dasharray": "6 4",
				}),
			);
		}
		if (saved.length > 0) {
			const group = svg(doc, "g", { class: "saved", opacity: 0.5 });
			for (const mark of saved)
				group.append(...this.#shape(mark.shape), this.#badge(mark));
			children.push(group);
		}
		for (const mark of marks)
			children.push(...this.#shape(mark.shape), this.#badge(mark));
		if (preview !== null) children.push(...this.#shape(preview));
		this.#drafts.replaceChildren(...children);
	}

	/**
	 * Draw a loaded case's marks (window coordinates). The focused one also
	 * shows the element it belongs to; an element's mark is that outline.
	 */
	renderReview(items: readonly ReviewItem[]): void {
		const doc = this.doc;
		const groups = items.map((item) => {
			const colour = item.found ? FOUND_COLOUR : PROBABLE_COLOUR;
			const look = {
				"stroke-width": item.focused ? 4 : 3,
				...(item.found ? {} : { "stroke-dasharray": "8 5" }),
			};
			const group = svg(doc, "g", { "data-review": item.number });
			if (item.focused && item.rect !== null)
				group.append(
					svg(doc, "rect", {
						x: item.rect.x - 3,
						y: item.rect.y - 3,
						width: item.rect.width + 6,
						height: item.rect.height + 6,
						rx: 4,
						fill: "rgba(229, 25, 95, 0.08)",
						stroke: colour,
						"stroke-width": 1,
					}),
				);
			group.append(
				...this.#shape(item.shape, colour, look),
				this.#badge(item, colour),
			);
			return group;
		});
		this.#review.replaceChildren(...groups);
	}

	#shape(
		shape: Shape,
		colour = MARK_COLOUR,
		look: Record<string, string | number> = {},
	): SVGElement[] {
		const doc = this.doc;
		const stroke = {
			fill: "none",
			stroke: colour,
			"stroke-width": 3,
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
			...look,
		};
		switch (shape.kind) {
			case "element":
			case "box":
				return [
					svg(doc, "rect", {
						x: shape.rect.x,
						y: shape.rect.y,
						width: shape.rect.width,
						height: shape.rect.height,
						rx: 4,
						...stroke,
					}),
				];
			case "arrow": {
				const { from, to } = shape;
				const [l, r] = arrowHead(from, to);
				return [
					svg(doc, "line", {
						x1: from.x,
						y1: from.y,
						x2: to.x,
						y2: to.y,
						...stroke,
					}),
					svg(doc, "polygon", {
						points: `${to.x},${to.y} ${l.x},${l.y} ${r.x},${r.y}`,
						fill: colour,
					}),
				];
			}
			case "pen":
				return [
					svg(doc, "polyline", {
						points: shape.points.map((p) => `${p.x},${p.y}`).join(" "),
						...stroke,
					}),
				];
			case "note":
				return [];
		}
	}

	#badge(mark: RenderedMark, colour = MARK_COLOUR): SVGElement {
		const doc = this.doc;
		const at = badgePosition(mark.shape);
		const g = svg(doc, "g", { "data-number": mark.number });
		g.append(
			svg(doc, "circle", {
				cx: at.x,
				cy: at.y,
				r: badgeRadius(mark.shape),
				fill: colour,
				stroke: "#fff",
				"stroke-width": 2,
			}),
		);
		const text = svg(doc, "text", {
			x: at.x,
			y: at.y,
			fill: "#fff",
			"font-size": 12,
			"font-weight": 700,
			"font-family": "system-ui, sans-serif",
			"text-anchor": "middle",
			"dominant-baseline": "central",
		});
		text.textContent = String(mark.number);
		g.append(text);
		return g;
	}
}
