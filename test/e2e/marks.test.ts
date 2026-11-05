/**
 * End to end: a mark's screenshot is taken when the mark is drawn (DEC-012),
 * on pages that do what real pages do. See extension.test.ts for the basics.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "./browser.ts";
import { browserBinary, type Harness, startHarness } from "./harness.ts";
import {
	countColour,
	type Db,
	HOST,
	markElement,
	READ_DB,
	saveAs,
	shadow,
	showToolbar,
} from "./steps.ts";

const BLUE: [number, number, number] = [0, 120, 255];
const GREEN: [number, number, number] = [0, 170, 80];
const ORANGE: [number, number, number] = [240, 150, 0];
const PLAIN: [number, number, number] = [0, 160, 0];
const SECRET: [number, number, number] = [200, 0, 160];
const MARK: [number, number, number] = [229, 25, 95];

describe.skipIf(browserBinary === undefined)(
	"marks and their screenshots",
	() => {
		let h: Harness;

		beforeAll(async () => {
			h = await startHarness(browserBinary as string);
		}, 60_000);

		afterAll(async () => {
			await h?.stop();
		});

		const saved = async (title: string) => {
			const db = await h.control.eval<Db>(READ_DB);
			const c = db.cases.find((x) => x.title === title);
			if (c === undefined) throw new Error(`no case ${title}`);
			return { c, images: db.images };
		};

		const sendToTab = <T>(tabId: number, request: object) =>
			h.control.eval<T>(
				`chrome.tabs.sendMessage(${tabId}, ${JSON.stringify(request)})`,
			);

		let opened = 0;
		/** A page in a new tab, with an address no tab closing right now has. */
		const open = (path: string) => h.open(`${path}?tab=${opened++}`);

		/** Close a tab without the question unsaved marks ask. */
		const close = (page: Page) =>
			h.browser.send("Target.closeTarget", { targetId: page.targetId });

		/** Wait until the toolbar's queue has taken the screenshots asked for. */
		const shotsTaken = () => Bun.sleep(900);

		test("marks in a scrolling container each keep what they were drawn on", async () => {
			const { page, tabId } = await open("app");
			await showToolbar(h, page, tabId);
			await markElement(page, "#near", "near");
			await shotsTaken();
			await markElement(page, "#far", "far");
			await shotsTaken();
			await saveAs(page, "Scroller");
			const { c } = await saved("Scroller");
			expect(c.shots).toHaveLength(2);
			expect(
				await countColour(h.control, "Scroller", "crops/a1.webp", BLUE),
			).toBeGreaterThan(1000);
			expect(
				await countColour(h.control, "Scroller", "crops/a2.webp", GREEN),
			).toBeGreaterThan(1000);
			expect(
				await countColour(h.control, "Scroller", "shots/s1.webp", GREEN),
			).toBe(0);
			await close(page);
		}, 60_000);

		test("the wheel scrolls a container while a tool is active", async () => {
			const { page, tabId } = await open("app");
			await showToolbar(h, page, tabId);
			await page.click(shadow('[data-action="tool-box"]'));
			await page.send("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				x: 300,
				y: 300,
				deltaX: 0,
				deltaY: 400,
			});
			await page.waitFor(
				`document.getElementById("scroller").scrollTop >= 400`,
			);
			await close(page);
		}, 60_000);

		test("a mark follows its element when the container scrolls", async () => {
			const { page, tabId } = await open("app");
			await showToolbar(h, page, tabId);
			await markElement(page, "#near", "near");
			const badgeY = () =>
				page.eval<number>(
					`${HOST}.shadowRoot.querySelector("[data-number] circle").getBoundingClientRect().y`,
				);
			const before = await badgeY();
			await page.eval(`document.getElementById("scroller").scrollTop = 100`);
			await page.waitFor(
				`${HOST}.shadowRoot.querySelector("[data-number] circle").getBoundingClientRect().y < ${before - 90}`,
			);
			await close(page);
		}, 60_000);

		test("marks on two routes of an app keep their route and what it showed", async () => {
			const { page, tabId } = await open("app");
			await showToolbar(h, page, tabId);
			await markElement(page, "#near", "on route a");
			await shotsTaken();
			await page.eval("goToB()");
			await markElement(page, "#route-b", "on route b");
			await shotsTaken();
			// The first mark's element left with its route: it is not drawn over this one.
			expect(
				await page.eval<number>(
					`${HOST}.shadowRoot.querySelectorAll(".drafts [data-number]").length`,
				),
			).toBe(1);
			await saveAs(page, "Routes");
			const { c } = await saved("Routes");
			const shots = c.shots as unknown as { url: string }[];
			expect(shots.map((s) => new URL(s.url).pathname)).toEqual([
				"/app",
				"/app/b",
			]);
			expect(
				await countColour(h.control, "Routes", "shots/s1.webp", BLUE),
			).toBeGreaterThan(1000);
			expect(
				await countColour(h.control, "Routes", "shots/s2.webp", ORANGE),
			).toBeGreaterThan(1000);
			expect(c.annotations[0]?.element?.text).toBe("Near the top");
			await close(page);
		}, 60_000);

		test("a mark on something that goes away keeps its details and its picture", async () => {
			const { page, tabId } = await open("ui");
			await showToolbar(h, page, tabId);
			await markElement(page, "#item", "the menu item");
			await shotsTaken();
			await page.eval(`document.getElementById("menu").remove()`);
			await markElement(page, "#label", "the label");
			await shotsTaken();
			await saveAs(page, "Menu");
			const { c } = await saved("Menu");
			expect(c.annotations[0]?.element?.text).toBe("Menu item");
			expect(c.shots).toHaveLength(2);
			expect(
				await countColour(h.control, "Menu", "shots/s1.webp", BLUE),
			).toBeGreaterThan(1000);
			expect(await countColour(h.control, "Menu", "shots/s2.webp", BLUE)).toBe(
				0,
			);
			await close(page);
		}, 60_000);

		test("marks drawn while nothing changed share a screenshot, and undo leaves no trace", async () => {
			const { page, tabId } = await open("ui");
			await showToolbar(h, page, tabId);
			await markElement(page, "#label", "first");
			await shotsTaken();
			await markElement(page, "#other", "second");
			await markElement(page, "#item", "third");
			await page.click(shadow('[data-action="undo"]'));
			await shotsTaken();
			await saveAs(page, "Shared");
			const { c, images } = await saved("Shared");
			expect(c.shots).toHaveLength(1);
			expect(c.annotations.map((a) => a.shot)).toEqual(["s1", "s1"]);
			expect(
				images.map((i) => i.key).filter((k) => k.includes("/pending/")),
			).toEqual([]);
			// Both marks are on the image, drawn at saving, and the overlay is not.
			expect(
				await countColour(h.control, "Shared", "crops/a1.webp", MARK, 60),
			).toBeGreaterThan(100);
			expect(
				await countColour(h.control, "Shared", "crops/a2.webp", MARK, 60),
			).toBeGreaterThan(100);
			await close(page);
		}, 60_000);

		test("password fields are blurred in a mark's screenshot, form fields as set right now", async () => {
			const shotOf = async (title: string, blur: boolean) => {
				const { page, tabId } = await open("ui");
				await showToolbar(h, page, tabId);
				// Changed with the toolbar up: the setting must reach it.
				await sendToTab(tabId, { type: "overlay:settings", blurForms: blur });
				await markElement(page, "#label", "a mark");
				await shotsTaken();
				await saveAs(page, title);
				await close(page);
			};
			await shotOf("Clear", false);
			await shotOf("Blurred", true);
			expect(
				await countColour(h.control, "Clear", "shots/s1.webp", PLAIN),
			).toBeGreaterThan(500);
			expect(
				await countColour(h.control, "Clear", "shots/s1.webp", SECRET),
			).toBe(0);
			// `transition: all 2s` on the field must not fade the blur in too late.
			expect(
				await countColour(h.control, "Blurred", "shots/s1.webp", PLAIN),
			).toBe(0);
		}, 60_000);

		test("a save refused while an AI app holds the page keeps the title and says why", async () => {
			const { page, tabId } = await open("ui");
			await showToolbar(h, page, tabId);
			await markElement(page, "#label", "a mark");
			await shotsTaken();
			await sendToTab(tabId, { type: "page:blur", blurForms: false });
			await page.click(shadow('[data-action="save"]'));
			await page.waitFor(shadow('input[aria-label="Case title"]'));
			await page.eval(
				`(() => { const i = ${shadow('input[aria-label="Case title"]')}; i.focus(); i.select(); })()`,
			);
			await page.type("My own title");
			await page.click(shadow('[data-action="save-confirm"]'));
			await page.waitFor(
				`${shadow('[data-role="status"]')}?.textContent.includes("AI app")`,
			);
			expect(
				await page.eval(`${shadow('input[aria-label="Case title"]')}.value`),
			).toBe("My own title");
			await sendToTab(tabId, { type: "page:unblur" });
			await page.click(shadow('[data-action="save-confirm"]'));
			await page.waitFor(
				`${shadow('[data-role="status"]')}?.textContent.startsWith("Saved")`,
				20_000,
			);
			expect((await saved("My own title")).c.annotations).toHaveLength(1);
			await close(page);
		}, 60_000);

		test("the page hears nothing of the overlay", async () => {
			const { page, tabId } = await open("ui");
			await showToolbar(h, page, tabId);
			await markElement(page, "#label", "a mark");
			const pressEscape = async () => {
				for (const type of ["keyDown", "keyUp"])
					await page.send("Input.dispatchKeyEvent", {
						type,
						key: "Escape",
						code: "Escape",
						windowsVirtualKeyCode: 27,
					});
			};
			await pressEscape(); // the tool goes off; the page's dialog would stay open
			expect(
				await page.eval(
					`${shadow('[data-action="tool-element"]')}.getAttribute("aria-pressed")`,
				),
			).toBe("false");
			expect(await page.eval("heard")).toEqual({
				pointerdown: 0,
				click: 0,
				keydown: 0,
			});
			await close(page);
		}, 60_000);

		test("a focus trap on the page leaves the comment field its focus", async () => {
			const { page, tabId } = await open("ui");
			await page.eval("trapFocus()");
			await showToolbar(h, page, tabId);
			await markElement(page, "#label", "typed despite the trap");
			await shotsTaken();
			await saveAs(page, "Trap");
			const { c } = await saved("Trap");
			expect(c.annotations[0]?.comment).toBe("typed despite the trap");
			await close(page);
		}, 60_000);

		test("the overlay works inside a modal dialog and leaves with it", async () => {
			const { page, tabId } = await open("ui");
			await showToolbar(h, page, tabId);
			await page.eval(`document.getElementById("dialog").showModal()`);
			await page.waitFor(`${HOST}.parentElement.id === "dialog"`);
			await markElement(page, "#in-dialog", "in the dialog");
			await shotsTaken();
			await saveAs(page, "Dialog");
			const { c } = await saved("Dialog");
			expect(c.annotations[0]?.element?.text).toBe("In the dialog");
			await page.eval(`document.getElementById("dialog").close()`);
			await page.waitFor(`${HOST}.parentElement === document.documentElement`);
			await close(page);
		}, 60_000);

		test("saving works on a plain http: host, where crypto.randomUUID does not exist", async () => {
			const url = h.base.replace("127.0.0.1", "overmark.test");
			const page = await h.browser.newPage(`${url}/ui?tab=plain`);
			expect(await page.eval("window.isSecureContext")).toBe(false);
			const tabId = await h.control.eval<number>(
				`chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url?.startsWith(${JSON.stringify(url)}))?.id)`,
			);
			await showToolbar(h, page, tabId);
			await markElement(page, "#label", "on http");
			await shotsTaken();
			await saveAs(page, "Plain http");
			expect((await saved("Plain http")).c.annotations).toHaveLength(1);
			await close(page);
		}, 60_000);

		test("leaving a page with unsaved marks asks first", async () => {
			const { page, tabId } = await open("ui");
			await showToolbar(h, page, tabId);
			const leaving = () =>
				page.eval<boolean>(
					`(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()`,
				);
			expect(await leaving()).toBe(false);
			await markElement(page, "#label", "unsaved");
			expect(await leaving()).toBe(true);
			await shotsTaken();
			await saveAs(page, "Left");
			expect(await leaving()).toBe(false);
			await close(page);
		}, 60_000);

		test("an AI mark takes the visible copy, and says when it no longer held the page", async () => {
			const { page, tabId } = await open("ui");
			await showToolbar(h, page, tabId);
			const mark = (selector: string) =>
				sendToTab<{ ok: boolean; rect?: { width: number }; error?: string }>(
					tabId,
					{
						type: "element:mark",
						selector,
						number: 1,
						blurForms: false,
					},
				);
			expect((await mark(".only")).error).toContain("is visible");
			const marked = await mark(".copy");
			expect(marked.rect?.width).toBeGreaterThan(0);
			expect(
				await sendToTab(tabId, {
					type: "case:show",
					caseId: "x",
					annotationId: "a1",
				}),
			).toEqual({
				error: "An AI app is taking a screenshot; try again in a moment.",
			});
			expect(await sendToTab(tabId, { type: "element:unmark" })).toEqual({
				held: true,
			});
			expect(await sendToTab(tabId, { type: "element:unmark" })).toEqual({
				held: false,
			});
			await close(page);
		}, 60_000);

		test("a comment can be finished before its screenshot is there", async () => {
			const { page, tabId } = await open("ui");
			await showToolbar(h, page, tabId);
			await markElement(page, "#label", "one");
			await markElement(page, "#item", "two");
			await saveAs(page, "Fast");
			const { c, images } = await saved("Fast");
			expect(c.annotations.map((a) => a.comment)).toEqual(["one", "two"]);
			expect(images.some((i) => i.key.includes("/pending/"))).toBe(false);
			await close(page);
		}, 60_000);
	},
);
