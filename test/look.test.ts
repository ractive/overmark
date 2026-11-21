/**
 * A mark's look (DEC-048): the colour behind an element and its contrast,
 * the siblings' boxes, what a case keeps of it, how the tools write it, and
 * that a page's candidates never carry it. The styles themselves need a real
 * browser's computed values: `test/e2e/capture.test.ts`.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
	type ElementDetails,
	lookOf,
	namesUrl,
	validateCase,
	withoutLook,
} from "../src/lib/case.ts";
import { contrastRatio, parseColor } from "../src/lib/colour.ts";
import {
	backdropLine,
	createContext,
	describeElement,
	lookSummary,
	siblingLine,
	stylesLine,
} from "../src/lib/element.ts";
import { backdropOf, siblingsOf, withLook } from "../src/lib/look.ts";
import { sampleCase, withOneMark } from "./fixtures.ts";

let doc: Document;

beforeEach(() => {
	const window = new Window({ url: "https://shop.example/" });
	doc = window.document as unknown as Document;
});

const element: ElementDetails = {
	tag: "a",
	classes: ["pp-btn"],
	attributes: {},
	ancestors: [],
	rect: { x: 24, y: 310, width: 96, height: 40 },
	page: { width: 1280, height: 3000 },
	selector: "a.pp-btn",
};

describe("colours", () => {
	test("as the browser computes them", () => {
		expect(parseColor("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
		expect(parseColor("rgba(1, 2, 3, 0.5)")).toEqual({
			r: 1,
			g: 2,
			b: 3,
			a: 0.5,
		});
		expect(parseColor("rgb(1 2 3 / 25%)")?.a).toBe(0.25);
		expect(parseColor("transparent")?.a).toBe(0);
		expect(parseColor("oklch(0.7 0.1 120)")).toBeUndefined();
	});

	test("contrast as WCAG counts it, a translucent text laid over its background", () => {
		expect(contrastRatio("rgb(0, 0, 0)", "rgb(255, 255, 255)")).toBeCloseTo(
			21,
			5,
		);
		// The demo's Book link: amber on amber.
		expect(
			contrastRatio("rgb(245, 207, 88)", "rgb(242, 194, 48)"),
		).toBeLessThan(1.2);
		expect(
			contrastRatio("rgba(0, 0, 0, 0.5)", "rgb(255, 255, 255)"),
		).toBeCloseTo(
			contrastRatio("rgb(128, 128, 128)", "rgb(255, 255, 255)") ?? 0,
			1,
		);
		expect(contrastRatio("rgb(0, 0, 0)", "rgba(0, 0, 0, 0.5)")).toBeUndefined();
	});
});

describe("the colour behind an element", () => {
	test("its own when opaque; else composited up to an opaque one; the canvas under all", () => {
		doc.body.innerHTML = `
			<section style="background-color: rgb(0, 0, 255)">
				<div style="background-color: rgba(255, 255, 255, 0.5)">
					<a id="a">Book</a>
					<b id="b" style="background-color: rgb(1, 2, 3)">B</b>
				</div>
			</section>
			<p id="c">On nothing</p>
			<p id="d" style="background-image: linear-gradient(red, blue)">Over a gradient</p>`;
		expect(backdropOf(doc.getElementById("b") as Element)).toEqual({
			color: "rgb(1, 2, 3)",
			depth: 0,
		});
		// Half white over blue, two steps up.
		expect(backdropOf(doc.getElementById("a") as Element)).toEqual({
			color: "rgb(128, 128, 255)",
			depth: 2,
		});
		expect(backdropOf(doc.getElementById("c") as Element)).toEqual({
			color: "rgb(255, 255, 255)",
		});
		expect(backdropOf(doc.getElementById("d") as Element)).toEqual({
			color: "rgb(255, 255, 255)",
			image: true,
		});
	});
});

describe("the siblings' boxes", () => {
	test("up to three on each side with a box, nearest first, never the overlay", () => {
		doc.body.innerHTML = `<ul>${Array.from({ length: 9 }, (_, i) => `<li id="l${i}">${i}</li>`).join("")}<div id="overlay"></div></ul>`;
		const boxes = new Map<string, number>([
			["l0", 10],
			["l1", 20],
			["l2", 30],
			["l3", 40],
			["l5", 60],
			["l7", 80],
			["l8", 90],
			["overlay", 100],
		]);
		for (const el of doc.querySelectorAll("li, div"))
			(
				el as unknown as { getBoundingClientRect: () => DOMRect }
			).getBoundingClientRect = () => {
				const y = boxes.get(el.id) ?? 0;
				return {
					x: 0,
					y,
					width: y === 0 ? 0 : 50,
					height: y === 0 ? 0 : 10,
				} as DOMRect;
			};
		const marked = doc.getElementById("l4") as Element;
		const overlay = doc.getElementById("overlay") as Element;
		const siblings = siblingsOf(marked, { x: 0, y: 100 }, overlay);
		// l6 has no box; l8 is the third after it, the overlay is not one.
		expect(siblings?.map((s) => [s.offset, s.tag, s.rect.y])).toEqual([
			[-3, "li", 120],
			[-2, "li", 130],
			[-1, "li", 140],
			[1, "li", 160],
			[3, "li", 180],
			[4, "li", 190],
		]);
		expect(siblingsOf(doc.documentElement, { x: 0, y: 0 })).toBeUndefined();
	});
});

describe("on a page's candidates, never", () => {
	test("describing an element records no look; only withLook adds it", () => {
		doc.body.innerHTML = `<p style="background-color: rgb(1, 2, 3)"><a id="a" class="Button_main">Book</a> <b>x</b></p>`;
		const a = doc.getElementById("a") as Element;
		const context = createContext(doc);
		for (const d of [
			describeElement(a, context),
			describeElement(a, context, { selector: false }),
		])
			for (const key of ["styles", "backdrop", "siblings"])
				expect(key in d).toBe(false);
		const looked = withLook(describeElement(a, context), a, { x: 0, y: 0 });
		expect(looked.backdrop).toEqual({ color: "rgb(1, 2, 3)", depth: 1 });
	});
});

describe("what a case keeps of a look", () => {
	test("what the server keeps; the rest left out, never a failed import", () => {
		expect(
			lookOf({
				styles: {
					color: "red",
					"-webkit-line-clamp": "2",
					"--brand": "#0a7",
					Color: "blue",
					cursor: "url(x.cur)",
					"background-image": "\\75rl(x.png)",
					content: '"img/a.png"',
					"font-family": '"Inter", sans-serif',
					height: "x".repeat(301),
					width: " ",
				},
				backdrop: { color: "rgb(1, 2, 3)", depth: 1.5, image: "yes" },
				siblings: [
					{ offset: 0, tag: "li", rect: { x: 0, y: 0, width: 1, height: 1 } },
					{ offset: 1, tag: "<li>", rect: { x: 0, y: 0, width: 1, height: 1 } },
					{ offset: 2, tag: "li", rect: { x: 0, y: 0, width: 1 } },
					{ offset: -1, tag: "li", rect: { x: 0, y: 0, width: 1, height: 1 } },
				],
			}),
		).toEqual({
			styles: {
				color: "red",
				"-webkit-line-clamp": "2",
				"font-family": '"Inter", sans-serif',
			},
			backdrop: { color: "rgb(1, 2, 3)" },
			siblings: [
				{ offset: -1, tag: "li", rect: { x: 0, y: 0, width: 1, height: 1 } },
			],
		});
		expect(namesUrl("u/**/rl(x)")).toBe(true);
		expect(namesUrl('-webkit-image-set("a.png" 1x)')).toBe(true);
		expect(namesUrl("rgb(1, 2, 3)")).toBe(false);
		const many = Object.fromEntries(
			Array.from({ length: 45 }, (_, i) => [`p${i}`, "1px"]),
		);
		expect(Object.keys(lookOf({ styles: many }).styles ?? {})).toHaveLength(40);

		// A file with a look: kept as far as it is within the rules; a bad
		// entry is left out and the case imports.
		const c = withOneMark(sampleCase("c_look", "2026-11-21T10:00:00.000Z"));
		const first = c.annotations[0];
		if (first === undefined) throw new Error("the sample has a mark");
		const file = {
			...c,
			annotations: [
				{
					...first,
					element: {
						...element,
						styles: { color: "red", cursor: "url(x)" },
						backdrop: { color: "url(x)" },
						siblings: "not a list",
					},
				},
				...c.annotations.slice(1),
			],
		};
		const read = validateCase(JSON.parse(JSON.stringify(file)));
		expect(read.annotations[0]?.element).toEqual({
			...element,
			styles: { color: "red" },
		});
		expect(withoutLook({ ...element, styles: { color: "red" } })).toEqual(
			element,
		);
	});
});

