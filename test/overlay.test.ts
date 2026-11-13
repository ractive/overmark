/**
 * How the overlay draws on the page (DEC-024): every stroke with a white
 * casing under it, a loaded mark's colour its status and its dash the match.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Shape } from "../src/lib/case.ts";
import { MARK_COLOUR } from "../src/lib/marks.ts";

const window = new Window({ url: "https://www.example.com/kk" });
const globals = globalThis as unknown as Record<string, unknown>;
const before = {
	document: globals["document"],
	CSSStyleSheet: globals["CSSStyleSheet"],
};
let o: typeof import("../src/content/overlay.ts");
let overlay: InstanceType<
	typeof import("../src/content/overlay.ts")["Overlay"]
>;

beforeAll(async () => {
	globals["document"] = window.document;
	globals["CSSStyleSheet"] = window.CSSStyleSheet;
	o = await import("../src/content/overlay.ts");
	overlay = new o.Overlay(window.document as unknown as Document);
});

afterAll(() => {
	overlay.setReviewing(false);
	overlay.setAnnotating(false);
	globals["document"] = before.document;
	globals["CSSStyleSheet"] = before.CSSStyleSheet;
});

const rect = { x: 10, y: 20, width: 100, height: 40 };
const SHAPES: Shape[] = [
	{ kind: "element", rect },
	{ kind: "box", rect },
	{ kind: "arrow", from: { x: 0, y: 0 }, to: { x: 50, y: 50 } },
	{
		kind: "pen",
		points: [
			{ x: 0, y: 0 },
			{ x: 5, y: 9 },
			{ x: 12, y: 4 },
		],
	},
];

/** A shape's parts in a group, without its pin: [tag, casing?, stroke, width, dash]. */
const parts = (group: Element) =>
	[...group.querySelectorAll("rect, line, polygon, polyline")]
		.filter((e) => !e.hasAttribute("data-element"))
		.map((e) => ({
			tag: e.tagName.toLowerCase(),
			casing: e.hasAttribute("data-casing"),
			stroke: e.getAttribute("stroke"),
			fill: e.getAttribute("fill"),
			width: Number(e.getAttribute("stroke-width")),
			dash: e.getAttribute("stroke-dasharray"),
		}));

const item = (
	number: number,
	shape: Shape,
	change: Partial<import("../src/content/overlay.ts").ReviewItem> = {},
) => ({
	number,
	shape,
	rect: null,
	found: true,
	focused: false,
	resolved: false,
	...change,
});

