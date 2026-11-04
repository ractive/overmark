import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../src/lib/store.ts";
import { sampleCase } from "./fixtures.ts";

const image = { blob: new Blob(["x"]), width: 1, height: 1 };

describe("MemoryStore", () => {
	test("lists newest first and returns copies", async () => {
		const store = new MemoryStore();
		await store.putCase(sampleCase("c_1", "2026-11-04T10:00:00Z"));
		await store.putCase(sampleCase("c_2", "2026-11-04T11:00:00Z"));
		expect((await store.listCases()).map((c) => c.id)).toEqual(["c_2", "c_1"]);
		const copy = await store.getCase("c_1");
		if (copy) copy.title = "changed";
		expect((await store.getCase("c_1"))?.title).toBe("Button contrast");
	});

	test("deleting a case deletes its images only", async () => {
		const store = new MemoryStore();
		await store.putImage("c_1", "shots/s1.webp", image);
		await store.putImage("c_10", "shots/s1.webp", image);
		await store.deleteCase("c_1");
		expect(await store.getImage("c_1", "shots/s1.webp")).toBeUndefined();
		expect(await store.getImage("c_10", "shots/s1.webp")).toBeDefined();
	});

	test("prunes images a case no longer references", async () => {
		const store = new MemoryStore();
		await store.putImage("c_1", "shots/s1.webp", image);
		await store.putImage("c_1", "crops/a1.webp", image);
		await store.pruneImages("c_1", new Set(["shots/s1.webp"]));
		expect(await store.getImage("c_1", "shots/s1.webp")).toBeDefined();
		expect(await store.getImage("c_1", "crops/a1.webp")).toBeUndefined();
	});
});
