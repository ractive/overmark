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

	test("updateCase writes the case and its images together", async () => {
		const store = new MemoryStore();
		await store.putCase(sampleCase("c_1"));
		const saved = await store.updateCase("c_1", (current) => ({
			value: { ...(current ?? sampleCase()), title: "New" },
			images: new Map([["crops/a1.webp", image]]),
		}));
		expect(saved.title).toBe("New");
		expect((await store.getCase("c_1"))?.title).toBe("New");
		expect(await store.getImage("c_1", "crops/a1.webp")).toBeDefined();
	});

	test("updateCase changes nothing when the change throws or renames the case", async () => {
		const store = new MemoryStore();
		await store.putCase(sampleCase("c_1"));
		await expect(
			store.updateCase("c_1", () => {
				throw new Error("no");
			}),
		).rejects.toThrow("no");
		await expect(
			store.updateCase("c_1", () => ({
				value: sampleCase("c_2"),
				images: new Map([["crops/a1.webp", image]]),
			})),
		).rejects.toThrow("cannot become c_2");
		expect(await store.getCase("c_2")).toBeUndefined();
		expect(store.images.size).toBe(0);
		expect((await store.getCase("c_1"))?.title).toBe("Button contrast");
	});

	test("deleteImages deletes only the paths named", async () => {
		const store = new MemoryStore();
		await store.putImage("c_1", "pending/p_a.webp", image);
		await store.putImage("c_1", "shots/s1.webp", image);
		await store.deleteImages("c_1", ["pending/p_a.webp", "pending/p_x.webp"]);
		expect([...store.images.keys()]).toEqual(["c_1/shots/s1.webp"]);
	});
});

describe("sweepPending", () => {
	test("deletes old and undated pending screenshots only", async () => {
		const store = new MemoryStore();
		const blob = new Blob(["x"]);
		await store.putImage("c_1", "pending/p_old.webp", {
			blob,
			width: 1,
			height: 1,
			storedAt: 1000,
		});
		await store.putImage("c_1", "pending/p_new.webp", {
			blob,
			width: 1,
			height: 1,
			storedAt: 9000,
		});
		await store.putImage("c_2", "pending/p_undated.webp", {
			blob,
			width: 1,
			height: 1,
		});
		await store.putImage("c_1", "shots/s1.webp", { blob, width: 1, height: 1 });
		expect(await store.sweepPending(5000)).toBe(2);
		expect([...store.images.keys()].sort()).toEqual([
			"c_1/pending/p_new.webp",
			"c_1/shots/s1.webp",
		]);
	});
});