describe("a mark on the page", () => {
	test("each stroke is drawn twice: a white casing 3 px wider, then the colour", () => {
		overlay.renderReview(SHAPES.map((shape, i) => item(i + 1, shape)));
		for (const [i, shape] of SHAPES.entries()) {
			const group = overlay.marks.querySelector(
				`[data-review="${i + 1}"]`,
			) as Element;
			const drawn = parts(group);
			const casings = drawn.filter((p) => p.casing);
			const strokes = drawn.filter((p) => !p.casing);
			expect(casings.length).toBe(strokes.length);
			expect(casings.length).toBe(shape.kind === "arrow" ? 2 : 1);
			// The casing lies under the colour.
			expect(drawn.findLastIndex((p) => p.casing)).toBeLessThan(
				drawn.findIndex((p) => !p.casing),
			);
			for (const c of casings) {
				expect(c.stroke).toBe(o.PAGE_LOOK.casing);
				expect(c.dash).toBeNull();
			}
			const line = strokes.find((p) => p.tag !== "polygon");
			const under = casings.find((p) => p.tag === line?.tag);
			expect(line?.stroke).toBe(MARK_COLOUR);
			expect(under?.width).toBe((line?.width ?? 0) + o.CASING_EXTRA);
			// The pin keeps its white ring.
			const pin = group.querySelector("[data-number] circle");
			expect(pin?.getAttribute("stroke")).toBe(o.PAGE_LOOK.casing);
			expect(pin?.getAttribute("fill")).toBe(MARK_COLOUR);
		}
	});

	test("an arrow's head has its casing too: white, with a white edge", () => {
		overlay.renderReview([item(1, SHAPES[2] as Shape)]);
		const heads = parts(
			overlay.marks.querySelector('[data-review="1"]') as Element,
		).filter((p) => p.tag === "polygon");
		expect(heads.map((p) => [p.casing, p.fill])).toEqual([
			[true, o.PAGE_LOOK.casing],
			[false, MARK_COLOUR],
		]);
	});

	test("a note is its pin alone", () => {
		overlay.renderReview([item(1, { kind: "note", at: { x: 5, y: 5 } })]);
		const group = overlay.marks.querySelector('[data-review="1"]') as Element;
		expect(parts(group)).toEqual([]);
		expect(group.querySelector("[data-number]")).not.toBeNull();
	});

	test("the colour is the status: open as on the screenshot, settled grey", () => {
		expect(o.reviewColour({ resolved: false })).toBe(MARK_COLOUR);
		expect(o.reviewColour({ resolved: true })).toBe(o.STATUS_COLOUR.closed);
		overlay.renderReview([
			item(1, SHAPES[0] as Shape),
			item(2, SHAPES[0] as Shape, { resolved: true }),
		]);
		const colour = (n: number) =>
			parts(overlay.marks.querySelector(`[data-review="${n}"]`) as Element)
				.filter((p) => !p.casing)
				.map((p) => p.stroke);
		expect(colour(1)).toEqual([MARK_COLOUR]);
		expect(colour(2)).toEqual([o.STATUS_COLOUR.closed]);
	});

	test("the dash is the match: solid when found, dashed when unsure, whatever the status", () => {
		expect(o.reviewStroke({ found: true, focused: false })).toEqual({
			"stroke-width": 3,
		});
		expect(o.reviewStroke({ found: false, focused: true })).toEqual({
			"stroke-width": 4,
			"stroke-dasharray": "8 5",
			"stroke-linecap": "butt",
		});
		overlay.renderReview([
			item(1, SHAPES[0] as Shape),
			item(2, SHAPES[0] as Shape, { found: false }),
			item(3, SHAPES[0] as Shape, { found: false, resolved: true }),
		]);
		const dash = (n: number) =>
			parts(overlay.marks.querySelector(`[data-review="${n}"]`) as Element).map(
				(p) => [p.casing, p.dash],
			);
		expect(dash(1)).toEqual([
			[true, null],
			[false, null],
		]);
		// The casing stays whole under the dashes.
		expect(dash(2)).toEqual([
			[true, null],
			[false, "8 5"],
		]);
		expect(dash(3)).toEqual(dash(2));
	});

	test("a settled mark's shape is faded with its casing, its pin solid; focused, it shows fully", () => {
		overlay.renderReview([
			item(1, SHAPES[0] as Shape, { resolved: true }),
			item(2, SHAPES[0] as Shape, { resolved: true, focused: true, rect }),
		]);
		const one = overlay.marks.querySelector('[data-review="1"]') as Element;
		const faded = one.querySelector("[data-faded]") as Element;
		expect(faded.getAttribute("opacity")).toBe(String(o.RESOLVED_OPACITY));
		expect(o.RESOLVED_OPACITY).toBe(0.35);
		expect(faded.querySelectorAll("rect").length).toBe(2);
		expect(faded.querySelector("[data-number]")).toBeNull();
		expect(one.querySelector("[data-number]")).not.toBeNull();
		const two = overlay.marks.querySelector('[data-review="2"]') as Element;
		expect(two.querySelector("[data-faded]")).toBeNull();
		// Its element's outline has a casing as well.
		const outline = two.querySelector("[data-element]") as Element;
		expect(outline.previousElementSibling?.hasAttribute("data-casing")).toBe(
			true,
		);
	});

	test("drafts and the hover outline are cased too", () => {
		overlay.render(
			[{ number: 1, shape: SHAPES[1] as Shape }],
			SHAPES[3] as Shape,
			rect,
		);
		const drafts = overlay.marks.querySelector(".drafts") as Element;
		const hover = [...drafts.querySelectorAll("rect.hover")];
		expect(hover.map((e) => e.hasAttribute("data-casing"))).toEqual([
			true,
			false,
		]);
		expect(hover[1]?.getAttribute("stroke")).toBe(o.HOVER_COLOUR);
		const rest = parts(drafts).filter((p) => p.stroke !== o.HOVER_COLOUR);
		// The hover's casing, the box twice, the pen being drawn twice.
		expect(rest.map((p) => [p.tag, p.casing])).toEqual([
			["rect", true],
			["rect", true],
			["rect", false],
			["polyline", true],
			["polyline", false],
		]);
	});
});

describe("the overlay's style", () => {
	test("one fixed look: the bars' ring, a light popover, two rows on purpose, forced colours", async () => {
		const source = await Bun.file(
			new URL("../src/content/overlay.ts", import.meta.url),
		).text();
		// A white ring before the drop shadow, on the three of them.
		expect(source).toContain(
			'const RING = "0 0 0 1px rgba(255, 255, 255, 0.75)";',
		);
		expect(source.match(/box-shadow: \$\{SHADOW\};/g)?.length).toBe(3);
		expect(source).toContain("color-scheme: light;");
		expect(source).toContain("@media (forced-colors: active)");
		expect(source).toContain("background: Highlight;");
		expect(source).toMatch(/@media \(max-width: \$\{TWO_ROWS_BELOW - 1\}px\)/);
		expect(o.TWO_ROWS_BELOW).toBeGreaterThan(o.TOOL_ICONS_BELOW);
		expect(o.TOOL_ICONS_BELOW).toBeGreaterThan(o.ALL_ICONS_BELOW);
		expect(o.ALL_ICONS_BELOW).toBeGreaterThan(o.TIGHT_BELOW);
	});
});
