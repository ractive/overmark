import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { askForDownloads, saveFile } from "../src/sidepanel/download.ts";

const globals = globalThis as unknown as Record<string, unknown>;
const before = { chrome: globals["chrome"], document: globals["document"] };
const window = new Window({ url: "chrome-extension://x/sidepanel/index.html" });

type Item = { id: number; state: string; filename: string; error?: string };

/** A fake `chrome.downloads`: each download ends as `outcome` says, a moment later. */
function fakeChrome(outcome: Partial<Item> | "throws", granted = true) {
	const listeners = new Set<(d: { id: number; state?: object }) => void>();
	const items = new Map<number, Item>();
	const calls: { url: string; filename?: string }[] = [];
	const requested: unknown[] = [];
	globals["chrome"] = {
		permissions: {
			request: async (p: unknown) => {
				requested.push(p);
				return granted;
			},
		},
		downloads: {
			download: async (o: { url: string; filename?: string }) => {
				calls.push(o);
				if (outcome === "throws") throw new Error("Invalid filename");
				const id = calls.length;
				items.set(id, { id, state: "in_progress", filename: "" });
				setTimeout(() => {
					items.set(id, {
						id,
						state: "complete",
						filename: `/Downloads/${o.filename}`,
						...outcome,
					});
					for (const l of listeners) l({ id, state: {} });
				}, 5);
				return id;
			},
			search: async ({ id }: { id: number }) =>
				items.has(id) ? [items.get(id)] : [],
			onChanged: {
				addListener: (l: never) => listeners.add(l),
				removeListener: (l: never) => listeners.delete(l),
			},
		},
	};
	return { calls, requested, listeners };
}

const bytes = new Uint8Array([1, 2, 3]);

/** Links the old way clicked, by their file name. */
let clicked: string[] = [];

beforeEach(() => {
	clicked = [];
	globals["document"] = {
		createElement: () => {
			const a = window.document.createElement("a");
			a.addEventListener("click", (e) => {
				e.preventDefault();
				clicked.push(a.download);
			});
			return a;
		},
		body: window.document.body,
	};
});

afterAll(() => {
	globals["chrome"] = before.chrome;
	globals["document"] = before.document;
});

describe("saving an export", () => {
	test("with the permission: through downloads, with the file's name and where it went", async () => {
		const fake = fakeChrome({});
		const allowed = askForDownloads();
		expect(fake.requested).toEqual([{ permissions: ["downloads"] }]);
		const saved = await saveFile(bytes, "a.sitegloss.zip", allowed);
		expect(saved).toEqual({
			downloadId: 1,
			path: "/Downloads/a.sitegloss.zip",
		});
		expect(fake.calls[0]?.filename).toBe("a.sitegloss.zip");
		expect(fake.calls[0]?.url.startsWith("blob:")).toBe(true);
		expect(fake.listeners.size).toBe(0);
		expect(clicked).toEqual([]);
	});

	test("declined: saved the old way, and nothing to show", async () => {
		const fake = fakeChrome({}, false);
		const saved = await saveFile(bytes, "b.sitegloss.zip", askForDownloads());
		expect(saved).toBeUndefined();
		expect(fake.calls).toEqual([]);
		expect(clicked).toEqual(["b.sitegloss.zip"]);
	});

	test("downloads refusing the file: saved the old way all the same", async () => {
		fakeChrome("throws");
		const warn = console.warn;
		console.warn = () => undefined;
		const saved = await saveFile(
			bytes,
			"c.sitegloss.zip",
			Promise.resolve(true),
		).finally(() => {
			console.warn = warn;
		});
		expect(saved).toBeUndefined();
		expect(clicked).toEqual(["c.sitegloss.zip"]);
	});

	test("Save as cancelled: nothing to show, and no error", async () => {
		fakeChrome({ state: "interrupted", error: "USER_CANCELED" });
		expect(
			await saveFile(bytes, "d.sitegloss.zip", Promise.resolve(true)),
		).toBeUndefined();
	});

	test("Chrome stopping the download says why", async () => {
		fakeChrome({ state: "interrupted", error: "FILE_NO_SPACE" });
		await expect(
			saveFile(bytes, "e.sitegloss.zip", Promise.resolve(true)),
		).rejects.toThrow("Chrome stopped saving the file (FILE_NO_SPACE).");
	});

	test("asking outside a click is no answer: the file is still saved", async () => {
		globals["chrome"] = {
			permissions: {
				request: () => Promise.reject(new Error("needs a user gesture")),
			},
		};
		const warn = console.warn;
		console.warn = () => undefined;
		try {
			expect(await askForDownloads()).toBe(false);
		} finally {
			console.warn = warn;
		}
	});
});
