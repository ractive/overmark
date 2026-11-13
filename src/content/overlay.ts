/**
 * The overlay's DOM: a fixed, full-window layer in a shadow DOM on top of the
 * page with the marks (SVG), the layer that takes the pointer while a tool is
 * active, the comment field and the toolbar. Styles go in through a
 * constructed style sheet, which a page's Content Security Policy does not
 * block, and neither leak in nor out.
 */

import {
	GROUP_OF,
	type MarkStatus,
	type Rect,
	type Shape,
	type StatusGroup,
} from "../lib/case.ts";
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
/**
 * The overlay's one look (DEC-024): it sits on pages Overmark knows nothing
 * about, so it is the same on each of them and in both colour schemes. A unit
 * test holds every pair of these to its contrast.
 */
export const PAGE_LOOK = {
	/** The toolbar and the review bar. */
	bar: "#1b2130",
	barText: "#ffffff",
	barMuted: "#c5cbd8",
	barHover: "#2f384c",
	/** The pressed tool and the bar's one main action; ink on it. */
	amber: "#ffb000",
	amberHover: "#f0a400",
	/** Under every stroke and around every pin: the edge on a dark page. */
	casing: "#ffffff",
	/** The comment's popover: white, whatever the page's scheme. */
	popover: "#ffffff",
	popoverText: "#1b2130",
	popoverMuted: "#535c6e",
	popoverEdge: "#7b8291",
	/** The edge of an amber button on the popover's white. */
	amberEdge: "#a06c00",
} as const;
/**
 * A loaded mark's colour is its status, by the group it counts in. Open is
 * the colour of the mark on its screenshot; each carries the pin's white number.
 */
export const STATUS_COLOUR: Record<StatusGroup, string> = {
	open: MARK_COLOUR,
	toVerify: "#4f53e0",
	verified: "#1a7f37",
	closed: "#667085",
};
/** A mark fixed and waiting to be verified: drawn in full, to be checked (DEC-023). */
export const TO_VERIFY_COLOUR = STATUS_COLOUR.toVerify;
/** How much of a verified or closed mark's shape shows; its pin stays solid to be found. */
export const RESOLVED_OPACITY = 0.35;
/** How much wider than its stroke a shape's casing is. */
export const CASING_EXTRA = 3;
/**
 * Under this page width the toolbar's status goes to a second, centred row,
 * and under the next ones the buttons with an icon lose their words (the
 * tools first), so the tools never wrap in the middle. Measured: the tools
 * with their words are about 740 px wide, as icons 550, all as icons 470, close 390; the
 * status takes up to 300.
 */
export const TWO_ROWS_BELOW = 960;
export const TOOL_ICONS_BELOW = 820;
export const ALL_ICONS_BELOW = 620;
/** Under this the buttons stand closer; a narrower page than about 400 px wraps them. */
export const TIGHT_BELOW = 540;
const SVG = "http://www.w3.org/2000/svg";
const L = PAGE_LOOK;
/** The bars' edge on a dark page, then their shadow. */
const RING = "0 0 0 1px rgba(255, 255, 255, 0.75)";
const SHADOW = `${RING}, 0 6px 24px rgba(13, 18, 30, 0.35)`;
/** A word that stays the button's name while only its icon shows. */
const NO_WORD =
	"position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;";

