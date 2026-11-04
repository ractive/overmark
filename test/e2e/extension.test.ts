/**
 * End to end: the unpacked extension in Chromium. Skipped without Chrome for
 * Testing or Chromium locally, required in CI (see harness.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browserBinary, type Harness, startHarness } from "./harness.ts";

const HOST = `document.getElementById("overmark-root")`;

describe.skipIf(browserBinary === undefined)("extension", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startHarness(browserBinary as string);
	}, 60_000);

	afterAll(async () => {
		await h?.stop();
	});

	test("has the fixed extension ID", () => {
		expect(h.extensionId).toBe("fphhchhlgklidhnodoleiebmdhnfdadg");
	});

	test("the content script shows and hides the overlay, once per page", async () => {
		const { page, tabId } = await h.open("v1");
		const inject = `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ["content.js"] })`;
		await h.control.eval(inject);
		await h.control.eval(inject);
		const state = await h.control.eval<{ visible: boolean; title: string }>(
			`chrome.tabs.sendMessage(${tabId}, { type: "overlay:show" })`,
		);
		expect(state.visible).toBe(true);
		expect(state.title).toBe("Krankenkasse vergleichen (v1)");
		expect(
			await page.eval<number>(
				`document.querySelectorAll("#overmark-root").length`,
			),
		).toBe(1);
		await page.click(
			`${HOST}.shadowRoot.querySelector('[data-action="close"]')`,
		);
		const after = await h.control.eval<{ visible: boolean }>(
			`chrome.tabs.sendMessage(${tabId}, { type: "overlay:state" })`,
		);
		expect(after.visible).toBe(false);
		await page.send("Page.close");
	});
});
