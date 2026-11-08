/**
 * The store package as a user gets it: the real manifest with no host access,
 * minified, and the toolbar icon clicked for real (CDP's `Extensions` domain
 * clicks it as the browser would, with the user gesture and the `activeTab`
 * grant). All other end-to-end tests run a test build with `<all_urls>`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "./browser.ts";
import { browserBinary, type Harness, startShipped } from "./harness.ts";
import {
	type Db,
	HOST,
	imagesOf,
	markElement,
	READ_DB,
	reachOverlay,
	saveAs,
	shadow,
} from "./steps.ts";

interface Capture {
	ok: boolean;
	error?: string;
	dataUrl?: string;
}

describe.skipIf(browserBinary === undefined)("the store package", () => {
	let h: Harness;

	/** How `chrome.scripting` fares on the tab: `"injected"`, or Chrome's refusal. */
	const inject = (tabId: number) =>
		h.control.eval<string>(
			`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ["content.js"] }).then(() => "injected", (e) => e.message)`,
		);
	const capture = (tabId: number) =>
		h.control.eval<Capture>(
			`chrome.tabs.get(${tabId}).then((t) => chrome.runtime.sendMessage({ type: "capture:tab", tabId: t.id, windowId: t.windowId }))`,
		);
	const sidePanel = async (): Promise<Page> => {
		const { targetId } = await h.browser.waitForTarget(
			(t) =>
				t.type === "page" &&
				t.url === `chrome-extension://${h.extensionId}/sidepanel/index.html` &&
				t.targetId !== h.control.targetId,
		);
		return h.browser.attachPage(targetId);
	};

	beforeAll(async () => {
		h = await startShipped(browserBinary as string);
	}, 60_000);

	afterAll(async () => {
		await h?.stop();
	});

	test("has no host access, in the manifest or in Chrome", async () => {
		expect(h.manifest["host_permissions"]).toBeUndefined();
		expect(h.manifest["key"]).toBeUndefined();
		const granted = await h.control.eval<{
			origins: string[];
			permissions: string[];
		}>("chrome.permissions.getAll()");
		expect(granted.origins).toEqual([]);
		expect(granted.permissions.sort()).toEqual([
			"activeTab",
			"scripting",
			"sidePanel",
			"unlimitedStorage",
		]);
	});

	test("runs minified bundles", async () => {
		const start = await h.control.eval<string>(
			`fetch(chrome.runtime.getURL("content.js")).then((r) => r.text()).then((t) => t.slice(0, 6))`,
		);
		expect(start).toBe("(()=>{"); // a test build has spaces and line breaks here
	});

	test("unlimitedStorage adds no install warning", async () => {
		const warnings = (manifest: object) =>
			h.control.eval<string[]>(
				`chrome.management.getPermissionWarningsByManifest(${JSON.stringify(JSON.stringify(manifest))})`,
			);
		const permissions = h.manifest["permissions"] as string[];
		expect(permissions).toContain("unlimitedStorage");
		expect(await warnings(h.manifest)).toEqual([]);
		// Chrome does warn here, so the empty answer above means something.
		expect(
			await warnings({
				...h.manifest,
				permissions: [...permissions, "history"],
			}),
		).toHaveLength(1);
	});

	test("a tab nobody clicked the icon on is refused", async () => {
		const { page, tabId } = await h.open("v2");
		expect(await inject(tabId)).toContain("Cannot access");
		const answer = await capture(tabId);
		expect(answer.ok).toBe(false);
		expect(answer.error).toContain("activeTab");
		expect(await page.eval<boolean>(`${HOST} === null`)).toBe(true);
		await page.send("Page.close");
	}, 15_000);

	test("a click on the icon opens the side panel, and marks can be saved on that tab only", async () => {
		const clicked = await h.open("v1");
		const other = await h.open("v2");
		await clicked.page.activate();
		await h.browser.clickIcon(h.extensionId, `${h.base}/v1`);

		const panel = await sidePanel();
		await panel.waitFor(`document.getElementById("annotate")`);
		await clicked.page.waitFor(HOST);
		// The page's scripts cannot reach into the overlay.
		expect(await clicked.page.eval(`${HOST}.shadowRoot`)).toBeNull();
		expect((await capture(clicked.tabId)).ok).toBe(true);

		await panel.click(`document.getElementById("annotate")`);
		await reachOverlay(clicked.page);
		// The toolbar exists, hidden, from the start: a click on it would go past.
		await clicked.page.waitFor(`!${shadow(".toolbar")}.hidden`);
		await markElement(clicked.page, "[data-truth=submit]", "Too pale");
		await saveAs(clicked.page, "From the store package");
		const db = await h.control.eval<Db>(READ_DB);
		const saved = db.cases[0];
		expect(saved?.title).toBe("From the store package");
		expect(saved?.annotations[0]?.element?.tag).toBe("button");
		expect(imagesOf(db, saved?.id ?? "")).toContain("crops/a1.webp");
		await panel.waitFor(`document.querySelector("[data-case]")`);

		// The click was for that tab: the panel, still open, may not touch the other.
		await other.page.activate();
		await panel.waitFor(
			`document.getElementById("annotate").textContent === "Annotate this page"`,
		);
		await panel.click(`document.getElementById("annotate")`);
		await panel.waitFor(
			`document.getElementById("hint")?.textContent.includes("may not run on this tab")`,
		);
		expect(await inject(other.tabId)).toContain("Cannot access");
		expect(await other.page.eval<boolean>(`${HOST} === null`)).toBe(true);
	}, 60_000);

	test("a case's address opens a tab, and the icon's click there loads the case", async () => {
		const url = `${h.base}/v1?opened=1`;
		const first = await h.open("v1?opened=1");
		await h.browser.clickIcon(h.extensionId, url);
		const panel = await sidePanel();
		await panel.waitFor(`document.getElementById("annotate")`);
		await first.page.waitFor(HOST);
		await panel.click(`document.getElementById("annotate")`);
		await reachOverlay(first.page);
		await first.page.waitFor(`!${shadow(".toolbar")}.hidden`);
		await markElement(first.page, "[data-truth=tip]", "Say how much");
		await saveAs(first.page, "Opened from its address");
		await first.page.send("Page.close");
		for (;;) {
			const tabs = await h.browser.targets();
			if (!tabs.some((t) => t.type === "tab" && t.url === url)) break;
			await Bun.sleep(100);
		}

		const row = `[...document.querySelectorAll("[data-case]")].find((e) => e.textContent.includes("Opened from its address"))`;
		await panel.waitFor(row);
		await panel.click(row);
		await panel.waitFor(`document.getElementById("open-page")`);
		const tabTargets = async () =>
			(await h.browser.targets()).filter((t) => t.type === "tab");
		const before = new Set((await tabTargets()).map((t) => t.targetId));
		await panel.click(`document.getElementById("open-page")`);
		// No host access: Chrome hides the new tab from Overmark until the click.
		await panel.waitFor(
			`document.getElementById("case-hint").textContent.includes("Click the Overmark icon")`,
			15_000,
		);
		// The case's address has no query: the new tab is the one not there before.
		const opened = (await tabTargets()).find((t) => !before.has(t.targetId));
		expect(opened?.url).toBe(`${h.base}/v1`);
		await h.browser.send("Extensions.triggerAction", {
			id: h.extensionId,
			targetId: opened?.targetId,
		});
		await panel.waitFor(
			`document.querySelector(".match")?.dataset.status === "found"`,
			15_000,
		);
		expect(
			await panel.eval<string>(
				`document.getElementById("case-hint").textContent`,
			),
		).toContain("1 of 1 marks found");
	}, 60_000);

	test("a case opened on a tab Overmark may not see yet loads at the icon's click", async () => {
		// As after reloading the extension: the tab shows the case's page, and
		// Chrome hides its address until the icon is clicked there.
		const tabTargets = async () =>
			(await h.browser.targets()).filter((t) => t.type === "tab");
		const before = new Set((await tabTargets()).map((t) => t.targetId));
		const page = await h.browser.newPage(`${h.base}/v1`);
		await page.activate();
		const fresh = (await tabTargets()).find((t) => !before.has(t.targetId));
		const panel = await sidePanel();
		await panel.goto(
			`chrome-extension://${h.extensionId}/sidepanel/index.html`,
		);
		const row = `[...document.querySelectorAll("[data-case]")].find((e) => e.textContent.includes("Opened from its address"))`;
		await panel.waitFor(row);
		await panel.eval(`${row}.click()`);
		await panel.waitFor(
			`document.getElementById("case-hint").textContent.includes("click the Overmark icon")`,
		);
		await h.browser.send("Extensions.triggerAction", {
			id: h.extensionId,
			targetId: fresh?.targetId,
		});
		await panel.waitFor(
			`document.querySelector(".match")?.dataset.status === "found"`,
			15_000,
		);
		expect(await page.eval<number>(`${HOST} === null ? 0 : 1`)).toBe(1);
	}, 60_000);
});
