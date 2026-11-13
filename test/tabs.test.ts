import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { injectOnClick, NoAccessError } from "../src/lib/tabs.ts";

type Listener = (...args: never[]) => void;

/** `chrome.scripting` and `chrome.tabs` as far as `injectOnClick` uses them. */
function fakeChrome() {
	const listeners = {
		updated: new Set<Listener>(),
		removed: new Set<Listener>(),
	};
	const event = (set: Set<Listener>) => ({
		addListener: (l: Listener) => set.add(l),
		removeListener: (l: Listener) => set.delete(l),
	});
	const fake = {
		/** What each executeScript does in turn: "ok" or "refused"; none left: "ok". */
		answers: [] as ("ok" | "refused")[],
		calls: 0,
		status: "loading" as string,
		scripting: {
			executeScript: async () => {
				fake.calls++;
				if (fake.answers.shift() === "refused")
					throw new Error("Cannot access contents of the page.");
				return [];
			},
		},
		tabs: {
			get: async () => ({ status: fake.status }),
			onUpdated: event(listeners.updated),
			onRemoved: event(listeners.removed),
		},
		/** The new page committed: its address comes, while it still loads. */
		committed(url = "https://example.com/next") {
			for (const l of listeners.updated)
				(l as (id: number, info: { url: string }) => void)(7, { url });
		},
		loaded() {
			fake.status = "complete";
			for (const l of listeners.updated)
				(l as (id: number, info: { status: string }) => void)(7, {
					status: "complete",
				});
		},
		closed() {
			for (const l of listeners.removed) (l as (id: number) => void)(7);
		},
		listening: () => listeners.updated.size + listeners.removed.size,
	};
	return fake;
}

const globals = globalThis as unknown as Record<string, unknown>;
const before = globals["chrome"];
let chrome: ReturnType<typeof fakeChrome>;
const fast = { loadWaitMs: 200, retryMs: 5 };
/** Let the fake's promises settle. */
const settle = () => Bun.sleep(5);

beforeEach(() => {
	chrome = fakeChrome();
	globals["chrome"] = chrome;
});
afterAll(() => {
	globals["chrome"] = before;
});

describe("the content script after a click on the icon", () => {
	test("a loaded page: once", async () => {
		await injectOnClick({ id: 7, status: "complete" }, fast);
		expect(chrome.calls).toBe(1);
	});

	test("a loaded page Chrome refuses right after the click: once more, a moment later", async () => {
		chrome.answers = ["refused"];
		await injectOnClick({ id: 7, status: "complete" }, fast);
		expect(chrome.calls).toBe(2);
	});

	test("refused twice: the refusal is the answer", async () => {
		chrome.answers = ["refused", "refused"];
		await expect(
			injectOnClick({ id: 7, status: "complete" }, fast),
		).rejects.toBeInstanceOf(NoAccessError);
		expect(chrome.calls).toBe(2);
	});

	test("a page still loading: again once it has loaded, whatever the first try did", async () => {
		for (const first of ["ok", "refused"] as const) {
			chrome = fakeChrome();
			globals["chrome"] = chrome;
			chrome.answers = [first];
			const done = injectOnClick({ id: 7, status: "loading" }, fast);
			await settle();
			expect(chrome.calls).toBe(1);
			chrome.loaded();
			await done;
			expect(chrome.calls).toBe(2);
			expect(chrome.listening()).toBe(0);
		}
	});

	const next = {
		id: 7,
		status: "loading" as const,
		pendingUrl: "https://example.com/next",
	};

	test("the page it was on its way to has come but still loads (a slow resource): in at once", async () => {
		chrome.answers = ["ok"];
		const done = injectOnClick(next, fast);
		await settle();
		chrome.committed();
		await done;
		expect(chrome.calls).toBe(2);
		expect(chrome.listening()).toBe(0);
	});

	test("another address meanwhile (the old page's pushState, a redirect): it waits for the load", async () => {
		chrome.answers = ["ok"];
		const done = injectOnClick(next, fast);
		await settle();
		chrome.committed("https://example.com/old#moved");
		await settle();
		expect(chrome.calls).toBe(1);
		chrome.loaded();
		await done;
		expect(chrome.calls).toBe(2);
	});

	test("loaded before the listeners were there: again all the same", async () => {
		chrome.answers = ["refused"];
		chrome.status = "complete";
		await injectOnClick({ id: 7, status: "loading" }, fast);
		expect(chrome.calls).toBe(2);
	});

	test("the new page is not granted: the refusal after the load is the answer", async () => {
		chrome.answers = ["refused", "refused"];
		const done = injectOnClick({ id: 7, status: "loading" }, fast);
		await settle();
		chrome.loaded();
		await expect(done).rejects.toBeInstanceOf(NoAccessError);
	});

	test("closed while loading: the first refusal, and nothing more", async () => {
		chrome.answers = ["refused"];
		const done = injectOnClick({ id: 7, status: "loading" }, fast);
		await settle();
		chrome.closed();
		await expect(done).rejects.toBeInstanceOf(NoAccessError);
		expect(chrome.calls).toBe(1);
		expect(chrome.listening()).toBe(0);
	});

	test("a page that does not finish loading: what the first try did", async () => {
		const done = injectOnClick({ id: 7, status: "loading" }, fast);
		await expect(done).resolves.toBeUndefined();
		expect(chrome.calls).toBe(1);
		expect(chrome.listening()).toBe(0);
	});
});
