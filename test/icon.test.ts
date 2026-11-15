import { describe, expect, test } from "bun:test";
import type { SyncStatus } from "../src/lib/sync.ts";
import { badgeOf, decideBadge } from "../src/worker/badge.ts";
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

describe("the badge (DEC-025)", () => {
	const off = { questions: 0, ai: "off" } as const;
	const paused = (reason: "access" | "downloads"): SyncStatus => ({
		folderId: "f",
		state: "paused",
		reason,
	});
	const failed: SyncStatus = { folderId: "f", state: "failed", problem: "x" };

	test("paused, the folder: amber “!” with dark text, and why", () => {
		expect(decideBadge(off, paused("access"))).toEqual({
			text: "!",
			color: "#ffb000",
			textColor: "#1b2130",
			title: "Sitegloss: sync is paused. Click to allow access.",
			spark: false,
		});
	});

	test("paused, the downloads: the same “!”, another title", () => {
		const b = decideBadge(off, paused("downloads"));
		expect([b.text, b.color]).toEqual(["!", "#ffb000"]);
		expect(b.title).toBe(
			"Sitegloss: sync is paused. Click to allow downloads.",
		);
	});

	test("failed: red “!” with white text", () => {
		const b = decideBadge(off, failed);
		expect([b.text, b.color, b.textColor]).toEqual(["!", "#b3261e", "#ffffff"]);
		expect(b.title).toContain("sync failed");
	});

	test("syncing, synced or off: no badge", () => {
		for (const s of [
			undefined,
			{ folderId: "f", state: "syncing", left: 2 },
			{ folderId: "f", state: "synced" },
		] as const) {
			const b = decideBadge(off, s);
			expect([b.text, b.title]).toEqual(["", "Sitegloss"]);
		}
	});

	test("a question waiting wins over the sync: it needs an answer now", () => {
		const b = decideBadge({ questions: 1, ai: "connected" }, failed);
		expect(b.text).toBe("?");
		expect(b.title).toContain("an AI app asks");
	});

	test("the sync's “!” wins over connecting; the spark stays beside it", () => {
		expect(decideBadge({ questions: 0, ai: "connecting" }, failed).text).toBe(
			"!",
		);
		const b = decideBadge({ questions: 0, ai: "connected" }, paused("access"));
		expect([b.text, b.spark]).toEqual(["!", true]);
		expect(b.title).toBe(
			"Sitegloss: sync is paused. Click to allow access. AI access is on.",
		);
	});

	test("set again when either part changes, and cleared with the state", () => {
		const shown: string[] = [];
		const badge = badgeOf({ apply: (b) => shown.push(b.text) });
		badge.sync(paused("access"));
		badge.ai({ questions: 1, ai: "connected" });
		badge.ai({ questions: 0, ai: "connected" });
		badge.sync(undefined);
		expect(shown).toEqual(["!", "?", "!", ""]);
	});
});
