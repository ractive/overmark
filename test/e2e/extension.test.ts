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
		// What extension pages hear when the overlay changes by itself.
		await h.control.eval(
			`globalThis.changes = []; chrome.runtime.onMessage.addListener((m) => { if (m.type === "overlay:changed") globalThis.changes.push(m.state.visible); })`,
		);
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
		await h.control.waitFor("globalThis.changes?.includes(false)");
		const after = await h.control.eval<{ visible: boolean }>(
			`chrome.tabs.sendMessage(${tabId}, { type: "overlay:state" })`,
		);
		expect(after.visible).toBe(false);
		await page.send("Page.close");
	});

	test("replaces an overlay that an orphaned instance left behind", async () => {
		// After an extension reload or update the old content script can no
		// longer be reached, but its overlay stays in the page.
		const { page, tabId } = await h.open("v1");
		await page.eval(
			`(() => { const old = document.createElement("div"); old.id = "overmark-root"; old.dataset.orphan = "true"; document.documentElement.append(old); })()`,
		);
		const state = await h.control.eval<{ visible: boolean }>(
			`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ["content.js"] }).then(() => chrome.tabs.sendMessage(${tabId}, { type: "overlay:show" }))`,
		);
		expect(state.visible).toBe(true);
		expect(
			await page.eval<string[]>(
				`[...document.querySelectorAll("#overmark-root")].map((e) => e.dataset.orphan ?? "live")`,
			),
		).toEqual(["live"]);
		await page.send("Page.close");
	});
});

const shadow = (selector: string) =>
	`${HOST}.shadowRoot.querySelector(${JSON.stringify(selector)})`;

