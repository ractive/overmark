/**
 * What the service worker refuses: a screenshot of a tab that left the front
 * (it would show another tab), and a screenshot of another tab than the one
 * asking.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "./browser.ts";
import { browserBinary, type Harness, startHarness } from "./harness.ts";
import { worker } from "./steps.ts";

interface Capture {
	ok: boolean;
	error?: string;
	width?: number;
}

describe.skipIf(browserBinary === undefined)("the worker refuses", () => {
	let h: Harness;
	let serviceWorker: Page;
	let a: { page: Page; tabId: number };
	let b: { page: Page; tabId: number };
	let windowId: number;

	/** The page's own screenshot of a mark, which the worker takes (DEC-012). */
	const capture = (tabId: number) =>
		h.control.eval<Capture>(
			`chrome.scripting.executeScript({
				target: { tabId: ${tabId} },
				func: () => chrome.runtime.sendMessage({ type: "capture", caseId: "c_refusals", shotId: "s1" }),
			}).then(([injected]) => injected.result)`,
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
		expect(answer.width).toBeGreaterThan(0);
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
		expect(answer.width).toBeUndefined();
	});

	test("a capture Chrome never answers, and the queue goes on", async () => {
		await a.page.activate();
		await serviceWorker.eval(
			"globalThis.duringCapture = () => new Promise(() => {})",
		);
		const stuck = await capture(a.tabId);
		await serviceWorker.eval("globalThis.duringCapture = undefined");
		expect(stuck.error).toContain("did not deliver");
		expect((await capture(a.tabId)).ok).toBe(true);
	}, 20_000);

	test("ids that are no ids", async () => {
		const send = (message: object) =>
			h.control.eval<{ ok: boolean; error?: string }>(
				`chrome.runtime.sendMessage(${JSON.stringify(message)})`,
			);
		expect(
			await send({ type: "images:discard", caseId: "../x", shotIds: [] }),
		).toEqual({ ok: false, error: "invalid id" });
		expect(
			await send({
				type: "case:save",
				request: {
					caseId: "c_1",
					imagesFrom: "../x",
					shots: [],
					annotations: [],
				},
			}),
		).toEqual({ ok: false, error: "invalid id" });
	});

	test("no message asks for another tab's screenshot: the side panel's capture:tab is gone", async () => {
		await a.page.activate();
		const before = await captures();
		const answer = await h.control.eval(
			`chrome.runtime.sendMessage({ type: "capture:tab", tabId: ${a.tabId}, windowId: ${windowId} }).then((r) => r ?? null, () => null)`,
		);
		expect(answer).toBeNull();
		expect(await captures()).toBe(before);
	});
});
