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
/** Both carry a mark's white number, here and in the side panel's list. */
/** A resolved mark's colour in the grey look. */
export const RESOLVED_COLOUR = "#6b7385";

/** How a resolved mark looks: grey, or its own colours very faint. */
export const RESOLVED_LOOK: "grey" | "faint" = "grey";

export const FOUND_COLOUR = "#1a7f37";
export const PROBABLE_COLOUR = "#b45f06";
const SVG = "http://www.w3.org/2000/svg";
const INK = "#1d2433";
const AMBER = "#ffb000";
const SHADOW = "0 6px 24px rgba(13, 18, 30, 0.35)";

const STYLE = `
/* Important: a page's own rule on the host would beat this otherwise. */
:host { all: initial !important; }
.layer {
	direction: ltr;
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
	position: fixed; left: 16px; right: 16px; bottom: 16px; margin-inline: auto;
	width: fit-content; max-width: calc(100vw - 32px);
	display: flex; gap: 2px; align-items: center; flex-wrap: wrap; justify-content: center;
	padding: 5px; border-radius: 12px;
	background: ${INK}; color: #fff;
	box-shadow: ${SHADOW};
	pointer-events: auto;
}
.toolbar.top { top: 16px; bottom: auto; }
.ring { flex: none; width: 20px; height: 20px; margin: 0 6px; fill: none; stroke: ${AMBER}; stroke-width: 3.5; }
.toolbar .status { padding: 0 8px; color: #b8c0d0; max-width: 340px; font-variant-numeric: tabular-nums; }
.toolbar .sep { width: 1px; align-self: stretch; margin: 4px; background: #3a4560; }
.toolbar button {
	all: unset; cursor: pointer; padding: 6px 9px; border-radius: 8px;
	display: inline-flex; gap: 6px; align-items: center;
	color: #fff; font: inherit;
}
.icon {
	flex: none; width: 16px; height: 16px; fill: none; stroke: currentColor;
	stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round;
}
.toolbar button:hover, .toolbar button:focus-visible { background: #34405a; }
.toolbar button[aria-pressed="true"] { background: ${AMBER}; color: ${INK}; }
.toolbar button.primary { background: ${AMBER}; color: ${INK}; font-weight: 600; }
.toolbar button.primary:hover, .toolbar button.primary:focus-visible { background: #eea400; }
.toolbar button:disabled { opacity: 0.5; cursor: default; background: none; }
.toolbar button:focus-visible, .reviewbar button:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
.toolbar input {
	font: inherit; padding: 5px 8px; border-radius: 8px; border: 0; margin-right: 4px;
	min-width: 220px; color: ${INK}; background: #fff;
}
.popover {
	box-sizing: border-box; position: fixed; width: 296px; padding: 10px; border-radius: 12px;
	background: #fff; color: ${INK};
	box-shadow: ${SHADOW}; border: 1px solid #dfe3ea;
	pointer-events: auto;
}
.popover textarea {
	box-sizing: border-box; display: block; width: 100%; min-height: 72px; resize: vertical;
	font: inherit; padding: 6px 8px; border: 1px solid #c8cdd8; border-radius: 8px;
	color: ${INK}; background: #fff;
}
.popover textarea:focus { outline: 2px solid ${HOVER_COLOUR}; outline-offset: -1px; border-color: transparent; }
.popover .row { display: flex; gap: 6px; justify-content: space-between; margin-top: 8px; }
.popover button {
	font: inherit; padding: 4px 10px; border-radius: 8px; cursor: pointer;
	border: 1px solid #c8cdd8; background: #fff; color: ${INK};
}
.popover button:hover { background: #f2f4f7; }
.popover button.primary { background: ${AMBER}; border-color: ${AMBER}; font-weight: 600; }
.popover button.primary:hover { background: #eea400; border-color: #eea400; }
.popover .label { display: flex; gap: 8px; align-items: center; font-weight: 600; margin-bottom: 8px; }
.popover .pin {
	display: inline-grid; place-items: center; min-width: 22px; height: 22px; padding-inline: 4px;
	box-sizing: border-box; border-radius: 11px; background: ${MARK_COLOUR}; color: #fff;
	font: 700 12px/1 ui-rounded, system-ui, sans-serif;
}
.reviewbar {
	position: fixed; right: 16px; top: 16px;
	display: flex; gap: 8px; align-items: center;
	padding: 5px 5px 5px 2px; border-radius: 12px;
	background: ${INK}; color: #fff;
	box-shadow: ${SHADOW};
	pointer-events: auto; max-width: min(440px, calc(100vw - 32px));
}
/* Under a toolbar at the top: it would cover the toolbar's last buttons. */
.toolbar.top:not([hidden]) ~ .reviewbar { top: 64px; }
/* The count says what the bar is for: a long title gives way. */
.reviewbar .text { display: flex; gap: 8px; min-width: 0; }
.reviewbar .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #b8c0d0; }
.reviewbar .count { flex: none; font-weight: 600; font-variant-numeric: tabular-nums; }
.reviewbar button {
	all: unset; cursor: pointer; padding: 4px 10px; border-radius: 8px; color: #fff; font: inherit;
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

/** The toolbar's icons: paths on a 16×16 grid, drawn with a stroke. */
const ICONS = {
	element: [
		"M2 5V3a1 1 0 0 1 1-1h2",
		"M11 2h2a1 1 0 0 1 1 1v2",
		"M14 11v2a1 1 0 0 1-1 1h-2",
		"M5 14H3a1 1 0 0 1-1-1v-2",
		"M6 6l4.5 1.6-1.9.9-.9 1.9z",
	],
	box: [
		"M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z",
	],
	arrow: ["M3 13L13 3", "M6.5 3H13v6.5"],
	pen: ["M2 11c2-5 3.5-7 5-6s-1.5 6 .5 6.5S11 8 12 8s1 2 2 2"],
	note: [
		"M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H7l-3 2.5V11h-.5a1 1 0 0 1-1-1z",
	],
	undo: ["M5.5 3l-3 3 3 3", "M2.5 6H9a4 4 0 0 1 0 8H6"],
	close: ["M4 4l8 8", "M12 4l-8 8"],
	up: ["M8 13V3", "M4 7l4-4 4 4"],
	down: ["M8 3v10", "M4 9l4 4 4-4"],
} as const;

export type IconName = keyof typeof ICONS;

export function icon(doc: Document, name: IconName): SVGSVGElement {
	const el = svg(doc, "svg", {
		class: "icon",
		viewBox: "0 0 16 16",
		"aria-hidden": "true",
	});
	for (const d of ICONS[name]) el.append(svg(doc, "path", { d }));
	return el;
}

/** The ring of Overmark's icon, as if something on the page were circled. */
export function ring(doc: Document): SVGSVGElement {
	const el = svg(doc, "svg", {
		class: "ring",
		viewBox: "0 0 20 20",
		role: "img",
	});
	const title = svg(doc, "title", {});
	title.textContent = "Overmark";
	el.append(title, svg(doc, "circle", { cx: 10, cy: 10, r: 7 }));
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
	/** Settled: drawn faded, so the open marks stand out. */
	resolved: boolean;
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
			const colour =
				item.resolved && RESOLVED_LOOK === "grey"
					? RESOLVED_COLOUR
					: item.found
						? FOUND_COLOUR
						: PROBABLE_COLOUR;
			const look = {
				"stroke-width": item.focused ? 4 : 3,
				// Round caps would close the gaps.
				...(item.found
					? {}
					: { "stroke-dasharray": "8 5", "stroke-linecap": "butt" }),
			};
			const group = svg(doc, "g", {
				"data-review": item.number,
				...(item.resolved
					? {
							"data-resolved": "",
							// A focused one is looked for: it shows fully.
							opacity: item.focused ? 1 : RESOLVED_LOOK === "grey" ? 0.75 : 0.3,
						}
					: {}),
			});
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