const READ_DB = `new Promise((resolve, reject) => {
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

interface Db {
	cases: {
		id: string;
		title: string;
		shots: { id: string; scrollY: number }[];
		annotations: {
			number: number;
			shot: string;
			comment: string;
			shape: { kind: string };
			element: { tag: string; text?: string; name?: string } | null;
		}[];
	}[];
	images: { key: string; size: number; type: string }[];
}

describe.skipIf(browserBinary === undefined)("annotating and saving", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startHarness(browserBinary as string);
	}, 60_000);

	afterAll(async () => {
		await h?.stop();
	});

	test("marks drawn with the toolbar are saved as a case with screenshots", async () => {
		const { page, tabId } = await h.open("v1");
		await page.activate();
		await h.control.eval(
			`chrome.tabs.sendMessage(${tabId}, { type: "overlay:show" }).catch(() => chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ["content.js"] }).then(() => chrome.tabs.sendMessage(${tabId}, { type: "overlay:show" })))`,
		);
		await page.waitFor(shadow('[data-action="tool-box"]'));

		// 1: a box around the submit button
		await page.click(shadow('[data-action="tool-box"]'));
		const button = await page.eval<{
			x: number;
			y: number;
			width: number;
			height: number;
		}>(
			`(() => { const r = document.querySelector("[data-truth=submit]").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
		);
		await page.drag(
			{ x: button.x - 6, y: button.y - 6 },
			{ x: button.x + button.width + 6, y: button.y + button.height + 6 },
		);
		await page.waitFor(shadow(".popover textarea"));
		await page.type("Contrast too low");
		await page.click(shadow('[data-action="comment-done"]'));

		// 2: a note on the tip
		await page.click(shadow('[data-action="tool-note"]'));
		await page.click(`document.querySelector("[data-truth=tip]")`);
		await page.waitFor(shadow(".popover textarea"));
		await page.type("Say how much exactly");
		await page.click(shadow('[data-action="comment-done"]'));

		// 3: far below, the contact paragraph picked as an element
		await page.eval(
			`window.scrollTo(0, document.querySelector("[data-truth=contact]").getBoundingClientRect().top + scrollY - 200)`,
		);
		await page.click(shadow('[data-action="tool-element"]'));
		const contact = await page.centreOf(
			`document.querySelector("[data-truth=contact]")`,
		);
		await page.mouse("mouseMoved", contact.x, contact.y);
		await page.clickAt(contact.x, contact.y);
		await page.waitFor(shadow(".popover textarea"));
		await page.type("Add a phone number");
		await page.click(shadow('[data-action="comment-done"]'));

		expect(
			await page.eval<number>(
				`${shadow("svg.marks")}.querySelectorAll("g[data-number]").length`,
			),
		).toBe(3);

		// Save
		await page.click(shadow('[data-action="save"]'));
		await page.waitFor(shadow('input[aria-label="Case title"]'));
		await page.eval(
			`(() => { const i = ${shadow('input[aria-label="Case title"]')}; i.focus(); i.select(); })()`,
		);
		await page.type("Prämienrechner");
		await page.click(shadow('[data-action="save-confirm"]'));
		await page.waitFor(
			`${shadow('[data-role="status"]')}?.textContent.startsWith("Saved")`,
			20_000,
		);

		const db = await h.control.eval<Db>(READ_DB);
		expect(db.cases).toHaveLength(1);
		const saved = db.cases[0];
		expect(saved?.title).toBe("Prämienrechner");
		expect(saved?.shots).toHaveLength(2);
		const [a1, a2, a3] = saved?.annotations ?? [];
		expect(a1?.shape.kind).toBe("box");
		expect(a1?.comment).toBe("Contrast too low");
		expect(a1?.element?.tag).toBe("button");
		expect(a1?.element?.name).toBe("Prämien berechnen");
		expect(a2?.shape.kind).toBe("note");
		expect(a2?.element?.text).toContain("höheren Franchise");
		expect(a3?.shape.kind).toBe("element");
		expect(a3?.element?.text).toBe("Unser Team hilft Ihnen gerne weiter.");
		expect(a3?.shot).not.toBe(a1?.shot);
		const keys = db.images
			.map((i) => i.key.split("/").slice(1).join("/"))
			.sort();
		expect(keys).toEqual([
			"crops/a1.webp",
			"crops/a2.webp",
			"crops/a3.webp",
			"shots/s1.webp",
			"shots/s2.webp",
		]);
		for (const image of db.images) {
			expect(image.type).toBe("image/webp");
			expect(image.size).toBeGreaterThan(500);
		}

		// The side panel lists it.
		await h.control.waitFor(`document.querySelector("[data-case]")`);
		expect(
			await h.control.eval<string>(
				`document.querySelector("[data-case] .title").textContent`,
			),
		).toBe("Prämienrechner");
		await page.send("Page.close");
	}, 60_000);

	test("marks drawn before choosing a case are renumbered for it and added", async () => {
		const before = (await h.control.eval<Db>(READ_DB)).cases[0];
		if (before === undefined) throw new Error("the previous test saves a case");
		const { page, tabId } = await h.open("v1");
		await page.activate();
		await h.control.eval(
			`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ["content.js"] }).then(() => chrome.tabs.sendMessage(${tabId}, { type: "overlay:show" }))`,
		);
		await page.waitFor(shadow('[data-action="tool-note"]'));
		await page.click(shadow('[data-action="tool-note"]'));
		await page.click(`document.querySelector("h1")`);
		await page.waitFor(shadow(".popover textarea"));
		await page.type("Larger heading");
		await page.click(shadow('[data-action="comment-done"]'));
		const numbers = () =>
			page.eval<string[]>(
				`[...${shadow("svg.marks")}.querySelectorAll("g[data-number]")].map((g) => g.dataset.number)`,
			);
		expect(await numbers()).toEqual(["1"]);

		// "Add marks on this tab" for the saved case (marks 1–3).
		await h.control.eval(
			`chrome.tabs.sendMessage(${tabId}, { type: "overlay:show", target: { caseId: ${JSON.stringify(before.id)}, title: ${JSON.stringify(before.title)}, nextAnnotation: 4 } })`,
		);
		expect(await numbers()).toEqual(["4"]);

		await page.click(shadow('[data-action="save"]'));
		await page.click(shadow('[data-action="save-confirm"]'));
		await page.waitFor(
			`${shadow('[data-role="status"]')}?.textContent.startsWith("Saved")`,
			20_000,
		);
		const db = await h.control.eval<Db>(READ_DB);
		const after = db.cases.find((c) => c.id === before.id);
		expect(after?.annotations.map((a) => a.number)).toEqual([1, 2, 3, 4]);
		expect(after?.shots.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
		expect(after?.annotations[3]?.shot).toBe("s3");
		expect(db.images.some((i) => i.key.includes("/pending/"))).toBe(false);
		expect(db.images.some((i) => i.key.endsWith("/crops/a4.webp"))).toBe(true);
		await page.send("Page.close");
	}, 60_000);
});
