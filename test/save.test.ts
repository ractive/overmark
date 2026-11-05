import { describe, expect, test } from "bun:test";
import { pendingImage, type Shot } from "../src/lib/case.ts";
import type { Draw } from "../src/lib/save.ts";
import {
	type AnnotationDraft,
	type Crop,
	type SaveRequest,
	saveCase,
} from "../src/lib/save.ts";
import { MemoryStore } from "../src/lib/store.ts";

const page = {
	url: "https://www.example.com/kk",
	title: "KK",
	lang: "de",
	viewport: { width: 1280, height: 800, dpr: 2 },
	userAgent: "test",
};

/** A shot with a provisional id, as the content script sends it. */
const shot = (id: string): Shot => ({
	id,
	image: pendingImage(id),
	scrollX: 0,
	scrollY: 0,
	viewport: { width: 1280, height: 800, dpr: 2 },
	capturedAt: "2026-11-04T10:00:00Z",
});

const draft = (n: number, shotId: string): AnnotationDraft => ({
	id: `a${n}`,
	number: n,
	shot: shotId,
	comment: `comment ${n}`,
	author: "user",
	shape: { kind: "box", rect: { x: 10, y: 10, width: 100, height: 40 } },
	element: null,
	cropRect: { x: 0, y: 0, width: 140, height: 80 },
});

let decodes = 0;
const crop: Crop = async (_image, rects) => {
	decodes++;
	return rects.map(() => ({
		blob: new Blob(["crop"]),
		width: 280,
		height: 160,
	}));
};

async function captured(store: MemoryStore, caseId: string, shotId: string) {
	await store.putImage(caseId, pendingImage(shotId), {
		blob: new Blob([`shot ${shotId}`]),
		width: 2560,
		height: 1600,
	});
}

function request(
	caseId: string,
	isNew: boolean,
	shots: Shot[],
	annotations: AnnotationDraft[],
): SaveRequest {
	return { caseId, isNew, title: "One", page, shots, annotations };
}

async function newCase(store: MemoryStore) {
	await captured(store, "c_1", "p_a");
	return saveCase(
		store,
		request("c_1", true, [shot("p_a")], [draft(1, "p_a"), draft(2, "p_a")]),
		crop,
	);
}

const keys = (store: MemoryStore) => [...store.images.keys()].sort();

