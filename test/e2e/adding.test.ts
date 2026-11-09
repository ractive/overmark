/**
 * End to end: with a case open, each mark goes into it as soon as it is done,
 * without a save step (DEC-013). Without a case, the marks are saved as a new
 * case with a title, as before.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "./browser.ts";
import { browserBinary, type Harness, startHarness } from "./harness.ts";
import {
	countColour,
	type Db,
	imagesOf,
	markElement,
	openCase,
	panelHome,
	READ_DB,
	saveAs,
	shadow,
	showToolbar,
	until,
} from "./steps.ts";

const status = `${shadow('[data-role="status"]')}?.textContent`;

/** The mark numbers drawn on the page: drafts, and those in the case (fainter). */
const drawn = (page: Page) =>
	page.eval<{ drafts: string[]; saved: string[] }>(`(() => {
		const svg = ${shadow("svg.marks")};
		const all = [...svg.querySelectorAll("g[data-number]")];
		const numbers = (saved) => all.filter((g) => (g.closest(".saved") !== null) === saved).map((g) => g.dataset.number);
		return { drafts: numbers(false), saved: numbers(true) };
	})()`);

const pressEscape = async (page: Page) => {
	for (const type of ["keyDown", "keyUp"])
		await page.send("Input.dispatchKeyEvent", {
			type,
			key: "Escape",
			code: "Escape",
			windowsVirtualKeyCode: 27,
		});
};

/** The toolbar's buttons, by what they say. */
const buttons = (page: Page) =>
	page.eval<string[]>(
		`[...${shadow(".toolbar")}.querySelectorAll("button")].map((b) => b.textContent).filter(Boolean)`,
	);

