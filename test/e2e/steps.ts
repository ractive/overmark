/** Steps the end-to-end tests share: the toolbar, saving, reading the database. */

import type { Page } from "./browser.ts";
import type { Harness } from "./harness.ts";

export const HOST = `document.getElementById("overmark-root")`;

/** An element inside Overmark's shadow root. */
export const shadow = (selector: string) =>
	`${HOST}.shadowRoot.querySelector(${JSON.stringify(selector)})`;

export const READ_DB = `new Promise((resolve, reject) => {
	const open = indexedDB.open("overmark");
	open.onerror = () => reject(open.error);
	open.onsuccess = () => {
		const tx = open.result.transaction(["cases", "images"]);
		const cases = tx.objectStore("cases").getAll();
		const images = tx.objectStore("images").getAll();
		const keys = tx.objectStore("images").getAllKeys();
		tx.oncomplete = () => resolve({
			cases: cases.result,
			images: keys.result.map((key, i) => ({ key, size: images.result[i].blob.size, type: images.result[i].blob.type })),
		});
	};
})`;

export interface Db {
	cases: {
		id: string;
		title: string;
		shots: { id: string; scrollY: number }[];
		annotations: {
			id: string;
			number: number;
			shot: string;
			comment: string;
			shape: { kind: string };
			element: { tag: string; text?: string; name?: string } | null;
		}[];
	}[];
	images: { key: string; size: number; type: string }[];
}

/** Inject the content script if needed and show the toolbar. */
export async function showToolbar(
	h: Harness,
	page: Page,
	tabId: number,
): Promise<void> {
	await page.activate();
	await h.control.eval(
		`chrome.tabs.sendMessage(${tabId}, { type: "overlay:show" }).catch(() => chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ["content.js"] }).then(() => chrome.tabs.sendMessage(${tabId}, { type: "overlay:show" })))`,
	);
	await page.waitFor(shadow('[data-action="tool-box"]'));
}

/** Finish the open comment field with `text`. */
export async function comment(page: Page, text: string): Promise<void> {
	await page.waitFor(shadow(".popover textarea"));
	await page.type(text);
	await page.click(shadow('[data-action="comment-done"]'));
}

/** Pick the element `selector` with the Element tool and comment it. */
export async function markElement(
	page: Page,
	selector: string,
	text: string,
): Promise<void> {
	await page.eval(
		`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`,
	);
	const pressed = await page.eval<string>(
		`${shadow('[data-action="tool-element"]')}.getAttribute("aria-pressed")`,
	);
	if (pressed !== "true")
		await page.click(shadow('[data-action="tool-element"]'));
	// Near the left edge: the toolbar sits in the middle at the bottom.
	const at = await page.eval<{ x: number; y: number }>(
		`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + Math.min(12, r.width / 2), y: r.y + r.height / 2 }; })()`,
	);
	await page.mouse("mouseMoved", at.x, at.y);
	await page.clickAt(at.x, at.y);
	await comment(page, text);
}

/** Save the marks as a new case with `title` and wait until it is stored. */
export async function saveAs(page: Page, title: string): Promise<void> {
	await page.click(shadow('[data-action="save"]'));
	await page.waitFor(shadow('input[aria-label="Case title"]'));
	await page.eval(
		`(() => { const i = ${shadow('input[aria-label="Case title"]')}; i.focus(); i.select(); })()`,
	);
	await page.type(title);
	await page.click(shadow('[data-action="save-confirm"]'));
	await page.waitFor(
		`${shadow('[data-role="status"]')}?.textContent.startsWith("Saved")`,
		20_000,
	);
}
