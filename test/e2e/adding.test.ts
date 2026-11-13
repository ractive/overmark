/**
 * End to end: with a case open, each mark goes into it as soon as it is done,
 * without a save step (DEC-014). Without a case, the marks are saved as a new
 * case with a title, as before.
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
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
	resetPanel,
	saveAs,
	shadow,
	showToolbar,
	until,
} from "./steps.ts";

const status = `${shadow('[data-role="status"]')}?.textContent`;
const alert = `${shadow('[data-role="alert"]')}?.textContent`;

/** The mark numbers drawn on the page: drafts, and those in the case (fainter). */
/**
 * The marks on the page: drafts, and the case's own (fainter while adding to
 * it, or drawn by the loaded case: opening a case draws it, DEC-022).
 */
const drawn = (page: Page) =>
	page.eval<{ drafts: string[]; saved: string[] }>(`(() => {
		const svg = ${shadow("svg.marks")};
		const all = [...svg.querySelectorAll("g[data-number]")].filter((g) => g.closest("[data-review]") === null);
		const numbers = (saved) => all.filter((g) => (g.closest(".saved") !== null) === saved).map((g) => g.dataset.number);
		const review = [...svg.querySelectorAll("[data-review]")].map((g) => g.dataset.review);
		const saved = [...new Set([...numbers(true), ...review])].sort((a, b) => a - b);
		return { drafts: numbers(false), saved };
	})()`);