describe("saveCase", () => {
	test("a new case: final shot ids, crops, one decode per screenshot, no pending images left", async () => {
		const store = new MemoryStore();
		await captured(store, "c_1", "p_a");
		const before = decodes;
		const saved = await saveCase(
			store,
			{
				...request(
					"c_1",
					true,
					[shot("p_a")],
					[draft(1, "p_a"), draft(2, "p_a")],
				),
				title: "  Contrast  ",
			},
			crop,
			new Date("2026-11-04T12:00:00Z"),
		);
		expect(decodes - before).toBe(1);
		expect(saved.title).toBe("Contrast");
		expect(saved.shots.map((s) => [s.id, s.image])).toEqual([
			["s1", "shots/s1.webp"],
		]);
		expect(saved.annotations.map((a) => [a.shot, a.crop])).toEqual([
			["s1", "crops/a1.webp"],
			["s1", "crops/a2.webp"],
		]);
		expect("cropRect" in (saved.annotations[0] ?? {})).toBe(false);
		expect(keys(store)).toEqual([
			"c_1/crops/a1.webp",
			"c_1/crops/a2.webp",
			"c_1/shots/s1.webp",
		]);
		expect((await store.getCase("c_1"))?.createdAt).toBe(
			"2026-11-04T12:00:00.000Z",
		);
	});

	test("adding to a case keeps its title and verdict and numbers shots on", async () => {
		const store = new MemoryStore();
		await newCase(store);
		await store.updateCase("c_1", (c) => ({
			value: { ...(c as NonNullable<typeof c>), verdict: "Fix it" },
		}));
		await captured(store, "c_1", "p_b");
		const saved = await saveCase(
			store,
			{
				...request("c_1", false, [shot("p_b")], [draft(3, "p_b")]),
				title: "x",
			},
			crop,
		);
		expect(saved.title).toBe("One");
		expect(saved.verdict).toBe("Fix it");
		expect(saved.shots.map((s) => s.id)).toEqual(["s1", "s2"]);
		expect(saved.annotations.map((a) => [a.number, a.shot])).toEqual([
			[1, "s1"],
			[2, "s1"],
			[3, "s2"],
		]);
	});

	test("a verdict saved while the crops are cut is kept", async () => {
		const store = new MemoryStore();
		await newCase(store);
		await captured(store, "c_1", "p_b");
		const slowCrop: Crop = async (image, rects, dpr) => {
			await store.updateCase("c_1", (c) => ({
				value: { ...(c as NonNullable<typeof c>), verdict: "Agreed meanwhile" },
			}));
			return crop(image, rects, dpr);
		};
		const saved = await saveCase(
			store,
			request("c_1", false, [shot("p_b")], [draft(3, "p_b")]),
			slowCrop,
		);
		expect(saved.verdict).toBe("Agreed meanwhile");
		expect((await store.getCase("c_1"))?.annotations).toHaveLength(3);
	});

	test("a number the case has already is refused without touching its images", async () => {
		const store = new MemoryStore();
		await newCase(store);
		const before = new Map(store.images);
		await captured(store, "c_1", "p_b");
		await expect(
			saveCase(
				store,
				request("c_1", false, [shot("p_b")], [draft(1, "p_b")]),
				crop,
			),
		).rejects.toThrow("mark 1 exists in the case already");
		// The very same image objects: an overwrite with equal-looking crops
		// would pass a deep comparison.
		for (const [key, image] of before)
			expect(store.images.get(key)).toBe(image);
		// Only the new screenshot is added, pending: the marks can be saved again.
		expect([...store.images.keys()].sort()).toEqual(
			[...before.keys(), "c_1/pending/p_b.webp"].sort(),
		);
		expect((await store.getCase("c_1"))?.annotations).toHaveLength(2);
	});

	test("a number used twice in one save is refused and stores no case", async () => {
		const store = new MemoryStore();
		await captured(store, "c_1", "p_a");
		await expect(
			saveCase(
				store,
				request("c_1", true, [shot("p_a")], [draft(1, "p_a"), draft(1, "p_a")]),
				crop,
			),
		).rejects.toThrow();
		expect([...store.images.keys()]).toEqual(["c_1/pending/p_a.webp"]);
		expect(await store.getCase("c_1")).toBeUndefined();
	});

	test("refuses to add to a missing case, or to overwrite one as new", async () => {
		const store = new MemoryStore();
		await expect(
			saveCase(store, request("c_9", false, [], []), crop),
		).rejects.toThrow("no longer exists");
		await newCase(store);
		await captured(store, "c_1", "p_b");
		await expect(
			saveCase(
				store,
				request("c_1", true, [shot("p_b")], [draft(5, "p_b")]),
				crop,
			),
		).rejects.toThrow("exists already");
		// The marks can be saved again: their screenshot must still be there.
		expect(store.images.has("c_1/pending/p_b.webp")).toBe(true);
	});

	test("reads pending screenshots from imagesFrom and draws the marks on them", async () => {
		const store = new MemoryStore();
		await captured(store, "c_session", "p_a");
		const drawn: number[][] = [];
		const draw: Draw = async (image, marks) => {
			drawn.push(marks.map((m) => m.number));
			return { blob: image, width: 1, height: 1 };
		};
		const saved = await saveCase(
			store,
			{
				...request(
					"c_1",
					true,
					[shot("p_a")],
					[draft(1, "p_a"), draft(2, "p_a")],
				),
				imagesFrom: "c_session",
			},
			crop,
			new Date(),
			draw,
		);
		expect(saved.id).toBe("c_1");
		expect(drawn).toEqual([[1, 2]]);
		expect(store.images.has("c_session/pending/p_a.webp")).toBe(false);
		expect(store.images.has("c_1/shots/s1.webp")).toBe(true);
	});

	test("a missing screenshot fails the save", async () => {
		await expect(
			saveCase(
				new MemoryStore(),
				request("c_1", true, [shot("p_a")], [draft(1, "p_a")]),
				crop,
			),
		).rejects.toThrow("the screenshot p_a is missing");
	});
});
