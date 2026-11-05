/**
 * What the service worker refuses: a screenshot of a tab that left the front
 * (it would show another tab), and the side panel's capture from anywhere else.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "./browser.ts";
import { browserBinary, type Harness, startHarness } from "./harness.ts";
import { worker } from "./steps.ts";

interface Capture {
	ok: boolean;
	error?: string;
	dataUrl?: string;
}

describe.skipIf(browserBinary === undefined)("the worker refuses", () => {
	let h: Harness;
	let serviceWorker: Page;
	let a: { page: Page; tabId: number };
	let b: { page: Page; tabId: number };
	let windowId: number;

	const capture = (tabId: number, window = windowId) =>
		h.control.eval<Capture>(
			`chrome.runtime.sendMessage({ type: "capture:tab", tabId: ${tabId}, windowId: ${window} })`,
		);
	const captures = () => serviceWorker.eval<number>("globalThis.captures");

	beforeAll(async () => {
		h = await startHarness(browserBinary as string);
		a = await h.open("v1");
		b = await h.open("v2");
		windowId = await h.control.eval<number>(
			`chrome.tabs.get(${a.tabId}).then((t) => t.windowId)`,
		);
		serviceWorker = await worker(h);
		// Counts the real captures; `duringCapture` runs while one is under way.
		await serviceWorker.eval(`(() => {
			const real = chrome.tabs.captureVisibleTab.bind(chrome.tabs);
			globalThis.captures = 0;
			chrome.tabs.captureVisibleTab = async (...args) => {
				globalThis.captures++;
				const image = await real(...args);
				await globalThis.duringCapture?.();
				return image;
			};
		})()`);
	}, 60_000);

	afterAll(async () => {
		await h?.stop();
	});

	test("nothing while the tab is in front", async () => {
		await a.page.activate();
		const answer = await capture(a.tabId);
		expect(answer.error).toBeUndefined();
		expect(answer.dataUrl?.startsWith("data:image/png")).toBe(true);
		expect(await captures()).toBe(1);
	});

	test("a tab that left the front before the capture, and takes no picture", async () => {
		await a.page.activate();
		await b.page.activate();
		const before = await captures();
		const answer = await capture(a.tabId);
		expect(answer.ok).toBe(false);
		expect(answer.error).toContain("no longer in front");
		expect(await captures()).toBe(before);
	});

	test("a tab that left the front during the capture", async () => {
		await a.page.activate();
		await serviceWorker.eval(
			`globalThis.duringCapture = () => chrome.tabs.update(${b.tabId}, { active: true })`,
		);
		const before = await captures();
		const answer = await capture(a.tabId);
		await serviceWorker.eval("globalThis.duringCapture = undefined");
		expect(await captures()).toBe(before + 1);
		expect(answer.ok).toBe(false);
		expect(answer.error).toContain("no longer in front");
		expect(answer.dataUrl).toBeUndefined();
	});

	test("a tab in front of another window than the one asked for", async () => {
		await a.page.activate();
		const before = await captures();
		const answer = await capture(a.tabId, windowId + 1);
		expect(answer.ok).toBe(false);
		expect(answer.error).toContain("no longer in front");
		expect(await captures()).toBe(before);
	});

	test("capture:tab from a content script", async () => {
		await a.page.activate();
		const before = await captures();
		const answer = await h.control.eval<Capture>(
			`chrome.scripting.executeScript({
				target: { tabId: ${a.tabId} },
				args: [${a.tabId}, ${windowId}],
				func: (tabId, windowId) => chrome.runtime.sendMessage({ type: "capture:tab", tabId, windowId }),
			}).then(([injected]) => injected.result)`,
		);
		expect(answer.ok).toBe(false);
		expect(answer.error).toBe("only for Overmark's own pages");
		expect(answer.dataUrl).toBeUndefined();
		expect(await captures()).toBe(before);
	});
});
