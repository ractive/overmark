import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TargetFailed } from "../src/lib/sync.ts";
import { memoryKv } from "../src/worker/kv.ts";
import { sampleCase } from "./fixtures.ts";

type Listener = (delta: chrome.downloads.DownloadDelta) => void;

/** The parts of `chrome` the worker's downloads use, in memory. */
const fake = {
	listeners: new Set<Listener>(),
	items: new Map<number, Partial<chrome.downloads.DownloadItem>>(),
	searchFails: false,
	pings: 0,
	open: true,
	created: 0,
	closed: 0,
	log: [] as string[],
	erased: [] as number[],
	answer: (_m: unknown): unknown => ({ ok: true, url: "blob:x/1" }),
};

const globals = globalThis as unknown as Record<string, unknown>;
const before = globals["chrome"];
let downloads: typeof import("../src/worker/downloads.ts");

beforeAll(async () => {
	globals["chrome"] = {
		downloads: {
			onChanged: {
				addListener: (l: Listener) => fake.listeners.add(l),
				removeListener: (l: Listener) => fake.listeners.delete(l),
			},
			erase: async ({ id }: { id: number }) => {
				fake.erased.push(id);
				return [id];
			},
			search: async ({ id }: { id: number }) => {
				if (fake.searchFails) throw new Error("search failed");
				const item = fake.items.get(id);
				return item === undefined ? [] : [item];
			},
		},
		runtime: {
			id: "overmark",
			getPlatformInfo: async () => {
				fake.pings++;
				return {};
			},
			sendMessage: async (m: unknown) => fake.answer(m),
		},
		offscreen: {
			Reason: { BLOBS: "BLOBS" },
			hasDocument: async () => fake.open,
			createDocument: async () => {
				await Bun.sleep(5);
				fake.created++;
				fake.log.push("create");
				fake.open = true;
			},
			closeDocument: async () => {
				fake.closed++;
				fake.log.push("close");
				fake.open = false;
			},
		},
		permissions: { contains: async () => true },
	};
	downloads = await import("../src/worker/downloads.ts");
});

afterAll(() => {
	globals["chrome"] = before;
});

const changed = (delta: chrome.downloads.DownloadDelta) => {
	for (const l of [...fake.listeners]) l(delta);
};

describe("the offscreen document (DEC-025)", () => {
	test("one a stopped worker left open goes at the start, before a run opens its own", async () => {
		const api = downloads.chromeDownloads(memoryKv());
		await Bun.sleep(1);
		expect(fake.log).toEqual(["close"]);
		// Two at once open it once.
		await Promise.all([api.url(sampleCase("c_1")), api.url(sampleCase("c_2"))]);
		expect(fake.log).toEqual(["close", "create"]);
		await api.end?.();
		expect(fake.log).toEqual(["close", "create", "close"]);
	});

	test("not answering, or not opening, fails the target, not the case", async () => {
		const api = downloads.chromeDownloads(memoryKv());
		fake.answer = () => {
			throw new Error("Could not establish connection.");
		};
		await expect(api.url(sampleCase("c_1"))).rejects.toBeInstanceOf(
			TargetFailed,
		);
		fake.answer = () => undefined;
		await expect(api.url(sampleCase("c_1"))).rejects.toBeInstanceOf(
			TargetFailed,
		);
		// The export failing is the case's own.
		fake.answer = () => ({ ok: false, error: "a screenshot is missing" });
		const error = await api.url(sampleCase("c_1")).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(TargetFailed);
		fake.answer = () => ({ ok: true, url: "blob:x/1" });
	});
});

describe("waiting for a download (DEC-025)", () => {
	test("its own end only; the listener goes after it", async () => {
		fake.items.set(7, { id: 7, state: "in_progress" });
		const end = downloads.finished(7, 5000);
		await Bun.sleep(1);
		expect(fake.listeners.size).toBe(1);
		fake.items.set(8, { id: 8, state: "complete", filename: "/o" });
		changed({ id: 8, state: { current: "complete" } });
		fake.items.set(7, { id: 7, state: "complete", filename: "/d/a.zip" });
		changed({ id: 7, state: { current: "complete" } });
		expect(await end).toEqual({ state: "complete", filename: "/d/a.zip" });
		expect(fake.listeners.size).toBe(0);
	});

	test("interrupted, or gone from the list", async () => {
		fake.items.set(9, { id: 9, state: "interrupted", error: "FILE_NO_SPACE" });
		expect(await downloads.finished(9, 5000)).toEqual({
			state: "interrupted",
			error: "FILE_NO_SPACE",
		});
		expect(await downloads.finished(99, 5000)).toEqual({
			state: "interrupted",
			error: "LOST",
		});
	});

	test("no end in time: timeout, the listener gone; the worker kept awake meanwhile", async () => {
		fake.items.set(10, { id: 10, state: "in_progress" });
		const pings = fake.pings;
		expect(await downloads.finished(10, 60, 10)).toEqual({ state: "timeout" });
		expect(fake.pings - pings).toBeGreaterThanOrEqual(3);
		expect(fake.listeners.size).toBe(0);
		const after = fake.pings;
		await Bun.sleep(30);
		expect(fake.pings).toBe(after);
	});

	test("a search that fails: rejected, and nothing left behind", async () => {
		fake.searchFails = true;
		await expect(downloads.finished(11, 5000)).rejects.toThrow("search failed");
		fake.searchFails = false;
		expect(fake.listeners.size).toBe(0);
	});
});

describe("Overmark's own entries in Chrome's list (DEC-025)", () => {
	test("erased only when Overmark wrote it into Overmark/: an id reused later is someone else's", async () => {
		const api = downloads.chromeDownloads(memoryKv());
		fake.items.set(20, {
			id: 20,
			byExtensionId: "overmark",
			filename: "/Users/me/Downloads/Overmark/a.overmark.zip",
		});
		fake.items.set(21, {
			id: 21,
			filename: "/Users/me/Downloads/holiday.jpg",
		});
		fake.items.set(22, {
			id: 22,
			byExtensionId: "overmark",
			filename: "/Users/me/Downloads/overmark-cases.overmark.zip",
		});
		await api.erase(20);
		await api.erase(21);
		await api.erase(22);
		await api.erase(23);
		expect(fake.erased).toEqual([20]);
	});
});