/** Until the page draws these marks (the loaded case follows a change a moment later). */
const drawnAre = async (
	page: Page,
	want: { drafts: string[]; saved: string[] },
) => {
	const json = JSON.stringify(want);
	const got = await until(
		() => drawn(page),
		(now) => JSON.stringify(now) === json,
	).catch(() => drawn(page));
	expect(got).toEqual(want);
};

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

	// No page of a test before, the control page (a panel too) on Home.
	beforeEach(() => resetPanel(h));

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

	/** Take a case out of the store behind the panel's back; answers it to put back. */
	async function takeOut(caseId: string): Promise<object> {
		return h.control.eval<object>(`new Promise((resolve, reject) => {
			const open = indexedDB.open("overmark");
			open.onsuccess = () => {
				const tx = open.result.transaction("cases", "readwrite");
				const cases = tx.objectStore("cases");
				const get = cases.get(${JSON.stringify(caseId)});
				get.onsuccess = () => cases.delete(${JSON.stringify(caseId)});
				tx.oncomplete = () => resolve(get.result);
				tx.onerror = () => reject(tx.error);
			};
		})`);
	}

	async function putBack(value: object): Promise<void> {
		await h.control.eval(`new Promise((resolve, reject) => {
			const open = indexedDB.open("overmark");
			open.onsuccess = () => {
				const tx = open.result.transaction("cases", "readwrite");
				tx.objectStore("cases").put(${JSON.stringify(value)});
				tx.oncomplete = () => resolve(true);
				tx.onerror = () => reject(tx.error);
			};
		})`);
	}

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
	async function addMarks(
		page: Page,
		title: string,
		says = `Adding to “${title}”`,
	): Promise<Page> {
		await page.activate();
		const panel = await panelHome(h);
		await openCase(panel, title);
		await page.activate();
		// The case's marks follow it to the page (DEC-022): drawn before the
		// toolbar comes, as a person's click on Add marks would find them.
		const { c } = await caseTitled(title);
		const tabId = await h.control.eval<number>(
			`chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t.id)`,
		);
		await until(
			() =>
				h.control.eval<string | null>(
					`chrome.tabs.sendMessage(${tabId}, { type: "overlay:state" }).then((s) => s.loadedCase ?? null, () => null)`,
				),
			(loaded) => loaded === c.id,
		);
		await panel.eval(`document.getElementById("add-marks").click()`);
		await page.waitFor(`${status} === ${JSON.stringify(says)}`);
		return panel;
	}

	test("Add marks puts each mark into the case as it is done, with no save step", async () => {
		const { page, tabId } = await savedCase("Straight in");
		const panel = await addMarks(page, "Straight in");
		const shown = await buttons(page);
		expect(shown).toContain("Done");
		// A new case starts with All cases, then Annotate this page (DEC-023).
		expect(shown).not.toContain("New case");
		expect(shown.some((b) => b.startsWith("Save"))).toBe(false);
		expect(shown).not.toContain("Back");

		await markElement(page, "[data-truth=submit]", "Too pale");
		await page.waitFor(`${status} === "Mark 2 added to “Straight in”"`, 20_000);
		await drawnAre(page, { drafts: [], saved: ["1", "2"] });
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
		await drawnAre(page, { drafts: [], saved: ["1"] });
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

		// Shown again, Undo reaches no mark of the earlier session.
		await page.click(shadow('[data-action="close"]'));
		await addMarks(page, "Taken back");
		expect(
			await page.eval<boolean>(`${shadow('[data-action="undo"]')}.disabled`),
		).toBe(true);
		await page.click(shadow('[data-action="close"]'));
		await page.send("Page.close");
	}, 90_000);

	test("a mark that could not be added stays on the page, says why, and is added on a second try", async () => {
		const { page, tabId } = await savedCase("Gone for a moment");
		await addMarks(page, "Gone for a moment");
		const { c } = await caseTitled("Gone for a moment");
		const stored = await takeOut(c.id);

		await markElement(page, "[data-truth=submit]", "Kept anyway");
		await page.waitFor(`${alert}?.startsWith("Mark 2 was not added")`, 20_000);
		expect(await page.eval<string>(alert)).toContain("no longer exists");
		expect(
			await page.eval<string>(
				`${shadow('[data-role="alert"]')}.getAttribute("role")`,
			),
		).toBe("alert");
		expect(await page.eval<string>(status)).toBe(
			"Mark 2 is not in “Gone for a moment” yet",
		);
		await drawnAre(page, { drafts: ["2"], saved: ["1"] });
		expect(await buttons(page)).toContain("Add mark 2");

		// Done tries once more, and stays while the mark is not in the case.
		await page.click(shadow('[data-action="close"]'));
		await page.waitFor(
			`${alert} === "Mark 2 is not in the case yet: Add mark 2, or Done again to discard it."`,
			20_000,
		);
		expect(await toolbarUp(tabId)).toBe(true);

		await putBack(stored);
		await page.click(shadow('[data-action="retry"]'));
		await page.waitFor(
			`${status} === "Mark 2 added to “Gone for a moment”"`,
			20_000,
		);
		expect(await page.eval<string>(alert)).toBe("");
		await drawnAre(page, { drafts: [], saved: ["1", "2"] });
		expect(await buttons(page)).not.toContain("Add mark 2");
		const after = await caseTitled("Gone for a moment");
		expect(after.c.annotations.map((a) => a.comment)).toEqual([
			"First",
			"Kept anyway",
		]);
		await page.click(shadow('[data-action="close"]'));
		await until(
			() => toolbarUp(tabId),
			(up) => !up,
		);
		await page.send("Page.close");
	}, 90_000);

	test("Done again discards a mark that could not be added", async () => {
		const { page, tabId } = await savedCase("Discarded");
		await addMarks(page, "Discarded");
		const { c } = await caseTitled("Discarded");
		const stored = await takeOut(c.id);
		await markElement(page, "[data-truth=submit]", "Never stored");
		await page.waitFor(`${alert}?.startsWith("Mark 2 was not added")`, 20_000);
		await page.click(shadow('[data-action="close"]'));
		await page.waitFor(
			`${alert}?.includes("Done again to discard it")`,
			20_000,
		);
		await page.click(shadow('[data-action="close"]'));
		await until(
			() => toolbarUp(tabId),
			(up) => !up,
		);
		await putBack(stored);
		// Shown again, the mark is gone, and nothing was added meanwhile.
		await addMarks(page, "Discarded");
		await drawnAre(page, { drafts: [], saved: ["1"] });
		expect((await caseTitled("Discarded")).c.annotations).toHaveLength(1);
		await page.click(shadow('[data-action="close"]'));
		await page.send("Page.close");
	}, 90_000);

	test("a mark that failed for one case does not go into another one unasked", async () => {
		// One tab per address: the harness finds a tab by its address.
		await (await savedCase("Case B")).page.send("Page.close");
		const { page } = await savedCase("Case A");
		await addMarks(page, "Case A");
		const a = (await caseTitled("Case A")).c;
		const stored = await takeOut(a.id);
		await markElement(page, "[data-truth=submit]", "Meant for A");
		await page.waitFor(`${alert}?.startsWith("Mark 2 was not added")`, 20_000);

		// The side panel switches the toolbar to case B.
		await putBack(stored);
		await addMarks(page, "Case B", "Mark 2 is not in “Case B” yet");
		await page.waitFor(`${alert}?.includes("it was for “Case A”")`, 10_000);
		await Bun.sleep(1500);
		const b = (await caseTitled("Case B")).c;
		expect(b.annotations.map((x) => x.comment)).toEqual(["First"]);
		expect((await caseTitled("Case A")).c.annotations).toHaveLength(1);
		// B's own mark is on the page: opening B drew it (DEC-022).
		await drawnAre(page, { drafts: ["2"], saved: ["1"] });

		// "Add mark 2" is the user's choice: then it goes into B.
		await page.click(shadow('[data-action="retry"]'));
		await page.waitFor(`${status} === "Mark 2 added to “Case B”"`, 20_000);
		expect(
			(await caseTitled("Case B")).c.annotations.map((x) => x.comment),
		).toEqual(["First", "Meant for A"]);
		await page.click(shadow('[data-action="close"]'));
		await page.send("Page.close");
	}, 90_000);

	test("New case: the marks wait for Save case and a title, as before", async () => {
		// No case open in the panel: its marks would follow to the new tab.
		await panelHome(h);
		const { page, tabId } = await h.open("v1");
		await showToolbar(h, page, tabId);
		expect(await buttons(page)).toContain("Close");
		await markElement(page, "[data-truth=submit]", "Waits");
		expect(await page.eval<string>(status)).toBe("New case: 1 mark");
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
		await drawnAre(page, { drafts: ["1"], saved: [] });
		await page.click(shadow('[data-action="undo"]'));
		await drawnAre(page, { drafts: [], saved: [] });
		await markElement(page, "[data-truth=tip]", "Saved with a title");

		await saveAs(page, "Saved the old way");
		const { c } = await caseTitled("Saved the old way");
		expect(c.annotations.map((a) => [a.number, a.comment])).toEqual([
			[1, "Saved with a title"],
		]);
		// From then on the marks go into that case, and the panel shows it.
		expect(await buttons(page)).toContain("Done");
		await h.control.waitFor(
			`!document.getElementById("case-view").hidden && document.querySelector("#case-view h2")?.textContent === "Saved the old way" && document.getElementById("add-marks").textContent === "Done adding"`,
			10_000,
		);
		await page.click(shadow('[data-action="close"]'));
		await h.control.waitFor(
			`document.getElementById("add-marks").textContent === "Add marks"`,
		);
		await page.send("Page.close");
	}, 90_000);

	/**
	 * "← All cases" in the panel, as a person clicks it: a click within half
	 * a second of one it did something else for counts as that double click.
	 */
	const allCases = async (panel: Page) => {
		await Bun.sleep(600);
		await panel.eval(`document.getElementById("back").click()`);
	};
	const home = (panel: Page) =>
		panel.waitFor(`!document.getElementById("home").hidden`, 10_000);

	test("Add marks, then All cases: no toolbar, no marks, and the next mark is a new case's", async () => {
		const { page, tabId } = await savedCase("Closed after adding");
		const panel = await addMarks(page, "Closed after adding");
		await markElement(page, "[data-truth=submit]", "Second");
		await page.waitFor(
			`${status} === "Mark 2 added to “Closed after adding”"`,
			20_000,
		);
		await drawnAre(page, { drafts: [], saved: ["1", "2"] });

		await allCases(panel);
		await home(panel);
		await until(
			() => toolbarUp(tabId),
			(up) => !up,
		);
		// The case's marks leave the page, its toolbar is no longer its.
		await drawnAre(page, { drafts: [], saved: [] });
		await panel.waitFor(
			`document.getElementById("annotate").textContent === "Annotate this page"`,
		);
		expect(
			await h.control.eval<string | null>(
				`chrome.tabs.sendMessage(${tabId}, { type: "overlay:state" }).then((s) => s.target?.caseId ?? null)`,
			),
		).toBeNull();

		await panel.eval(`document.getElementById("annotate").click()`);
		await page.waitFor(`${status} === "New case: choose a tool"`);
		await markElement(page, "h1", "A new case's");
		await page.waitFor(`${status} === "New case: 1 mark"`);
		await drawnAre(page, { drafts: ["1"], saved: [] });
		await Bun.sleep(1000);
		expect(
			(await caseTitled("Closed after adding")).c.annotations,
		).toHaveLength(2);
		await panel.waitFor(
			`document.getElementById("annotate-hint").textContent === "1 mark drawn. Click Save case… on the page's toolbar to keep it."`,
		);
		await page.click(shadow('[data-action="undo"]'));
		await page.click(shadow('[data-action="close"]'));
		await page.send("Page.close");
	}, 90_000);

	test("All cases after a blocked one: the page decides, a later mark that fails blocks again", async () => {
		const { page, tabId } = await savedCase("Blocked once");
		const panel = await addMarks(page, "Blocked once");
		const { c } = await caseTitled("Blocked once");
		const leaveHint = `document.getElementById("leave-hint")`;
		let stored = await takeOut(c.id);
		await markElement(page, "[data-truth=submit]", "Second");
		await page.waitFor(`${alert}?.startsWith("Mark 2 was not added")`, 20_000);
		await allCases(panel);
		await panel.waitFor(
			`!${leaveHint}.hidden && ${leaveHint}.textContent.startsWith("1 mark is not in the case yet")`,
			20_000,
		);

		// The mark goes in after all: the panel says nothing more about it.
		await putBack(stored);
		await page.click(shadow('[data-action="retry"]'));
		await page.waitFor(
			`${status} === "Mark 2 added to “Blocked once”"`,
			20_000,
		);
		await panel.waitFor(`${leaveHint}.hidden`, 10_000);

		// Much later a mark fails again: the first click finishes, it does not
		// discard.
		stored = await takeOut(c.id);
		await markElement(page, "[data-truth=tip]", "Third");
		await page.waitFor(`${alert}?.startsWith("Mark 3 was not added")`, 20_000);
		await allCases(panel);
		await panel.waitFor(
			`!${leaveHint}.hidden && ${leaveHint}.textContent.startsWith("1 mark is not in the case yet")`,
			20_000,
		);
		expect(await toolbarUp(tabId)).toBe(true);
		await drawnAre(page, { drafts: ["3"], saved: ["1", "2"] });
		await putBack(stored);
		// The second click leaves without it.
		await allCases(panel);
		await home(panel);
		await until(
			() => toolbarUp(tabId),
			(up) => !up,
		);
		expect(
			(await caseTitled("Blocked once")).c.annotations.map((a) => a.comment),
		).toEqual(["First", "Second"]);
		await page.send("Page.close");
	}, 120_000);

	test("All cases with a mark not in the case: the panel stays and says so; again leaves without it", async () => {
		const { page, tabId } = await savedCase("Left behind");
		const panel = await addMarks(page, "Left behind");
		const { c } = await caseTitled("Left behind");
		const stored = await takeOut(c.id);
		await markElement(page, "[data-truth=submit]", "Not in it");
		await page.waitFor(`${alert}?.startsWith("Mark 2 was not added")`, 20_000);

		await allCases(panel);
		await panel.waitFor(
			`document.getElementById("leave-hint")?.textContent === "1 mark is not in the case yet; the toolbar on the page says why. Click All cases again to leave without it."`,
			20_000,
		);
		expect(
			await panel.eval<boolean>(`document.getElementById("case-view").hidden`),
		).toBe(false);
		expect(await toolbarUp(tabId)).toBe(true);
		await putBack(stored);

		await allCases(panel);
		await home(panel);
		await until(
			() => toolbarUp(tabId),
			(up) => !up,
		);
		await drawnAre(page, { drafts: [], saved: [] });
		expect((await caseTitled("Left behind")).c.annotations).toHaveLength(1);
		await page.send("Page.close");
	}, 90_000);
});
