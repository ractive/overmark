import { describe, expect, test } from "bun:test";
import type { Shot } from "../src/lib/case.ts";
import { type AnnotationDraft, type Crop, saveCase } from "../src/lib/save.ts";
import { MemoryStore } from "../src/lib/store.ts";

const page = {
	url: "https://www.example.com/kk",
	title: "KK",
	lang: "de",
	viewport: { width: 1280, height: 800, dpr: 2 },
	userAgent: "test",
};

const shot = (id: string): Shot => ({
	id,
	image: `shots/${id}.webp`,
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

const crops: { rect: unknown; dpr: number }[] = [];
const crop: Crop = async (_image, rect, dpr) => {
	crops.push({ rect, dpr });
	return { blob: new Blob(["crop"]), width: 280, height: 160 };
};

async function withShot(store: MemoryStore, caseId: string, id: string) {
	await store.putImage(caseId, `shots/${id}.webp`, {
		blob: new Blob(["shot"]),
		width: 2560,
		height: 1600,
	});
}

describe("saveCase", () => {
	test("a new case with crops", async () => {
		const store = new MemoryStore();
		await withShot(store, "c_1", "s1");
		const saved = await saveCase(
			store,
			{
				caseId: "c_1",
				isNew: true,
				title: "  Contrast  ",
				page,
				shots: [shot("s1")],
				annotations: [draft(1, "s1"), draft(2, "s1")],
			},
			crop,
			new Date("2026-11-04T12:00:00Z"),
		);
		expect(saved.title).toBe("Contrast");
		expect(saved.annotations.map((a) => a.crop)).toEqual([
			"crops/a1.webp",
			"crops/a2.webp",
		]);
		expect("cropRect" in (saved.annotations[0] ?? {})).toBe(false);
		expect(crops.at(-1)?.dpr).toBe(2);
		expect(await store.getImage("c_1", "crops/a2.webp")).toBeDefined();
		expect((await store.getCase("c_1"))?.createdAt).toBe(
			"2026-11-04T12:00:00.000Z",
		);
	});

	test("adds to an existing case and keeps its verdict", async () => {
		const store = new MemoryStore();
		await withShot(store, "c_1", "s1");
		await saveCase(
			store,
			{
				caseId: "c_1",
				isNew: true,
				title: "One",
				page,
				shots: [shot("s1")],
				annotations: [draft(1, "s1")],
			},
			crop,
		);
		const stored = await store.getCase("c_1");
		if (stored) await store.putCase({ ...stored, verdict: "Fix it" });
		await withShot(store, "c_1", "s2");
		const saved = await saveCase(
			store,
			{
				caseId: "c_1",
				isNew: false,
				title: "",
				page,
				shots: [shot("s2")],
				annotations: [draft(2, "s2")],
			},
			crop,
		);
		expect(saved.title).toBe("One");
		expect(saved.verdict).toBe("Fix it");
		expect(saved.shots.map((s) => s.id)).toEqual(["s1", "s2"]);
		expect(saved.annotations.map((a) => a.number)).toEqual([1, 2]);
	});

	test("a failed save removes the images it added", async () => {
		const store = new MemoryStore();
		await withShot(store, "c_1", "s1");
		await expect(
			saveCase(
				store,
				{
					caseId: "c_1",
					isNew: true,
					title: "x",
					page,
					shots: [shot("s1")],
					annotations: [draft(1, "s1"), draft(1, "s1")], // number used twice
				},
				crop,
			),
		).rejects.toThrow();
		expect(store.images.size).toBe(0);
		expect(await store.getCase("c_1")).toBeUndefined();
	});

	test("refuses to add to a missing case", async () => {
		await expect(
			saveCase(
				new MemoryStore(),
				{
					caseId: "c_9",
					isNew: false,
					title: "",
					page,
					shots: [],
					annotations: [],
				},
				crop,
			),
		).rejects.toThrow("no longer exists");
	});
});