describe.skipIf(browserBinary === undefined)("adding marks to a case", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startHarness(browserBinary as string);
	}, 60_000);

	afterAll(async () => {
		await h?.stop();
	});

	/** The toolbar is up on the tab, as the page says. */
	const toolbarUp = (tabId: number) =>
		h.control.eval<boolean>(
			`chrome.tabs.sendMessage(${tabId}, { type: "overlay:state" }).then((s) => s.visible)`,
		);

	const caseTitled = async (title: string) => {
		const db = await h.control.eval<Db>(READ_DB);
		const c = db.cases.find((x) => x.title === title);
		if (c === undefined) throw new Error(`no case ${title}`);
		return { c, db };
	};

	/** A case with one mark, saved from the toolbar, and the toolbar closed. */
	async function savedCase(title: string) {
		const v1 = await h.open("v1");
		await showToolbar(h, v1.page, v1.tabId);
		await markElement(v1.page, "h1", "First");
		await saveAs(v1.page, title);
		await v1.page.click(shadow('[data-action="close"]'));
		await until(
			() => toolbarUp(v1.tabId),
			(up) => !up,
		);
		return v1;
	}

	/** "Add marks" in the side panel's case view. */
	async function addMarks(page: Page, title: string): Promise<Page> {
		await page.activate();
		const panel = await panelHome(h);
		await openCase(panel, title);
		await page.activate();
		await panel.eval(`document.getElementById("add-marks").click()`);
		await page.waitFor(`${status} === "Adding to “${title}”"`);
		return panel;
	}

	test("Add marks puts each mark into the case as it is done, with no save step", async () => {
		const { page, tabId } = await savedCase("Straight in");
		const panel = await addMarks(page, "Straight in");
		const shown = await buttons(page);
		expect(shown).toContain("Done");
		expect(shown).toContain("New case");
		expect(shown.some((b) => b.startsWith("Save"))).toBe(false);
		expect(shown).not.toContain("Back");

		await markElement(page, "[data-truth=submit]", "Too pale");
		await page.waitFor(`${status} === "Mark 2 added to “Straight in”"`, 20_000);
		expect(await drawn(page)).toEqual({ drafts: [], saved: ["1", "2"] });
		// The case view follows.
		await panel.waitFor(
			`document.querySelectorAll(".annotation").length === 2`,
		);

		// A comment closed with Escape keeps its mark: it goes in too. Nothing
		// moved: it shares the screenshot of mark 2, and its shot shows both.
		await page.click(shadow('[data-action="tool-note"]'));
		await page.click(`document.querySelector("[data-truth=tip]")`);
		await page.waitFor(shadow(".popover textarea"));
		await page.type("Say how much");
		await pressEscape(page);
		await page.waitFor(`${status} === "Mark 3 added to “Straight in”"`, 20_000);
		await panel.waitFor(
			`document.querySelectorAll(".annotation").length === 3`,
		);

		const { c, db } = await caseTitled("Straight in");
		expect(c.annotations.map((a) => [a.number, a.comment, a.shot])).toEqual([
			[1, "First", "s1"],
			[2, "Too pale", "s2"],
			[3, "Say how much", "s3"],
		]);
		expect(imagesOf(db, c.id)).toEqual([
			"crops/a1.webp",
			"crops/a2.webp",
			"crops/a3.webp",
			"shots/s1.webp",
			"shots/s2.webp",
			"shots/s3.webp",
		]);
		// Mark 2's pin is on mark 3's screenshot too, as one save would show it.
		const MARK: [number, number, number] = [229, 25, 95];
		expect(
			await countColour(h.control, "Straight in", "shots/s3.webp", MARK),
		).toBeGreaterThan(
			await countColour(h.control, "Straight in", "shots/s2.webp", MARK),
		);
		// The page's picture waits for the next mark while the toolbar is up.
		expect(db.images.some((i) => i.key.includes("/pending/"))).toBe(true);

		await page.click(shadow('[data-action="close"]'));
		await until(
			() => toolbarUp(tabId),
			(up) => !up,
		);
		await until(
			() => h.control.eval<Db>(READ_DB),
			(now) => !now.images.some((i) => i.key.includes("/pending/")),
		);
		await page.send("Page.close");
	}, 90_000);

	test("Undo after an add takes the mark out of the case, and its number comes back", async () => {
		const { page } = await savedCase("Taken back");
		const panel = await addMarks(page, "Taken back");
		await markElement(page, "[data-truth=submit]", "Undo me");
		await page.waitFor(`${status} === "Mark 2 added to “Taken back”"`, 20_000);
		await panel.waitFor(
			`document.querySelectorAll(".annotation").length === 2`,
		);

		await page.click(shadow('[data-action="undo"]'));
		await page.waitFor(
			`${status} === "Mark 2 taken out of “Taken back”"`,
			20_000,
		);
		expect(await drawn(page)).toEqual({ drafts: [], saved: ["1"] });
		await panel.waitFor(
			`document.querySelectorAll(".annotation").length === 1`,
		);
		const { c, db } = await caseTitled("Taken back");
		expect(c.annotations.map((a) => a.number)).toEqual([1]);
		expect(c.shots.map((s) => s.id)).toEqual(["s1"]);
		expect(imagesOf(db, c.id)).toEqual(["crops/a1.webp", "shots/s1.webp"]);
		// Nothing more to take back: the saved case is not this toolbar's to undo.
		expect(
			await page.eval<boolean>(`${shadow('[data-action="undo"]')}.disabled`),
		).toBe(true);

		await markElement(page, "[data-truth=tip]", "Instead");
		await page.waitFor(`${status} === "Mark 2 added to “Taken back”"`, 20_000);
		const after = await caseTitled("Taken back");
		expect(
			after.c.annotations.map((a) => [a.number, a.comment, a.shot]),
		).toEqual([
			[1, "First", "s1"],
			[2, "Instead", "s2"],
		]);
		await page.click(shadow('[data-action="close"]'));
		await page.send("Page.close");
	}, 90_000);

	test("a mark that could not be added stays on the page, says why, and is added on a second try", async () => {
		const { page } = await savedCase("Gone for a moment");
		await addMarks(page, "Gone for a moment");
		const { c } = await caseTitled("Gone for a moment");
		// The case goes from the store behind the panel's back.
		const removeCase = `new Promise((resolve, reject) => {
			const open = indexedDB.open("overmark");
			open.onsuccess = () => {
				const tx = open.result.transaction("cases", "readwrite");
				tx.objectStore("cases").delete(${JSON.stringify(c.id)});
				tx.oncomplete = () => resolve(true);
				tx.onerror = () => reject(tx.error);
			};
		})`;
		const stored = await h.control.eval<object>(`new Promise((resolve) => {
			const open = indexedDB.open("overmark");
			open.onsuccess = () => {
				const get = open.result.transaction("cases").objectStore("cases").get(${JSON.stringify(c.id)});
				get.onsuccess = () => resolve(get.result);
			};
		})`);
		await h.control.eval(removeCase);

		await markElement(page, "[data-truth=submit]", "Kept anyway");
		await page.waitFor(`${status}?.startsWith("Mark 2 was not added")`, 20_000);
		expect(await page.eval<string>(status)).toContain("no longer exists");
		expect(await drawn(page)).toEqual({ drafts: ["2"], saved: ["1"] });
		expect(await buttons(page)).toContain("Add mark 2");

		await h.control.eval(`new Promise((resolve, reject) => {
			const open = indexedDB.open("overmark");
			open.onsuccess = () => {
				const tx = open.result.transaction("cases", "readwrite");
				tx.objectStore("cases").put(${JSON.stringify(stored)});
				tx.oncomplete = () => resolve(true);
				tx.onerror = () => reject(tx.error);
			};
		})`);
		await page.click(shadow('[data-action="retry"]'));
		await page.waitFor(
			`${status} === "Mark 2 added to “Gone for a moment”"`,
			20_000,
		);
		expect(await drawn(page)).toEqual({ drafts: [], saved: ["1", "2"] });
		expect(await buttons(page)).not.toContain("Add mark 2");
		const after = await caseTitled("Gone for a moment");
		expect(after.c.annotations.map((a) => a.comment)).toEqual([
			"First",
			"Kept anyway",
		]);
		await page.click(shadow('[data-action="close"]'));
		await page.send("Page.close");
	}, 90_000);

	test("New case: the marks wait for Save case and a title, as before", async () => {
		const { page, tabId } = await h.open("v1");
		await showToolbar(h, page, tabId);
		expect(await buttons(page)).toContain("Close");
		await markElement(page, "[data-truth=submit]", "Waits");
		expect(await page.eval<string>(status)).toBe("1 mark");
		await Bun.sleep(1500);
		expect(
			(await h.control.eval<Db>(READ_DB)).cases.some((x) =>
				x.annotations.some((a) => a.comment === "Waits"),
			),
		).toBe(false);

		// The form's second button says what it does, and keeps the marks.
		await page.click(shadow('[data-action="save"]'));
		await page.waitFor(shadow('input[aria-label="Case title"]'));
		expect(await buttons(page)).toEqual(["Save case", "Keep drawing"]);
		await page.click(shadow('[data-action="save-cancel"]'));
		expect(await drawn(page)).toEqual({ drafts: ["1"], saved: [] });
		await page.click(shadow('[data-action="undo"]'));
		expect(await drawn(page)).toEqual({ drafts: [], saved: [] });
		await markElement(page, "[data-truth=tip]", "Saved with a title");

		await saveAs(page, "Saved the old way");
		const { c } = await caseTitled("Saved the old way");
		expect(c.annotations.map((a) => [a.number, a.comment])).toEqual([
			[1, "Saved with a title"],
		]);
		// From then on the marks go into that case.
		expect(await buttons(page)).toContain("Done");
		await page.click(shadow('[data-action="close"]'));
		await page.send("Page.close");
	}, 90_000);
});
