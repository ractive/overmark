/**
 * The overlay's DOM: a fixed, full-window layer in a shadow DOM on top of the
 * page with the marks (SVG), the layer that takes the pointer while a tool is
 * active, the comment field and the toolbar. Styles go in through a
 * constructed style sheet, which a page's Content Security Policy does not
 * block, and neither leak in nor out.
 */

import type { Point, Rect, Shape } from "../lib/case.ts";

export const HOST_ID = "overmark-root";
export const MARK_COLOUR = "#e5195f";
export const HOVER_COLOUR = "#1f6feb";
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
.capturing .toolbar, .capturing .popover, .capturing .hover { display: none !important; }
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

export interface RenderedMark {
	number: number;
	/** In window coordinates. */
	shape: Shape;
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
	/** Called after `show()` and `hide()`, including the toolbar's Close. */
	onChange: ((visible: boolean) => void) | undefined;

	constructor(doc: Document = document) {
		this.doc = doc;
		this.host = doc.createElement("div");
		this.host.id = HOST_ID;
		// Open, so tests can reach in; the page could anyway, through the DOM.
		this.root = this.host.attachShadow({ mode: "open" });
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(STYLE);
		this.root.adoptedStyleSheets = [sheet];
		this.layer = doc.createElement("div");
		this.layer.className = "layer";
		this.layer.hidden = true;
		this.marks = svg(doc, "svg", { class: "marks" });
		this.capture = doc.createElement("div");
		this.capture.className = "capture";
		this.popover = doc.createElement("div");
		this.popover.className = "popover";
		this.popover.hidden = true;
		this.toolbar = doc.createElement("div");
		this.toolbar.className = "toolbar";
		this.toolbar.setAttribute("role", "toolbar");
		this.toolbar.setAttribute("aria-label", "Overmark");
		this.layer.append(this.marks, this.capture, this.popover, this.toolbar);
		this.root.append(this.layer);
		doc.documentElement.append(this.host);
	}

	get visible(): boolean {
		return !this.layer.hidden;
	}

	show(): void {
		this.layer.hidden = false;
		// Stay on top of elements the page appended later.
		if (this.host.nextElementSibling !== null)
			this.doc.documentElement.append(this.host);
		this.onChange?.(true);
	}

	hide(): void {
		this.layer.hidden = true;
		this.onChange?.(false);
	}

	/** Hide everything but the marks while a screenshot is taken. */
	setCapturing(on: boolean): void {
		this.layer.classList.toggle("capturing", on);
	}

	/** Draw the marks, the one being drawn and the hovered element's outline. */
	render(
		marks: readonly RenderedMark[],
		preview: Shape | null,
		hover: Rect | null,
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
		for (const mark of marks)
			children.push(...this.#shape(mark.shape), this.#badge(mark));
		if (preview !== null) children.push(...this.#shape(preview));
		this.marks.replaceChildren(...children);
	}

	#shape(shape: Shape): SVGElement[] {
		const doc = this.doc;
		const stroke = {
			fill: "none",
			stroke: MARK_COLOUR,
			"stroke-width": 3,
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
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
				const angle = Math.atan2(to.y - from.y, to.x - from.x);
				const head = (a: number): Point => ({
					x: to.x - 14 * Math.cos(angle + a),
					y: to.y - 14 * Math.sin(angle + a),
				});
				const l = head(0.45);
				const r = head(-0.45);
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
						fill: MARK_COLOUR,
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

	#badge(mark: RenderedMark): SVGElement {
		const doc = this.doc;
		const at = badgePosition(mark.shape);
		const g = svg(doc, "g", { "data-number": mark.number });
		const r = mark.shape.kind === "note" ? 13 : 11;
		g.append(
			svg(doc, "circle", {
				cx: at.x,
				cy: at.y,
				r,
				fill: MARK_COLOUR,
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

export function badgePosition(shape: Shape): Point {
	switch (shape.kind) {
		case "element":
		case "box":
			return { x: shape.rect.x, y: shape.rect.y };
		case "arrow":
			return shape.from;
		case "pen":
			return shape.points[0] ?? { x: 0, y: 0 };
		case "note":
			return shape.at;
	}
}
