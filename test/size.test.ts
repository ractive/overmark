import { expect, test } from "bun:test";
import {
	cssSize,
	onScreen,
	sameSize,
	windowFor,
} from "../src/sidepanel/size.ts";

test("a zoomed tab has fewer CSS pixels than screen pixels", () => {
	expect(cssSize({ width: 1500, height: 900 }, 1.5)).toEqual({
		width: 1000,
		height: 600,
	});
	expect(cssSize({ width: 1500, height: 900 }, 0)).toEqual({
		width: 1500,
		height: 900,
	});
});

test("a pixel or two off is the same size", () => {
	expect(
		sameSize({ width: 1656, height: 1314 }, { width: 1657, height: 1312 }),
	).toBe(true);
	expect(
		sameSize({ width: 1656, height: 1314 }, { width: 1280, height: 1314 }),
	).toBe(false);
});

test("the window grows by what the tab lacks, the panel keeps its room", () => {
	// A 1600 px window: a 400 px side panel and a 1200 px tab.
	expect(
		windowFor(
			{ width: 1656, height: 1314 },
			{ width: 1200, height: 800 },
			{ width: 1600, height: 900 },
			1,
		),
	).toEqual({ width: 2056, height: 1414 });
	// At 125% the tab needs 1.25 screen pixels per CSS pixel.
	expect(
		windowFor(
			{ width: 800, height: 600 },
			{ width: 1200, height: 800 },
			{ width: 1600, height: 900 },
			1.25,
		),
	).toEqual({ width: 1400, height: 850 });
});

test("a window larger than the screen is no larger and moves onto it", () => {
	const screen = { left: 0, top: 25, width: 1512, height: 920 };
	expect(
		onScreen({ width: 2056, height: 1414 }, { left: 300, top: 100 }, screen),
	).toEqual({ left: 0, top: 25, width: 1512, height: 920 });
	expect(
		onScreen({ width: 1000, height: 700 }, { left: 900, top: 100 }, screen),
	).toEqual({ left: 512, top: 100, width: 1000, height: 700 });
	// A second screen to the left.
	expect(
		onScreen(
			{ width: 800, height: 600 },
			{ left: -2000, top: 0 },
			{ left: -1920, top: 0, width: 1920, height: 1080 },
		),
	).toEqual({ left: -1920, top: 0, width: 800, height: 600 });
});