describe("how the tools and case.md write a look", () => {
	test("one line each; the few values first, with the contrast", () => {
		const looked: ElementDetails = {
			...element,
			styles: {
				color: "rgb(245, 207, 88)",
				"font-family": '"Inter", system-ui',
				"font-size": "16px",
				"line-height": "24px",
				"font-weight": "700",
				display: "inline-block",
			},
			backdrop: { color: "rgb(242, 194, 48)", depth: 0 },
			siblings: [
				{
					offset: -1,
					tag: "p",
					rect: { x: 24, y: 260.333, width: 300, height: 40 },
				},
			],
		};
		expect(stylesLine(looked.styles ?? {})).toBe(
			'color: rgb(245, 207, 88); font-family: "Inter", system-ui; font-size: 16px; line-height: 24px; font-weight: 700; display: inline-block',
		);
		expect(backdropLine({ color: "rgb(1, 2, 3)", depth: 2, image: true })).toBe(
			"rgb(1, 2, 3), 2 up; a background image or gradient on the way may show instead",
		);
		expect(backdropLine({ color: "rgb(1, 2, 3)" })).toBe(
			"rgb(1, 2, 3), the page's canvas",
		);
		expect(siblingLine(looked.siblings?.[0] as never)).toBe(
			"-1 p 300×40 at 24, 260.33",
		);
		expect(lookSummary(looked)).toBe(
			'rgb(245, 207, 88) on rgb(242, 194, 48), contrast 1.11:1 · 16px/24px 700 "Inter" · inline-block',
		);
		expect(lookSummary(element)).toBeUndefined();
	});
});
