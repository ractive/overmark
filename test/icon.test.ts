import { describe, expect, test } from "bun:test";
import {
	drawSpark,
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