const STYLE = `
/* Important: a page's own rule on the host would beat this otherwise. */
:host { all: initial !important; }
.layer {
	direction: ltr;
	position: fixed; inset: 0; z-index: 2147483647;
	pointer-events: none;
	font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
	color: ${L.popoverText};
}
svg.marks { position: fixed; inset: 0; width: 100%; height: 100%; overflow: visible; }
.capture { position: fixed; inset: 0; pointer-events: none; cursor: crosshair; }
.capture.active { pointer-events: auto; }
.capture.element { cursor: default; }
.toolbar {
	position: fixed; left: 16px; right: 16px; bottom: 16px; margin-inline: auto;
	box-sizing: border-box; width: fit-content; max-width: calc(100vw - 32px);
	display: flex; gap: 2px; align-items: center; justify-content: center;
	padding: 5px; border-radius: 12px;
	background: ${L.bar}; color: ${L.barText};
	box-shadow: ${SHADOW};
	pointer-events: auto;
}
.toolbar.top { top: 16px; bottom: auto; }
.ring { flex: none; width: 20px; height: 20px; margin: 0 6px; fill: none; stroke: ${L.amber}; stroke-width: 3.5; }
.toolbar .status {
	min-width: 0; max-width: 300px; padding: 0 8px;
	color: ${L.barMuted}; font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
}
.toolbar .sep { flex: none; width: 1px; align-self: stretch; margin: 4px; background: rgba(255, 255, 255, 0.28); }
.toolbar button {
	all: unset; box-sizing: border-box; flex: none; cursor: pointer;
	position: relative; min-width: 28px; min-height: 30px; padding: 4px 9px; border-radius: 8px;
	display: inline-flex; gap: 6px; align-items: center; justify-content: center;
	color: ${L.barText}; font: inherit; white-space: nowrap;
}
.icon {
	flex: none; width: 16px; height: 16px; fill: none; stroke: currentColor;
	stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round;
}
.toolbar button:hover, .toolbar button:focus-visible { background: ${L.barHover}; }
.toolbar button[aria-pressed="true"] { background: ${L.amber}; color: ${L.bar}; }
.toolbar button.primary { background: ${L.amber}; color: ${L.bar}; font-weight: 600; padding-inline: 12px; }
.toolbar button.primary:hover, .toolbar button.primary:focus-visible { background: ${L.amberHover}; }
/* Not opacity alone: muted, and nothing answers the pointer. */
.toolbar button:disabled { color: ${L.barMuted}; opacity: 0.6; cursor: default; background: none; }
.toolbar button:focus-visible, .reviewbar button:focus-visible { outline: 2px solid ${L.barText}; outline-offset: 1px; }
.toolbar input {
	box-sizing: border-box; min-height: 30px; flex: 0 1 auto; width: 220px; min-width: 120px;
	font: inherit; padding: 4px 8px; border-radius: 8px; border: 0; margin-right: 4px;
	color: ${L.popoverText}; background: #fff; color-scheme: light;
}
.toolbar input:focus-visible { outline: 2px solid ${L.amber}; outline-offset: 1px; }
/* Two rows on purpose: the tools on the first, what they are at under them. */
@media (max-width: ${TWO_ROWS_BELOW - 1}px) {
	.toolbar { flex-wrap: wrap; row-gap: 0; }
	/* No width of its own, then all of the row: the bar is as wide as its tools. */
	.toolbar .status {
		order: 1; flex: none; box-sizing: border-box; width: 0; min-width: 100%; max-width: none;
		padding: 3px 8px 2px; text-align: center;
	}
}
@media (max-width: ${TOOL_ICONS_BELOW - 1}px) {
	.toolbar button[aria-pressed] .word { ${NO_WORD} }
}
@media (max-width: ${ALL_ICONS_BELOW - 1}px) {
	.toolbar button:has(.icon) .word { ${NO_WORD} }
}
@media (max-width: ${TIGHT_BELOW - 1}px) {
	.toolbar button { padding-inline: 6px; }
	.toolbar button.primary { padding-inline: 9px; }
	.toolbar .ring { margin: 0 2px; }
	.toolbar .sep { display: none; }
}
.popover {
	box-sizing: border-box; position: fixed; width: 296px; padding: 10px; border-radius: 12px;
	/* A dark page does not restyle the field. */
	color-scheme: light;
	background: ${L.popover}; color: ${L.popoverText};
	box-shadow: ${SHADOW};
	pointer-events: auto;
}
.popover textarea {
	box-sizing: border-box; display: block; width: 100%; min-height: 72px; resize: vertical;
	font: inherit; padding: 6px 8px; border: 1px solid ${L.popoverEdge}; border-radius: 6px;
	color: ${L.popoverText}; background: ${L.popover};
}
.popover textarea::placeholder { color: ${L.popoverMuted}; opacity: 1; }
.popover textarea:focus-visible, .popover button:focus-visible { outline: 2px solid ${HOVER_COLOUR}; outline-offset: 1px; }
.popover .row { display: flex; gap: 6px; justify-content: space-between; margin-top: 8px; }
.popover button {
	box-sizing: border-box; min-height: 28px; font: inherit; font-weight: 600;
	padding: 3px 12px; border-radius: 6px; cursor: pointer;
	border: 1px solid ${L.popoverEdge}; background: ${L.popover}; color: ${L.popoverText};
}
.popover button:hover { background: #eef0f4; }
.popover button.primary { background: ${L.amber}; border-color: ${L.amberEdge}; }
.popover button.primary:hover { background: ${L.amberHover}; }
.popover .label { display: flex; gap: 8px; align-items: center; font-weight: 600; margin-bottom: 8px; }
.popover .pin {
	display: inline-grid; place-items: center; min-width: 22px; height: 22px; padding-inline: 4px;
	box-sizing: border-box; border-radius: 11px; background: ${MARK_COLOUR}; color: #fff;
	font: 700 12px/1 ui-rounded, "SF Pro Rounded", system-ui, sans-serif;
}
.reviewbar {
	position: fixed; right: 16px; top: 16px;
	box-sizing: border-box; display: flex; gap: 8px; align-items: center;
	padding: 5px 5px 5px 2px; border-radius: 12px;
	background: ${L.bar}; color: ${L.barText};
	box-shadow: ${SHADOW};
	pointer-events: auto; max-width: min(440px, calc(100vw - 32px));
}
/* Under a toolbar at the top: it would cover the toolbar's last buttons. */
.toolbar.top:not([hidden]) ~ .reviewbar { top: 64px; }
/* The count says what the bar is for: a long title gives way. */
.reviewbar .text { display: flex; gap: 8px; min-width: 0; }
.reviewbar .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: ${L.barMuted}; }
.reviewbar .sep { flex: none; color: ${L.barMuted}; }
.reviewbar .count { flex: none; font-weight: 600; font-variant-numeric: tabular-nums; }
.reviewbar button {
	all: unset; box-sizing: border-box; flex: none; cursor: pointer;
	min-height: 28px; padding: 3px 11px; border-radius: 8px;
	display: inline-flex; align-items: center;
	border: 1px solid rgba(255, 255, 255, 0.5);
	color: ${L.barText}; font: inherit; font-weight: 600;
}
.reviewbar button:hover, .reviewbar button:focus-visible { background: ${L.barHover}; border-color: ${L.barText}; }
/* The user's own colours: the system's, with every edge drawn. */
@media (forced-colors: active) {
	.toolbar, .reviewbar, .popover {
		background: Canvas; color: CanvasText; border: 1px solid CanvasText; box-shadow: none;
	}
	.toolbar .status, .reviewbar .title { color: CanvasText; }
	.toolbar .sep { background: CanvasText; }
	.toolbar button, .reviewbar button, .popover button {
		border: 1px solid CanvasText; background: Canvas; color: CanvasText;
	}
	.toolbar button[aria-pressed="true"], .toolbar button.primary, .popover button.primary {
		forced-color-adjust: none; background: Highlight; color: HighlightText; border-color: Highlight;
	}
	.toolbar button:disabled { border-color: GrayText; color: GrayText; opacity: 1; }
	.toolbar button:focus-visible, .reviewbar button:focus-visible, .toolbar input:focus-visible { outline-color: Highlight; }
	.toolbar input, .popover textarea { border: 1px solid CanvasText; }
	.ring { stroke: CanvasText; }
}
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
	/** Its status: a verified or closed mark is drawn faded, so the others stand out. */
	status: MarkStatus;
}

/** Drawn faded: nothing more to do about it. */
export const isSettled = (status: MarkStatus): boolean =>
	status === "verified" || status === "wontfix" || status === "cantreproduce";

/** A loaded mark's colour: its status (open, to verify, verified, closed). */
export function reviewColour(item: Pick<ReviewItem, "status">): string {
	return STATUS_COLOUR[GROUP_OF[item.status]];
}

/** A loaded mark's stroke: solid when its element is found, dashed when unsure. */
export function reviewStroke(
	item: Pick<ReviewItem, "found" | "focused">,
): Record<string, string | number> {
	return {
		"stroke-width": item.focused ? 4 : 3,
		// Round caps would close the gaps.
		...(item.found
			? {}
			: { "stroke-dasharray": "8 5", "stroke-linecap": "butt" }),
	};
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
			const box = {
				class: "hover",
				x: hover.x - 2,
				y: hover.y - 2,
				width: hover.width + 4,
				height: hover.height + 4,
			};
			children.push(
				svg(doc, "rect", {
					...box,
					"data-casing": "",
					fill: "none",
					stroke: L.casing,
					"stroke-width": 2 + CASING_EXTRA,
				}),
				svg(doc, "rect", {
					...box,
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
	 * Draw a loaded case's marks (window coordinates): the colour is the
	 * mark's status, the dash its match (DEC-024). The focused one also shows
	 * the element it belongs to; an element's mark is that outline.
	 */
	renderReview(items: readonly ReviewItem[]): void {
		const doc = this.doc;
		const groups = items.map((item) => {
			const settled = isSettled(item.status);
			const colour = reviewColour(item);
			const look = reviewStroke(item);
			const group = svg(doc, "g", {
				"data-review": item.number,
				"data-status": item.status,
				...(settled ? { "data-resolved": "" } : {}),
			});
			if (item.focused && item.rect !== null) {
				const box = {
					x: item.rect.x - 3,
					y: item.rect.y - 3,
					width: item.rect.width + 6,
					height: item.rect.height + 6,
					rx: 4,
				};
				group.append(
					svg(doc, "rect", {
						...box,
						"data-casing": "",
						fill: "none",
						stroke: L.casing,
						"stroke-width": 1 + CASING_EXTRA,
					}),
					svg(doc, "rect", {
						...box,
						"data-element": "",
						fill: "rgba(229, 25, 95, 0.08)",
						stroke: colour,
						"stroke-width": 1,
					}),
				);
			}
			const shape = this.#shape(item.shape, colour, look);
			// A focused one is looked for: it shows fully.
			if (settled && !item.focused) {
				const faded = svg(doc, "g", {
					"data-faded": "",
					opacity: RESOLVED_OPACITY,
				});
				faded.append(...shape);
				group.append(faded);
			} else group.append(...shape);
			group.append(this.#badge(item, colour));
			return group;
		});
		this.#review.replaceChildren(...groups);
	}

	/**
	 * A mark's shape, each part drawn twice: a white casing (`data-casing`),
	 * wider and never dashed, then the coloured stroke, so the mark has an
	 * edge on a page of its own colour and on a dark one.
	 */
	#shape(
		shape: Shape,
		colour: string = MARK_COLOUR,
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
		const casing = {
			"data-casing": "",
			fill: "none",
			stroke: L.casing,
			"stroke-width": Number(stroke["stroke-width"]) + CASING_EXTRA,
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
		};
		const twice = <K extends keyof SVGElementTagNameMap>(
			tag: K,
			geometry: Record<string, string | number>,
		): SVGElement[] => [
			svg(doc, tag, { ...geometry, ...casing }),
			svg(doc, tag, { ...geometry, ...stroke }),
		];
		switch (shape.kind) {
			case "element":
			case "box":
				return twice("rect", {
					x: shape.rect.x,
					y: shape.rect.y,
					width: shape.rect.width,
					height: shape.rect.height,
					rx: 4,
				});
			case "arrow": {
				const { from, to } = shape;
				const [l, r] = arrowHead(from, to);
				const line = { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
				const points = `${to.x},${to.y} ${l.x},${l.y} ${r.x},${r.y}`;
				return [
					svg(doc, "line", { ...line, ...casing }),
					svg(doc, "polygon", {
						points,
						...casing,
						fill: L.casing,
						"stroke-width": CASING_EXTRA,
					}),
					svg(doc, "line", { ...line, ...stroke }),
					svg(doc, "polygon", { points, fill: colour }),
				];
			}
			case "pen":
				return twice("polyline", {
					points: shape.points.map((p) => `${p.x},${p.y}`).join(" "),
				});
			case "note":
				return [];
		}
	}

	#badge(mark: RenderedMark, colour: string = MARK_COLOUR): SVGElement {
		const doc = this.doc;
		const at = badgePosition(mark.shape);
		const g = svg(doc, "g", { "data-number": mark.number });
		g.append(
			svg(doc, "circle", {
				cx: at.x,
				cy: at.y,
				r: badgeRadius(mark.shape),
				fill: colour,
				stroke: L.casing,
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
