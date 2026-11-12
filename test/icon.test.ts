import { describe, expect, test } from "bun:test";
import {
	drawSpark,
	iconSwitch,
	SPARK,
	SPARK_GREEN,
	type SparkContext,
} from "../src/worker/icon.ts";

/** Records the points drawn and the paint calls, in order. */
function fake(): SparkContext & {
	points: [number, number][];
	paints: string[];
} {
	const points: [number, number][] = [];
	const paints: string[] = [];
	const c = {
		points,
		paints,
		fillStyle: "" as unknown,
		strokeStyle: "" as unknown,
		lineWidth: 0,
		lineJoin: "" as unknown,
		beginPath() {},
		closePath() {},
		moveTo(x: number, y: number) {
			points.push([x, y]);
		},
		quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
			points.push([cx, cy], [x, y]);
		},
		fill() {
			paints.push(`fill ${String(c.fillStyle)}`);
		},
		stroke() {
			paints.push(`stroke ${String(c.strokeStyle)} ${c.lineWidth}`);
		},
	};
	return c;
}

describe("drawSpark", () => {
	for (const size of [16, 32]) {
		test(`stays inside a ${size} px icon, its white edge included`, () => {
			const c = fake();
			drawSpark(c, size);
			const edge = c.lineWidth / 2;
			for (const [x, y] of c.points) {
				expect(x - edge).toBeGreaterThanOrEqual(-0.01);
				expect(y - edge).toBeGreaterThanOrEqual(-0.01);
				expect(x + edge).toBeLessThanOrEqual(size + 0.01);
				expect(y + edge).toBeLessThanOrEqual(size + 0.01);
			}
		});
	}

	test("the white edges first, then the green stars over them", () => {
		const c = fake();
		drawSpark(c, 32);
		const n = SPARK.length;
		expect(
			c.paints.slice(0, n).every((p) => p.startsWith("stroke #ffffff")),
		).toBe(true);
		expect(c.paints.slice(n)).toEqual(Array(n).fill(`fill ${SPARK_GREEN}`));
	});
});

describe("iconSwitch", () => {
	const image = {} as ImageData;

	function fakeDeps(fail = { sparked: 0, setIcon: 0 }) {
		const set: string[] = [];
		const shown: boolean[] = [];
		const deps = {
			set,
			shown: (on: boolean) => shown.push(on),
			shownList: shown,
			sparked: async () => {
				if (fail.sparked-- > 0) throw new Error("no bitmap");
				return { 16: image, 32: image };
			},
			plain: () => ({ "16": "icons/icon-16.png", "48": "icons/icon-48.png" }),
			setIcon: async (d: chrome.action.TabIconDetails) => {
				if (fail.setIcon-- > 0) throw new Error("no icon");
				set.push("imageData" in d && d.imageData ? "spark" : "plain");
			},
		};
		return deps;
	}

	test("a repeat does nothing; off restores the manifest's sizes", async () => {
		const deps = fakeDeps();
		let path: unknown;
		const show = iconSwitch({
			...deps,
			setIcon: async (d) => {
				path = d.path;
				await deps.setIcon(d);
			},
		});
		await show(true);
		await show(true);
		await show(false);
		expect(deps.set).toEqual(["spark", "plain"]);
		expect(path).toEqual({
			"16": "icons/icon-16.png",
			"48": "icons/icon-48.png",
		});
		expect(deps.shownList).toEqual([true, false]);
	});

	test("the latest call wins over one still drawing", async () => {
		const deps = fakeDeps();
		const show = iconSwitch(deps);
		const first = show(true);
		await show(false);
		await show(true);
		await first;
		expect(deps.set).toEqual(["plain", "spark"]);
	});

	test("a failure is tried again at the next call", async () => {
		const deps = fakeDeps({ sparked: 1, setIcon: 0 });
		const show = iconSwitch(deps);
		const warn = console.warn;
		console.warn = () => {};
		try {
			await show(true);
			expect(deps.set).toEqual([]);
			await show(true);
			expect(deps.set).toEqual(["spark"]);
		} finally {
			console.warn = warn;
		}
	});
});
