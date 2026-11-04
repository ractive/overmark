import { describe, expect, test } from "bun:test";
import { planShots } from "../src/content/plan.ts";

const viewport = { width: 1000, height: 800 };
const page = { width: 1000, height: 3000 };
const r = (y: number, height = 40, x = 100, width = 200) => ({
	x,
	y,
	width,
	height,
});

describe("planShots", () => {
	test("marks that fit one viewport share a screenshot", () => {
		expect(
			planShots([r(100), r(500), r(300)], viewport, page, { x: 0, y: 1500 }),
		).toEqual([{ scrollX: 0, scrollY: 76, marks: [0, 2, 1] }]);
	});

	test("marks far apart get their own screenshots", () => {
		expect(
			planShots([r(2000), r(100)], viewport, page, { x: 0, y: 1500 }),
		).toEqual([
			{ scrollX: 0, scrollY: 76, marks: [1] },
			{ scrollX: 0, scrollY: 1500, marks: [0] },
		]);
	});

	test("the last window stops at the end of the page", () => {
		expect(planShots([r(2900, 50)], viewport, page, { x: 0, y: 1500 })).toEqual(
			[{ scrollX: 0, scrollY: 2200, marks: [0] }],
		);
	});

	test("marks visible now are taken without scrolling", () => {
		expect(
			planShots([r(100), r(2000), r(700), r(780)], viewport, page, {
				x: 0,
				y: 0,
			}),
		).toEqual([
			{ scrollX: 0, scrollY: 0, marks: [0, 2] },
			{ scrollX: 0, scrollY: 756, marks: [3] },
			{ scrollX: 0, scrollY: 1976, marks: [1] },
		]);
	});

	test("a mark outside the horizontal view moves the window sideways", () => {
		const wide = { width: 3000, height: 3000 };
		expect(
			planShots([r(100, 40, 2500, 100)], viewport, wide, { x: 0, y: 1500 }),
		).toEqual([{ scrollX: 2000, scrollY: 76, marks: [0] }]);
	});
});
