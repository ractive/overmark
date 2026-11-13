/**
 * End to end: what only the whole side panel shows, in its real page with the
 * real extension (`main.ts` has no unit tests). The tests write the store
 * directly where a case's marks do not matter, and replace a `chrome.*`
 * function of the panel's page to make a page slow or a permission answer.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestRelay } from "@ractive-ch/tab-mcp/testing";
import type { Case } from "../../src/lib/case.ts";
import { exportCase } from "../../src/lib/export.ts";
import { MemoryStore } from "../../src/lib/store.ts";
import { sampleCase } from "../fixtures.ts";
import {
	answerInPanel,
	closeSidePanel,
	mcpClient,
	openSidePanel,
	setRelay,
} from "./ai.ts";
import type { Page } from "./browser.ts";
import { browserBinary, type Harness, startHarness } from "./harness.ts";
import {
	type Db,
	markElement,
	READ_DB,
	saveAs,
	settingsOf,
	shadow,
	showToolbar,
	worker,
} from "./steps.ts";

const id = (name: string) => `document.getElementById(${JSON.stringify(name)})`;

/** Until `check` says yes. */
async function until(
	check: () => Promise<boolean>,
	what: string,
	timeoutMs = 5000,
): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

/** A test with room for a slow machine: one that times out runs on into the next. */
const slowTest = (name: string, run: () => Promise<void>) =>
	test(name, run, 60_000);

describe.skipIf(browserBinary === undefined)("the side panel's page", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startHarness(browserBinary as string);
	}, 60_000);

	afterAll(async () => {
		await h?.stop();
	});

	const panelUrl = () =>
		`chrome-extension://${h.extensionId}/sidepanel/index.html`;
	const openPanel = () => h.control.goto(panelUrl());
	const readDb = () => h.control.eval<Db>(READ_DB);
	const storedCase = async (caseId: string) =>
		(await h.control.eval<{ cases: Case[] }>(READ_DB)).cases.find(
			(c) => c.id === caseId,
		);

	/** Write these cases over what the store has. */
	const putCases = (cases: Case[]) =>
		h.control.eval(`new Promise((resolve, reject) => {
			const open = indexedDB.open("overmark");
			open.onerror = () => reject(open.error);
			open.onsuccess = () => {
				const tx = open.result.transaction("cases", "readwrite");
				for (const c of ${JSON.stringify(cases)}) tx.objectStore("cases").put(c);
				tx.oncomplete = () => { open.result.close(); resolve(); };
				tx.onerror = () => reject(tx.error);
			};
		})`);

	/** The panel on an empty store with these cases and no settings. */
	async function fresh(cases: Case[] = []): Promise<void> {
		await h.control.eval(`new Promise((resolve, reject) => {
			const open = indexedDB.open("overmark");
			open.onerror = () => reject(open.error);
			open.onsuccess = () => {
				const tx = open.result.transaction(["cases", "images"], "readwrite");
				tx.objectStore("cases").clear();
				tx.objectStore("images").clear();
				tx.oncomplete = () => { open.result.close(); resolve(); };
				tx.onerror = () => reject(tx.error);
			};
		})`);
		await putCases(cases);
		// Blur form fields is the worker's; the blur test turns it off again.
		await h.control.eval(`localStorage.clear()`);
		await openPanel();
	}

	/** Open the case with this id in `page`. */
	async function openCase(caseId: string, page = h.control): Promise<void> {
		const item = `document.querySelector('button[data-case="${caseId}"]')`;
		await page.waitFor(item);
		await page.eval(`${item}.click()`);
		await page.waitFor(`${id("verdict")}?.dataset.case === "${caseId}"`);
	}

	const backHome = (page = h.control) =>
		page.eval(`document.getElementById("back").click()`);

	/** What typing does; a script's `value` alone tells the panel nothing. */
	const typeVerdict = (text: string, page = h.control) =>
		page.eval(
			`(() => { const v = ${id("verdict")}; v.value = ${JSON.stringify(text)}; v.dispatchEvent(new Event("input")); })()`,
		);

	/** Make `chrome.tabs.sendMessage` in the panel go through `body`. */
	const wrapSend = (body: string) =>
		h.control.eval(
			`(() => { const send = chrome.tabs.sendMessage.bind(chrome.tabs); chrome.tabs.sendMessage = (tabId, message) => (${body})(tabId, message, send); })()`,
		);

	/** "Save case…" opened the case `title` in the panel (DEC-023): back to the list. */
	async function afterSave(title: string, page = h.control): Promise<void> {
		await page.waitFor(
			`document.querySelector("#case-view h2")?.textContent === ${JSON.stringify(title)}`,
			10_000,
		);
		await backHome(page);
		await page.waitFor(`!${id("home")}.hidden`);
	}

	/** A page with a saved case of one mark, and that case's id. */
	async function annotated(title: string) {
		const { page, tabId } = await h.open("v1");
		await showToolbar(h, page, tabId);
		await markElement(page, "h1", "Too long");
		await saveAs(page, title);
		// "Save case…" opens the case in the panel (DEC-023): back to the
		// list, which ends the toolbar (as its Done) and takes the marks off.
		await afterSave(title);
		const saved = (await readDb()).cases.find((c) => c.title === title);
		return { page, tabId, caseId: saved?.id as string };
	}

	/**
	 * The case's marks on the tab in front: opening a case of that page loads
	 * it already, and the button would then hide them.
	 */
	const showMarks = async () => {
		await h.control.eval(
			`${id("load-case")}.textContent === "Show marks" && ${id("load-case")}.click()`,
		);
		await h.control.waitFor(
			`${id("case-hint")}.textContent.includes("marks found")`,
		);
	};

	/** The case whose marks the page shows; `null` also where no content script runs (yet). */
	const pageCase = (tabId: number) =>
		h.control.eval<string | null>(
			`chrome.tabs.sendMessage(${tabId}, { type: "overlay:state" }).then((s) => s.loadedCase ?? null, () => null)`,
		);

	const overlayOf = (tabId: number) =>
		h.control.eval<{ loadedCase?: string }>(
			`chrome.tabs.sendMessage(${tabId}, { type: "overlay:state" })`,
		);

	/** Both clicks of a deliberate Delete. */
	async function confirmDelete(): Promise<void> {
		await h.control.eval(`${id("delete-case")}.click()`);
		await Bun.sleep(600);
		await h.control.eval(`${id("delete-case")}.click()`);
		await h.control.waitFor(`!${id("home")}.hidden`);
	}

	/** Pick a file in the panel's import field. */
	async function importFile(name: string, bytes: Uint8Array): Promise<void> {
		const base64 = Buffer.from(bytes).toString("base64");
		await h.control.eval(`(() => {
			const bytes = Uint8Array.from(atob("${base64}"), (c) => c.charCodeAt(0));
			const data = new DataTransfer();
			data.items.add(new File([bytes], ${JSON.stringify(name)}, { type: "application/zip" }));
			const input = ${id("import-file")};
			input.files = data.files;
			input.dispatchEvent(new Event("change"));
		})()`);
	}

	const zipOf = (c: Case) => exportCase(new MemoryStore(), c);

	slowTest(
		"Delete keeps the keyboard's focus, so Enter can confirm it",
		async () => {
			await fresh([sampleCase("c_keys")]);
			await openCase("c_keys");
			await h.control.activate();
			await h.control.eval(`${id("delete-case")}.focus()`);
			const enter = async () => {
				for (const type of ["keyDown", "keyUp"])
					await h.control.send("Input.dispatchKeyEvent", {
						type,
						key: "Enter",
						code: "Enter",
						windowsVirtualKeyCode: 13,
						...(type === "keyDown" ? { text: "\r" } : {}),
					});
			};
			await enter();
			await h.control.waitFor(
				`${id("delete-case")}.textContent === "Really delete?"`,
			);
			expect(await h.control.eval(`document.activeElement?.id`)).toBe(
				"delete-case",
			);
			await Bun.sleep(600);
			await enter();
			await h.control.waitFor(`!${id("home")}.hidden`);
			expect(await storedCase("c_keys")).toBeUndefined();
		},
	);

	slowTest("a double-click on Delete deletes nothing", async () => {
		await fresh([sampleCase("c_twice")]);
		await openCase("c_twice");
		await h.control.activate();
		await h.control.eval(
			`(() => { const d = ${id("delete-case")}; d.click(); d.click(); })()`,
		);
		await Bun.sleep(100);
		expect(await storedCase("c_twice")).toBeDefined();
		expect(await h.control.eval(`${id("delete-case")}.textContent`)).toBe(
			"Really delete?",
		);
		await Bun.sleep(500);
		await h.control.eval(`${id("delete-case")}.click()`);
		await h.control.waitFor(`!${id("home")}.hidden`);
		expect(await storedCase("c_twice")).toBeUndefined();
	});

	slowTest(
		"Delete disarms by itself: a click much later only asks again",
		async () => {
			await fresh([sampleCase("c_late")]);
			await openCase("c_late");
			await h.control.activate();
			await h.control.eval(`${id("delete-case")}.click()`);
			await h.control.waitFor(
				`${id("delete-case")}.textContent === "Delete"`,
				6000,
			);
			await h.control.eval(`${id("delete-case")}.click()`);
			await h.control.waitFor(
				`${id("delete-case")}.textContent === "Really delete?"`,
			);
			expect(await storedCase("c_late")).toBeDefined();
		},
	);

	slowTest(
		"a verdict not saved comes back with its case, and only there",
		async () => {
			await fresh([sampleCase("c_one"), sampleCase("c_two")]);
			await openCase("c_one");
			await typeVerdict("Darker, as agreed");
			await backHome();
			await openCase("c_two");
			expect(await h.control.eval(`${id("verdict")}.value`)).toBe("");
			await backHome();
			await openCase("c_one");
			expect(await h.control.eval(`${id("verdict")}.value`)).toBe(
				"Darker, as agreed",
			);
			expect(await h.control.eval(`${id("verdict-status")}.textContent`)).toBe(
				"Not saved yet",
			);
			expect((await storedCase("c_one"))?.verdict).toBeNull();
			// Saved, it is no draft any more.
			await h.control.eval(`${id("save-verdict")}.click()`);
			await h.control.waitFor(
				`${id("verdict-status")}.textContent === "Saved"`,
			);
			await backHome();
			await openCase("c_one");
			expect(await h.control.eval(`${id("verdict")}.value`)).toBe(
				"Darker, as agreed",
			);
			expect((await storedCase("c_one"))?.verdict).toBe("Darker, as agreed");
		},
	);

	slowTest(
		"a panel in another window follows; a saved verdict shows what is stored",
		async () => {
			await fresh([sampleCase("c_both")]);
			const other = await h.browser.newPage(panelUrl());
			await openCase("c_both");
			await openCase("c_both", other);

			// Saved with a newline: the stored text is trimmed, and so is the field.
			await typeVerdict("abc\n");
			await h.control.eval(`${id("save-verdict")}.click()`);
			await h.control.waitFor(`${id("verdict")}.value === "abc"`);
			await other.waitFor(`${id("verdict")}.value === "abc"`);

			// Saved in the other window: this one is not typing, so it follows.
			await typeVerdict("From the other window", other);
			await other.eval(`${id("save-verdict")}.click()`);
			await h.control.waitFor(
				`${id("verdict")}.value === "From the other window"`,
			);

			// Deleted in the other window: this one leaves the case.
			await other.eval(`${id("delete-case")}.click()`);
			await Bun.sleep(600);
			await other.eval(`${id("delete-case")}.click()`);
			await h.control.waitFor(`!${id("home")}.hidden`);
			await other.send("Page.close");
		},
	);

	slowTest("a deleted case's outlines leave the page", async () => {
		await fresh();
		const { page, tabId, caseId } = await annotated("Outlined");
		await openPanel();
		await openCase(caseId);
		await page.activate();
		await showMarks();
		expect((await overlayOf(tabId)).loadedCase).toBe(caseId);
		await confirmDelete();
		await until(
			async () => (await overlayOf(tabId)).loadedCase === undefined,
			"the outlines to go",
		);
		await page.send("Page.close");
	});

	slowTest(
		"the outlines of a case an AI app loaded leave the page too",
		async () => {
			await fresh();
			const { page, tabId, caseId } = await annotated("Loaded by a tool");
			await openPanel();
			await page.activate();
			const c = await storedCase(caseId);
			// As load_case does; the panel's `loaded` knows nothing of it.
			await h.control.eval(
				`chrome.tabs.sendMessage(${tabId}, { type: "case:load", case: ${JSON.stringify(c)} })`,
			);
			await openCase(caseId);
			await confirmDelete();
			await until(
				async () => (await overlayOf(tabId)).loadedCase === undefined,
				"the outlines to go",
			);
			await page.send("Page.close");
		},
	);

	slowTest("a case a tool deleted leaves the page as well", async () => {
		await fresh();
		const { page, tabId, caseId } = await annotated("Deleted by a tool");
		await openPanel();
		await page.activate();
		const c = await storedCase(caseId);
		await h.control.eval(
			`chrome.tabs.sendMessage(${tabId}, { type: "case:load", case: ${JSON.stringify(c)} })`,
		);
		await h.control.waitFor(`${id("page")}.textContent.endsWith("/v1")`);
		// What the panel of the window where the tool ran tells this one.
		const other = await h.browser.newPage(panelUrl());
		await page.activate();
		await other.eval(`new Promise((resolve, reject) => {
			const open = indexedDB.open("overmark");
			open.onerror = () => reject(open.error);
			open.onsuccess = () => {
				const tx = open.result.transaction("cases", "readwrite");
				tx.objectStore("cases").delete(${JSON.stringify(caseId)});
				tx.oncomplete = () => { open.result.close(); resolve(); };
			};
		})`);
		await other.eval(
			`chrome.runtime.sendMessage({ type: "cases:changed", caseId: ${JSON.stringify(caseId)} })`,
		);
		await until(
			async () => (await overlayOf(tabId)).loadedCase === undefined,
			"the outlines to go",
		);
		await other.send("Page.close");
		await page.send("Page.close");
	});

	slowTest("Show says so when the page is busy", async () => {
		await fresh();
		const { page, caseId } = await annotated("Busy page");
		await openPanel();
		await openCase(caseId);
		await page.activate();
		await showMarks();
		const show = `document.querySelector('[data-action="show"]')`;
		await h.control.waitFor(show);
		await wrapSend(`(tabId, message, send) =>
			message.type === "case:show"
				? Promise.resolve({ error: "Overmark is saving on this page." })
				: send(tabId, message)`);
		await h.control.eval(`${show}.click()`);
		await h.control.waitFor(
			`${id("case-hint")}.textContent === "Overmark is saving on this page."`,
		);
		// The match it showed stays.
		expect(await h.control.eval(`Boolean(${show})`)).toBe(true);
		await page.send("Page.close");
	});

	slowTest(
		"the outcome of a draw does not land on the case opened meanwhile",
		async () => {
			// One mark without an element: "0 of 1 marks found" is this case's.
			const slow: Case = {
				...sampleCase("c_slow"),
				annotations: [
					{
						id: "a1",
						number: 1,
						shot: "s1",
						comment: "Somewhere",
						author: "user",
						shape: { kind: "note", at: { x: 1, y: 1 } },
						crop: "crops/a1.webp",
						element: null,
					},
				],
			};
			await fresh([slow, sampleCase("c_next")]);
			const { page, tabId } = await h.open("v1");
			await page.activate();
			await h.control.eval(
				`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ["content.js"] })`,
			);
			// The page draws c_slow, and its answer comes only after c_next's.
			await h.control.eval(`globalThis.leftCase = false`);
			await wrapSend(`async (tabId, message, send) => {
				const slow = message.type === "case:load" && message.case.id === "c_slow";
				if (slow) globalThis.sent = true;
				const answer = await send(tabId, message);
				if (slow) {
					while (!globalThis.leftCase)
						await new Promise((r) => setTimeout(r, 20));
					globalThis.answered = true;
				}
				return answer;
			}`);
			await openCase("c_slow");
			await h.control.waitFor(`globalThis.sent`);
			await backHome();
			await openCase("c_next");
			await h.control.waitFor(
				`${id("case-hint")}.textContent.includes("0 of 0 marks found")`,
			);
			await h.control.eval(`globalThis.leftCase = true`);
			await h.control.waitFor(`globalThis.answered`);
			await Bun.sleep(300);
			expect(await h.control.eval(`${id("case-hint")}.textContent`)).toContain(
				"0 of 0 marks found",
			);
			expect((await overlayOf(tabId)).loadedCase).toBe("c_next");
			// The panel still knows they are its own: back to the list takes them off.
			await backHome();
			await until(
				async () => (await overlayOf(tabId)).loadedCase === undefined,
				"the marks to go",
			);
			await page.send("Page.close");
		},
	);

	slowTest(
		"news from the tab just left does not stop the panel following",
		async () => {
			await fresh();
			const a = await h.open("v1");
			await a.page.activate();
			await h.control.eval(
				`chrome.scripting.executeScript({ target: { tabId: ${a.tabId} }, files: ["content.js"] })`,
			);
			await openPanel();
			await h.control.waitFor(`${id("page")}.textContent.endsWith("/v1")`);
			// The tab now in front is slow to answer.
			await h.control.eval(`globalThis.slow = true`);
			await wrapSend(`async (tabId, message, send) => {
			while (globalThis.slow && tabId !== ${a.tabId} && message.type === "overlay:state")
				await new Promise((r) => setTimeout(r, 20));
			return send(tabId, message);
		}`);
			const b = await h.open("v2");
			await b.page.activate();
			await h.control.eval(
				`chrome.tabs.sendMessage(${a.tabId}, { type: "overlay:show" })`,
			);
			await Bun.sleep(200);
			await h.control.eval(`globalThis.slow = false`);
			await h.control.waitFor(`${id("page")}.textContent.endsWith("/v2")`);
			await a.page.send("Page.close");
			await b.page.send("Page.close");
		},
	);

	slowTest(
		"Replace asks again when the case changed under the prompt",
		async () => {
			const c: Case = { ...sampleCase("c_file"), verdict: "From the file" };
			await fresh([{ ...c, verdict: "Stored" }]);
			await importFile("case.overmark.zip", await zipOf(c));
			const replace = `document.querySelector('[data-action="import-replace"]')`;
			await h.control.waitFor(replace);

			// An AI app's change, say, while the prompt is open.
			const changed = {
				...c,
				verdict: "Newer",
				updatedAt: "2026-11-05T10:00:00Z",
			};
			await putCases([changed]);
			const asked = await h.control.eval<string>(
				`${id("import-prompt")}.textContent`,
			);
			await h.control.eval(`${replace}.click()`);
			await h.control.waitFor(
				`${id("import-prompt")}.textContent !== ${JSON.stringify(asked)}`,
			);
			expect(await h.control.eval(`${id("import-prompt")}.hidden`)).toBe(false);
			expect((await storedCase("c_file"))?.verdict).toBe("Newer");

			// Knowing that, the user replaces it after all.
			await h.control.eval(`${replace}.click()`);
			await h.control.waitFor(`${id("verdict")}?.value === "From the file"`);
			expect((await storedCase("c_file"))?.verdict).toBe("From the file");
		},
	);

	slowTest(
		"an imported case goes onto the tab in front, whatever its page",
		async () => {
			await fresh();
			const { page, tabId } = await h.open("v1");
			await page.activate();
			const onPage = (id: string, path: string): Case => {
				const c = sampleCase(id);
				return { ...c, page: { ...c.page, url: `${h.base}/${path}` } };
			};
			await importFile(
				"other.overmark.zip",
				await zipOf(onPage("c_far", "v2")),
			);
			await h.control.waitFor(`${id("verdict")}?.dataset.case === "c_far"`);
			await until(
				async () => (await overlayOf(tabId)).loadedCase === "c_far",
				"the case on the page",
			);
			// Back to the list: its marks leave the page.
			await h.control.eval(`document.getElementById("back").click()`);
			await h.control.waitFor(`!${id("home")}.hidden`);
			await until(
				async () => (await overlayOf(tabId)).loadedCase === undefined,
				"the marks to go",
			);
			await importFile(
				"here.overmark.zip",
				await zipOf(onPage("c_here", "v1")),
			);
			await h.control.waitFor(
				`${id("case-hint")}?.textContent.includes("marks found")`,
			);
			expect((await overlayOf(tabId)).loadedCase).toBe("c_here");
			await page.send("Page.close");
		},
	);

	slowTest(
		"opening a case draws its marks on the tab in front, and they follow to the next tab",
		async () => {
			await fresh();
			const a = await annotated("Follows the tab");
			const b = await h.open("v2");
			await b.page.activate();
			await openPanel();
			await openCase(a.caseId);
			// No click: the case is for v1, and v2 is in front.
			await until(
				async () => (await pageCase(b.tabId)) === a.caseId,
				"the marks on the tab in front",
			);
			await h.control.waitFor(
				`${id("case-hint")}.textContent.includes("marks found on")`,
			);
			expect(await h.control.eval(`${id("load-case")}.textContent`)).toBe(
				"Hide marks",
			);
			expect(await pageCase(a.tabId)).toBeNull();

			// Another tab in front: drawn there, taken off the one before.
			await a.page.activate();
			await until(
				async () => (await pageCase(a.tabId)) === a.caseId,
				"the marks on the next tab",
			);
			await until(
				async () => (await pageCase(b.tabId)) === null,
				"the marks off the tab before",
			);
			await h.control.waitFor(
				`document.querySelector(".match")?.dataset.status === "found"`,
			);

			// Hidden on a tab: not drawn there again by itself, not even after a
			// switch or a reload.
			await h.control.eval(`${id("load-case")}.click()`);
			await until(
				async () => (await pageCase(a.tabId)) === null,
				"the marks to go",
			);
			await b.page.activate();
			await until(
				async () => (await pageCase(b.tabId)) === a.caseId,
				"the marks on the other tab",
			);
			await a.page.activate();
			await until(
				async () => (await pageCase(b.tabId)) === null,
				"the marks off the other tab",
			);
			await a.page.goto(`${h.base}/v1`);
			await Bun.sleep(1500);
			expect(await pageCase(a.tabId)).toBeNull();
			await h.control.waitFor(
				`${id("load-case")}.textContent === "Show marks"`,
			);
			// Show puts them back; a reload draws them again from then on.
			await h.control.eval(`${id("load-case")}.click()`);
			await until(
				async () => (await pageCase(a.tabId)) === a.caseId,
				"the marks back",
			);
			await a.page.goto(`${h.base}/v1`);
			await until(
				async () => (await pageCase(a.tabId)) === a.caseId,
				"the marks after the reload",
			);

			// Back to the list: the panel's marks leave the page.
			await backHome();
			await until(
				async () => (await pageCase(a.tabId)) === null,
				"the marks to go with the case",
			);
			await a.page.send("Page.close");
			await b.page.send("Page.close");
		},
	);

	slowTest(
		"a follow that waited for a slow tab leaves the tab now in front alone",
		async () => {
			await fresh();
			const a = await annotated("Slow tab");
			const b = await h.open("v2");
			await h.control.eval(
				`chrome.scripting.executeScript({ target: { tabId: ${b.tabId} }, files: ["content.js"] })`,
			);
			await a.page.activate();
			await openPanel();
			await openCase(a.caseId);
			await until(
				async () => (await pageCase(a.tabId)) === a.caseId,
				"the marks on the first tab",
			);
			// The second tab is slow to say what it shows.
			await h.control.eval(`globalThis.slowB = true`);
			await wrapSend(`async (tabId, message, send) => {
				while (globalThis.slowB && tabId === ${b.tabId} && message.type === "overlay:state")
					await new Promise((r) => setTimeout(r, 20));
				return send(tabId, message);
			}`);
			await b.page.activate();
			await Bun.sleep(300);
			await a.page.activate();
			await Bun.sleep(500);
			await h.control.eval(`globalThis.slowB = false`);
			await Bun.sleep(1500);
			// The follow for the second tab, late, did nothing.
			expect(await pageCase(a.tabId)).toBe(a.caseId);
			expect(await pageCase(b.tabId)).toBeNull();
			await a.page.send("Page.close");
			await b.page.send("Page.close");
		},
	);

	slowTest(
		"a draw that fails after another tab came to the front says nothing",
		async () => {
			await fresh();
			const a = await annotated("Failing draw");
			const b = await h.open("v2");
			await a.page.activate();
			await openPanel();
			await h.control.eval(`globalThis.holdA = true`);
			await wrapSend(`async (tabId, message, send) => {
				if (tabId === ${a.tabId} && message.type === "case:load") {
					while (globalThis.holdA) await new Promise((r) => setTimeout(r, 20));
					throw new Error("The tab went away");
				}
				return send(tabId, message);
			}`);
			await openCase(a.caseId);
			await Bun.sleep(300);
			await b.page.activate();
			await h.control.waitFor(
				`${id("case-hint")}.textContent.includes("marks found")`,
			);
			await h.control.eval(`globalThis.holdA = false`);
			await Bun.sleep(800);
			const said = await h.control.eval<string>(
				`${id("case-hint")}.textContent`,
			);
			expect(said).toContain("marks found");
			expect(said).not.toContain("went away");
			await a.page.send("Page.close");
			await b.page.send("Page.close");
		},
	);

	slowTest(
		"the page's own Hide holds: the searches again do not draw the marks back",
		async () => {
			await fresh();
			const { page, tabId } = await h.open("v1");
			await showToolbar(h, page, tabId);
			await markElement(page, "h1", "Here");
			// Drawn by a script on this visit only: the next one lacks it.
			await page.eval(
				`document.body.insertAdjacentHTML("beforeend", '<p id="late">Late</p>')`,
			);
			await markElement(page, "#late", "Not there next time");
			await saveAs(page, "Hidden on the page");
			await afterSave("Hidden on the page");
			const saved = (await readDb()).cases.find(
				(c) => c.title === "Hidden on the page",
			);
			await page.goto(`${h.base}/v1`);
			await page.activate();
			await openPanel();
			await openCase(saved?.id as string);
			// One of two found: it is looked for again at 1 s and 2 s.
			await h.control.waitFor(
				`${id("case-hint")}.textContent.includes("1 of 2 marks found")`,
			);
			await page.click(shadow('[data-action="review-hide"]'));
			await until(
				async () => (await pageCase(tabId)) === null,
				"the marks to go",
			);
			await Bun.sleep(3000);
			expect(await pageCase(tabId)).toBeNull();
			expect(await h.control.eval(`${id("load-case")}.textContent`)).toBe(
				"Show marks",
			);
			await page.send("Page.close");
		},
	);

	slowTest(
		"a new address within the page (a hash, pushState) keeps the marks: no draw again",
		async () => {
			await fresh();
			const a = await annotated("Same page, new address");
			await a.page.activate();
			await openPanel();
			await h.control.eval(`globalThis.loads = 0`);
			await wrapSend(`(tabId, message, send) => {
				if (message.type === "case:load") globalThis.loads++;
				return send(tabId, message);
			}`);
			await openCase(a.caseId);
			await until(
				async () => (await pageCase(a.tabId)) === a.caseId,
				"the marks on the page",
			);
			await Bun.sleep(500);
			const before = await h.control.eval<number>(`globalThis.loads`);
			await a.page.eval(`location.hash = "#/elsewhere"`);
			await a.page.eval(`history.pushState(null, "", "/v1?step=2")`);
			await Bun.sleep(1500);
			expect(await h.control.eval<number>(`globalThis.loads`)).toBe(before);
			expect(await pageCase(a.tabId)).toBe(a.caseId);
			// A real load of the page draws them again.
			await a.page.goto(`${h.base}/v1`);
			await until(
				async () => (await pageCase(a.tabId)) === a.caseId,
				"the marks after the load",
			);
			await a.page.send("Page.close");
		},
	);

	slowTest(
		"a page where none of the marks is: the panel says the case is probably for another page",
		async () => {
			await fresh();
			const { page, tabId } = await h.open("v1");
			await showToolbar(h, page, tabId);
			await markElement(page, "[data-truth=submit]", "Too pale");
			await saveAs(page, "Not for this page");
			// "Save case…" opened it (DEC-023): its marks would follow the page.
			await afterSave("Not for this page");
			const saved = (await readDb()).cases.find(
				(c) => c.title === "Not for this page",
			);
			// A page with no such button.
			await page.goto(`${h.base}/long`);
			await page.activate();
			await openPanel();
			await openCase(saved?.id as string);
			// After the searches again (1 s, 2 s), not before.
			await h.control.waitFor(`!${id("none-found")}.hidden`, 10_000);
			expect(
				await h.control.eval<string>(`${id("none-found")}.textContent`),
			).toContain(
				`None of this case's marks were found on this page. It is probably for another page: ${new URL(h.base).host}/v1.`,
			);
			expect(await h.control.eval(`${id("case-hint")}.hidden`)).toBe(true);
			// Its button opens the case's page, where the mark is found.
			await h.control.eval(
				`${id("none-found")}.querySelector('[data-action="open-case-page"]').click()`,
			);
			await h.control.waitFor(
				`document.querySelector(".match")?.dataset.status === "found"`,
				15_000,
			);
			expect(await h.control.eval(`${id("none-found")}.hidden`)).toBe(true);
			const opened = await h.control.eval<number>(
				`chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t.id)`,
			);
			await h.control.eval(`chrome.tabs.remove(${opened})`);
			await page.send("Page.close");
		},
	);

	slowTest(
		"an imported case says where it came from, also after a change",
		async () => {
			await fresh();
			await importFile("case.overmark.zip", await zipOf(sampleCase("c_in")));
			await h.control.waitFor(`${id("verdict")}?.dataset.case === "c_in"`);
			await h.control.waitFor(
				`${id("case-origin")}.textContent.includes("Imported from a file")`,
			);
			expect(await h.control.eval(`${id("case-origin")}.hidden`)).toBe(false);
			await typeVerdict("Ours");
			await h.control.eval(`${id("save-verdict")}.click()`);
			await h.control.waitFor(
				`${id("verdict-status")}.textContent === "Saved"`,
			);
			expect((await storedCase("c_in"))?.importedAt).toBeDefined();
		},
	);

	slowTest("an import error stays until it is dismissed", async () => {
		await fresh();
		const a = await h.open("v1");
		const b = await h.open("v2");
		await b.page.activate();
		await importFile("broken.zip", new Uint8Array([1, 2, 3]));
		await h.control.waitFor(
			`${id("import-error-text")}.textContent.includes("Could not import broken.zip")`,
		);
		// A tab in the background finishes loading.
		await a.page.goto(`${h.base}/v1`);
		await Bun.sleep(300);
		expect(await h.control.eval(`${id("import-error")}.hidden`)).toBe(false);
		await h.control.eval(`${id("import-dismiss")}.click()`);
		await h.control.waitFor(`${id("import-error")}.hidden`);
		await a.page.send("Page.close");
		await b.page.send("Page.close");
	});

	slowTest("a hint stays until the tab in front changes", async () => {
		await fresh();
		const a = await h.open("v1");
		const b = await h.open("v2");
		await b.page.activate();
		await h.control.waitFor(`${id("page")}.textContent.endsWith("/v2")`);
		await h.control.eval(`(() => {
			const no = () => Promise.reject(new Error("no access"));
			chrome.tabs.sendMessage = no;
			chrome.scripting.executeScript = no;
		})()`);
		await h.control.eval(`${id("annotate")}.click()`);
		await h.control.waitFor(
			`${id("hint")}.textContent.includes("Click the Overmark icon")`,
		);
		await a.page.goto(`${h.base}/v1`);
		await Bun.sleep(300);
		expect(await h.control.eval(`${id("hint")}.hidden`)).toBe(false);
		await a.page.activate();
		await h.control.waitFor(`${id("hint")}.hidden`);
		await a.page.send("Page.close");
		await b.page.send("Page.close");
	});

	slowTest(
		"Allow on all sites shows the permission and changes it",
		async () => {
			await fresh();
			const box = id("all-sites");
			// A test build has it from the start, and Chrome will not take that away.
			await h.control.waitFor(`${box}.checked`);
			await h.control.waitFor(`${id("page")}.textContent !== "…"`);
			await h.control.eval(`${box}.click()`);
			await h.control.waitFor(
				`${id("hint")}.textContent.includes("Could not change the access")`,
			);
			await h.control.waitFor(`${box}.checked`);

			await h.control.eval(`(() => {
			globalThis.asked = [];
			globalThis.granted = true;
			globalThis.answer = false;
			chrome.permissions.contains = async () => globalThis.granted;
			chrome.permissions.request = async (p) => {
				globalThis.asked.push(["request", ...p.origins]);
				globalThis.granted = globalThis.answer;
				return globalThis.granted;
			};
			chrome.permissions.remove = async (p) => {
				globalThis.asked.push(["remove", ...p.origins]);
				globalThis.granted = false;
				return true;
			};
		})()`);
			await h.control.eval(`${box}.click()`);
			await h.control.waitFor(`!${box}.checked`);
			// Declined: it stays off.
			await h.control.eval(`${box}.click()`);
			await h.control.waitFor(`globalThis.asked.length === 2`);
			await h.control.waitFor(`!${box}.checked`);
			await h.control.eval(`globalThis.answer = true; ${box}.click()`);
			await h.control.waitFor(`${box}.checked`);
			expect(await h.control.eval(`globalThis.asked`)).toEqual([
				["remove", "<all_urls>"],
				["request", "<all_urls>"],
				["request", "<all_urls>"],
			]);
		},
	);

	slowTest(
		"the blur setting goes to every tab, whatever a tab answers",
		async () => {
			await fresh();
			const a = await h.open("v1");
			const b = await h.open("v2");
			await b.page.activate();
			// The real side panel's box: the worker keeps the setting and tells
			// the tabs (DEC-016).
			const panel = await openSidePanel(h);
			const w = await worker(h);
			const tabs = await w.eval<number[]>(
				`chrome.tabs.query({}).then((tabs) => tabs.map((t) => t.id).sort())`,
			);
			await w.eval(`(() => {
				globalThis.told = [];
				const send = chrome.tabs.sendMessage.bind(chrome.tabs);
				chrome.tabs.sendMessage = (tabId, message, ...rest) => {
					if (message?.type !== "overlay:settings") return send(tabId, message, ...rest);
					globalThis.told.push({ tabId, ...message });
					return Promise.reject(new Error("no receiver"));
				};
			})()`);
			expect(await panel.eval(`${id("blur-forms")}.checked`)).toBe(false);
			await panel.eval(`${id("blur-forms")}.click()`);
			await w.waitFor(`globalThis.told.length === ${tabs.length}`);
			const told =
				await w.eval<{ tabId: number; blurForms: boolean }[]>(
					`globalThis.told`,
				);
			expect(told.map((t) => t.tabId).sort()).toEqual(tabs);
			expect(told.every((t) => t.blurForms === true)).toBe(true);
			expect((await settingsOf(h))["blurForms"]).toBe(true);
			// Off again for the tests after this one.
			await panel.eval(`${id("blur-forms")}.click()`);
			await w.waitFor(`globalThis.told.length === ${2 * tabs.length}`);
			expect((await settingsOf(h))["blurForms"]).toBe(false);
			await closeSidePanel(h, panel);
			await a.page.send("Page.close");
			await b.page.send("Page.close");
		},
	);

	describe("one toolbar per open case (DEC-023)", () => {
		const back = id("back");
		/** A saved case of one mark, the panel in it and its marks on the page in front. */
		async function inCaseWithMarks(title: string) {
			await fresh();
			const saved = await annotated(title);
			// "Save case…" opened the case; start from the list.
			await h.control.eval(`${back}.hidden || ${back}.click()`);
			await h.control.waitFor(`!${id("home")}.hidden`);
			await openCase(saved.caseId);
			await saved.page.activate();
			await until(
				async () => (await pageCase(saved.tabId)) === saved.caseId,
				"the case's marks on the page",
			);
			return saved;
		}

		const toolbarUp = (tabId: number) =>
			h.control.eval<boolean>(
				`chrome.tabs.sendMessage(${tabId}, { type: "overlay:state" }).then((s) => s.visible)`,
			);

		slowTest(
			"a new case's toolbar on another tab goes when that tab comes to the front under an open case",
			async () => {
				await fresh();
				const { page, tabId, caseId } = await annotated("Toolbar elsewhere");
				// A new case is being drawn on another tab, the panel on Home.
				const other = await h.open("v2");
				await showToolbar(h, other.page, other.tabId);
				await markElement(other.page, "h1", "A draft");
				// The case opens on the first tab.
				await page.activate();
				await openCase(caseId);
				await until(
					async () => (await pageCase(tabId)) === caseId,
					"the case's marks on the page",
				);
				expect(await toolbarUp(other.tabId)).toBe(true);
				// The case follows to the other tab: a toolbar there would add to
				// no case the panel shows.
				await other.page.activate();
				await until(
					async () => (await pageCase(other.tabId)) === caseId,
					"the case's marks on the other tab",
				);
				await until(
					async () => !(await toolbarUp(other.tabId)),
					"the new case's toolbar to go",
				);
				// Its draft stays on the page: Add marks would put it into the case.
				await h.control.waitFor(
					`${id("tab-line")}.textContent.startsWith("1 unsaved mark is on this page.")`,
				);
				await h.control.eval(`${back}.click()`);
				await h.control.waitFor(`!${id("home")}.hidden`);
				// No draft left: it would hold the tab open with "leave this site?".
				await showToolbar(h, other.page, other.tabId);
				await other.page.click(shadow('[data-action="undo"]'));
				await other.page.send("Page.close");
				await page.send("Page.close");
			},
		);

		slowTest(
			"the back button is a real button in the top bar, 32 px high at least",
			async () => {
				const { page } = await inCaseWithMarks("A large back button");
				const box = await h.control.eval<{ width: number; height: number }>(
					`(() => { const r = ${back}.getBoundingClientRect(); return { width: r.width, height: r.height }; })()`,
				);
				expect(box.height).toBeGreaterThanOrEqual(32);
				expect(box.width).toBeGreaterThanOrEqual(112);
				expect(await h.control.eval<string>(`${back}.textContent`)).toBe(
					"All cases",
				);
				// It stays in view while the case scrolls.
				await h.control.eval(`window.scrollTo(0, 400)`);
				expect(
					await h.control.eval<number>(`${back}.getBoundingClientRect().top`),
				).toBeGreaterThanOrEqual(0);
				await page.send("Page.close");
			},
		);

		slowTest(
			"the panel closed and opened again is in the case the page shows",
			async () => {
				const { page, tabId, caseId } = await inCaseWithMarks("Opened again");
				// As closing and opening the side panel: its page starts afresh.
				await openPanel();
				await h.control.waitFor(
					`!${id("case-view")}.hidden && ${id("verdict")}?.dataset.case === "${caseId}"`,
					10_000,
				);
				await h.control.waitFor(
					`${id("load-case")}.textContent === "Hide marks"`,
				);
				// The case's marks are the panel's again: they follow the case to
				// the next tab and leave this one.
				const other = await h.open("v2");
				await other.page.activate();
				await until(
					async () => (await pageCase(other.tabId)) === caseId,
					"the marks on the next tab",
				);
				await until(
					async () => (await pageCase(tabId)) === null,
					"the marks to leave the first tab",
				);
				await h.control.eval(`${back}.click()`);
				await h.control.waitFor(`!${id("home")}.hidden`);
				await until(
					async () => (await pageCase(other.tabId)) === null,
					"the marks to go",
				);
				await other.page.send("Page.close");
				await page.send("Page.close");
			},
		);

		slowTest(
			"a panel opened again while the toolbar adds to the case: its marks are the panel's",
			async () => {
				const { page, tabId, caseId } = await inCaseWithMarks(
					"Reopened while adding",
				);
				await h.control.eval(`${id("add-marks")}.click()`);
				await until(() => toolbarUp(tabId), "the toolbar");
				// As closing and opening the side panel.
				await openPanel();
				await h.control.waitFor(
					`!${id("case-view")}.hidden && ${id("verdict")}?.dataset.case === "${caseId}" && ${id("add-marks")}.textContent === "Done adding"`,
					10_000,
				);
				// What the page found shows, without a draw again.
				await h.control.waitFor(
					`document.querySelectorAll(".match").length === 1 && ${id("case-hint")}.textContent.includes("1 of 1 marks found")`,
				);
				// They follow the case to the next tab, and leave this one.
				const other = await h.open("v2");
				await other.page.activate();
				await until(
					async () => (await pageCase(other.tabId)) === caseId,
					"the marks on the next tab",
				);
				await until(
					async () => (await pageCase(tabId)) === null,
					"the marks to leave the first tab",
				);
				await page.activate();
				await h.control.eval(`${back}.click()`);
				await h.control.waitFor(`!${id("home")}.hidden`);
				await until(async () => !(await toolbarUp(tabId)), "the toolbar to go");
				await other.page.send("Page.close");
				await page.send("Page.close");
			},
		);

		slowTest(
			"a tab that does not answer the end does not hold the panel in the case",
			async () => {
				const { page, tabId } = await inCaseWithMarks("A silent tab");
				// Frozen by Chrome, or a page in an alert(): no answer, ever.
				await wrapSend(`(tabId, message, send) =>
					message.type === "overlay:end" ? new Promise(() => {}) : send(tabId, message)`);
				await h.control.eval(`${back}.click()`);
				await h.control.waitFor(
					`${id("leave-hint")}.textContent === "Finishing the marks…"`,
				);
				await h.control.waitFor(`!${id("home")}.hidden`, 30_000);
				await until(
					async () => (await pageCase(tabId)) === null,
					"the marks to go",
				);
				await openPanel();
				await page.send("Page.close");
			},
		);

		slowTest(
			"an import that ends while another case is open leaves that case open",
			async () => {
				const { page, caseId } = await inCaseWithMarks("Open while importing");
				await importFile(
					"other.overmark.zip",
					await zipOf(sampleCase("c_imported_meanwhile")),
				);
				await until(
					async () => (await storedCase("c_imported_meanwhile")) !== undefined,
					"the import",
				);
				await Bun.sleep(500);
				expect(
					await h.control.eval<string | undefined>(
						`${id("verdict")}?.dataset.case`,
					),
				).toBe(caseId);
				await h.control.eval(`${back}.click()`);
				await h.control.waitFor(`!${id("home")}.hidden`);
				await h.control.waitFor(
					`${id("import-done")}.textContent.includes("Imported")`,
				);
				await page.send("Page.close");
			},
		);

		slowTest(
			"Add marks says in the case why it could not show the toolbar",
			async () => {
				const { page } = await inCaseWithMarks("Add marks fails");
				await wrapSend(`(tabId, message, send) =>
					message.type === "overlay:show" ? Promise.reject(new Error("gone")) : send(tabId, message)`);
				await h.control.eval(`${id("add-marks")}.click()`);
				await h.control.waitFor(
					`${id("case-hint")}.textContent.startsWith("Could not reach the page")`,
				);
				await openPanel();
				await page.send("Page.close");
			},
		);

		/** Delete the case as another window's panel (or an AI app) does. */
		async function deleteElsewhere(caseId: string, back: Page): Promise<void> {
			const elsewhere = await h.browser.newPage(panelUrl());
			await back.activate();
			await elsewhere.eval(`new Promise((resolve) => {
				const open = indexedDB.open("overmark");
				open.onsuccess = () => {
					const tx = open.result.transaction("cases", "readwrite");
					tx.objectStore("cases").delete(${JSON.stringify(caseId)});
					tx.oncomplete = () => { open.result.close(); resolve(); };
				};
			})`);
			await elsewhere.eval(
				`chrome.runtime.sendMessage({ type: "cases:changed", caseId: ${JSON.stringify(caseId)} })`,
			);
			await elsewhere.send("Page.close");
		}
		const toolbarSays = (page: Page) =>
			page.eval<string | undefined>(
				`${shadow('[data-role="status"]')}?.textContent`,
			);

		slowTest(
			"the case deleted elsewhere under its toolbar: the toolbar draws a new case, its drafts kept",
			async () => {
				const { page, tabId, caseId } =
					await inCaseWithMarks("Deleted elsewhere");
				await h.control.eval(`${id("add-marks")}.click()`);
				await until(() => toolbarUp(tabId), "the toolbar");
				await deleteElsewhere(caseId, page);
				await h.control.waitFor(`!${id("home")}.hidden`);
				await page.waitFor(
					`${shadow('[data-role="status"]')}?.textContent === "New case: choose a tool"`,
				);
				expect(await toolbarUp(tabId)).toBe(true);
				await page.click(shadow('[data-action="close"]'));
				await page.send("Page.close");
			},
		);

		slowTest(
			"a toolbar on another tab whose case was deleted meanwhile draws a new case when it comes to the front",
			async () => {
				const { page, tabId, caseId } = await inCaseWithMarks("Deleted behind");
				await h.control.eval(`${id("add-marks")}.click()`);
				await until(() => toolbarUp(tabId), "the toolbar");
				const other = await h.open("v2");
				await other.page.activate();
				await until(
					async () => (await pageCase(other.tabId)) === caseId,
					"the marks on the next tab",
				);
				await deleteElsewhere(caseId, other.page);
				await h.control.waitFor(`!${id("home")}.hidden`);
				expect(await toolbarSays(page)).toBe("Adding to “Deleted behind”");
				await page.activate();
				await page.waitFor(
					`${shadow('[data-role="status"]')}?.textContent === "New case: choose a tool"`,
				);
				await h.control.waitFor(
					`${id("annotate")}.textContent === "Stop annotating" && ${id("annotate-hint")}.textContent === "Draw on the page with the toolbar at its bottom."`,
				);
				await page.click(shadow('[data-action="close"]'));
				await other.page.send("Page.close");
				await page.send("Page.close");
			},
		);

		slowTest("Hide holds through a reload of that tab", async () => {
			const { page, tabId } = await inCaseWithMarks("Hidden through a reload");
			await h.control.waitFor(
				`${id("load-case")}.textContent === "Hide marks"`,
			);
			await h.control.eval(`${id("load-case")}.click()`);
			await until(
				async () => (await pageCase(tabId)) === null,
				"the marks to go",
			);
			await h.control.waitFor(
				`${id("tab-line")}.textContent === "Marks are hidden on this tab."`,
			);
			await page.send("Page.reload");
			await page.waitFor(`document.readyState === "complete"`);
			// The searches again run at 1 and 2 seconds: none draws them back.
			await Bun.sleep(2600);
			expect(await pageCase(tabId)).toBeNull();
			expect(
				await h.control.eval<string>(`${id("load-case")}.textContent`),
			).toBe("Show marks");
			await page.send("Page.close");
		});

		slowTest(
			"an AI app's load_case of the open case leaves with ← All cases",
			async () => {
				const { page, tabId, caseId } = await inCaseWithMarks(
					"Loaded by an AI app",
				);
				// The panel's own marks go; then an AI app draws the case there.
				await h.control.waitFor(
					`${id("load-case")}.textContent === "Hide marks"`,
				);
				await h.control.eval(`${id("load-case")}.click()`);
				await until(
					async () => (await pageCase(tabId)) === null,
					"the panel's marks to go",
				);
				const c = await storedCase(caseId);
				await h.control.eval(
					`chrome.tabs.sendMessage(${tabId}, { type: "case:load", case: ${JSON.stringify(c)} })`,
				);
				expect(await pageCase(tabId)).toBe(caseId);
				await h.control.eval(`${back}.click()`);
				await h.control.waitFor(`!${id("home")}.hidden`);
				await until(
					async () => (await pageCase(tabId)) === null,
					"the AI app's marks to go",
				);
				await page.send("Page.close");
			},
		);
	});

	describe("with a relay", () => {
		const status = `${id("ai-status")}.textContent`;
		let side: Page | undefined;

		/** The side panel (the AI connection talks only to it), opened once. */
		async function sidePanel(): Promise<Page> {
			if (side === undefined) {
				await (await h.open("v1")).page.activate();
				side = await openSidePanel(h);
			}
			return side;
		}

		/** The side panel on `relay`, with "Keep AI access on". */
		async function keepOnWith(relay: string): Promise<Page> {
			const panel = await sidePanel();
			await setRelay(panel, relay);
			await panel.eval(`${id("keep-on")}.checked || ${id("keep-on")}.click()`);
			return panel;
		}

		/** A paired MCP client, through the address the card shows (none paired yet). */
		async function pairedClient(
			panel: Page,
			store: Parameters<typeof mcpClient>[0],
		) {
			await panel.waitFor(
				`${id("pair-address")}.textContent.endsWith("/mcp")`,
				10_000,
			);
			const address = await panel.eval<string>(
				`${id("pair-address")}.textContent`,
			);
			return mcpClient(store, address);
		}

		const visible = (page: Page, name: string) =>
			page.eval<boolean>(`${id(name)}.getClientRects().length > 0`);

		slowTest(
			"the AI pill in a case opens Settings and keeps the case, its marks and the toolbar (DEC-023)",
			async () => {
				const relay = startTestRelay({ pageWaitMs: 0 });
				await fresh();
				const { page, tabId, caseId } = await annotated("Pill in a case");
				const panel = await sidePanel();
				const back = id("back");
				const toolbarOf = () =>
					h.control.eval<{ visible: boolean; target?: { caseId: string } }>(
						`chrome.tabs.sendMessage(${tabId}, { type: "overlay:state" })`,
					);
				try {
					await setRelay(panel, relay.url);
					await panel.eval(`${back}.hidden || ${back}.click()`);
					await panel.waitFor(`!${id("home")}.hidden`);
					await page.activate();
					await openCase(caseId, panel);
					await until(
						async () => (await pageCase(tabId)) === caseId,
						"the case's marks on the page",
					);
					await panel.eval(`${id("add-marks")}.click()`);
					await until(async () => (await toolbarOf()).visible, "the toolbar");

					await panel.eval(`${id("ai-button")}.click()`);
					await panel.waitFor(
						`!${id("settings")}.hidden && ${id("case-view")}.hidden && ${back}.textContent === "Back"`,
					);
					// A real click in the AI app card reaches it now. The card
					// grows while AI access comes on (the pairing box, above the
					// field), so a click aimed just before lands beside the field:
					// click until it is the field that has the focus.
					await until(async () => {
						await panel.click(id("relay"));
						return panel.eval<boolean>(
							`document.activeElement === ${id("relay")}`,
						);
					}, "a real click to reach the relay field");
					expect(await pageCase(tabId)).toBe(caseId);
					const toolbar = await toolbarOf();
					expect(toolbar.visible).toBe(true);
					expect(toolbar.target?.caseId).toBe(caseId);

					await panel.eval(`${back}.click()`);
					await panel.waitFor(
						`${id("settings")}.hidden && !${id("case-view")}.hidden && ${id("verdict")}?.dataset.case === "${caseId}"`,
					);
					expect(
						await panel.eval<string>(`${id("add-marks")}.textContent`),
					).toBe("Done adding");
					// Not a double click's second: that would do nothing.
					await Bun.sleep(600);
					await panel.eval(`${back}.click()`);
					await panel.waitFor(`!${id("home")}.hidden`);
					await until(
						async () => !(await toolbarOf()).visible,
						"the toolbar to go",
					);
					expect(await pageCase(tabId)).toBeNull();
				} finally {
					await panel.eval(
						`${id("stop-ai")}.hidden || ${id("stop-ai")}.click()`,
					);
					await page.send("Page.close");
					await relay.stop();
				}
			},
		);

		slowTest(
			"Stop AI access ends the session and keeps the pairing",
			async () => {
				const relay = startTestRelay({ pageWaitMs: 0 });
				await fresh([sampleCase("c_ai")]);
				const panel = await keepOnWith(relay.url);
				await panel.waitFor(
					`${status} === "Waiting for an AI app to pair"`,
					10_000,
				);
				const client = await pairedClient(panel, relay.store);
				const list = () =>
					client.callTool({ name: "list_cases", arguments: {} });
				try {
					await list();
					await panel.waitFor(
						`${id("ai-call")}.textContent.includes("List cases")`,
					);
					expect(await panel.eval(`${id("ai-call")}.textContent`)).toContain(
						"Last AI call: List cases",
					);

					// The connection, the call and the way out show in a case too.
					await h.control.eval(
						`chrome.runtime.sendMessage({ type: "cases:changed", caseId: "c_ai" })`,
					);
					await openCase("c_ai", panel);
					for (const part of ["ai-status", "ai-call", "stop-ai"])
						expect(await visible(panel, part)).toBe(true);

					await panel.eval(`${id("stop-ai")}.click()`);
					await panel.waitFor(`${status} === "Not connected"`);
					await panel.waitFor(`${id("stop-ai")}.hidden`);
					expect(relay.relay.sessionCount).toBe(0);
					const stopped = await list().catch((e: Error) => ({
						isError: true,
						content: [{ text: e.message }],
					}));
					expect(stopped.isError).toBe(true);

					// "Keep AI access on" would undo it, now and at the next start.
					expect(await panel.eval(`${id("keep-on")}.checked`)).toBe(false);
					expect((await settingsOf(h))["keepAiOn"]).toBe(false);
					await Bun.sleep(200);
					expect(relay.relay.sessionCount).toBe(0);

					// The pairing is still there: the same token works after a connect.
					await backHome(panel);
					await panel.eval(`${id("connect")}.click()`);
					await until(
						async () => relay.relay.sessionCount === 1,
						"the panel to connect",
					);
					expect((await list()).isError).toBeFalsy();
				} finally {
					await client.close();
					await relay.stop();
				}
			},
		);

		test.each([
			["idle", { idleTimeoutMs: 300, heartbeatMs: 200 }],
			["expired", { sessionLifetimeMs: 800 }],
		])(
			"Keep AI access on connects again after a session ended as %s",
			async (_reason, limits) => {
				const relay = startTestRelay(limits);
				await fresh();
				const panel = await keepOnWith(relay.url);
				await panel.waitFor(
					`${status} === "Waiting for an AI app to pair"`,
					10_000,
				);
				await panel.eval(`(() => {
				globalThis.seen = [];
				new MutationObserver(() => globalThis.seen.push(${status})).observe(
					${id("ai-status")},
					{ childList: true },
				);
			})()`);
				await panel.waitFor(`globalThis.seen.includes("Connecting…")`);
				await panel.waitFor(`${status} === "Waiting for an AI app to pair"`);
				await relay.stop();
			},
			60_000,
		);

		slowTest(
			"a change by a tool reaches the panel in another window",
			async () => {
				const relay = startTestRelay();
				await fresh([sampleCase("c_tool")]);
				const other = await h.browser.newPage(panelUrl());
				await openCase("c_tool", other);
				const panel = await keepOnWith(relay.url);
				await panel.waitFor(
					`${status} === "Waiting for an AI app to pair"`,
					10_000,
				);
				const client = await pairedClient(panel, relay.store);
				try {
					const verdict = client.callTool({
						name: "set_summary",
						arguments: { caseId: "c_tool", summary: "Darker" },
					});
					await answerInPanel(panel, "allow");
					expect((await verdict).isError).toBeFalsy();
					await other.waitFor(`${id("verdict")}.value === "Darker"`);
				} finally {
					await client.close();
					await other.send("Page.close");
					await relay.stop();
				}
			},
		);

		slowTest(
			"Keep AI access on goes on trying a relay that is down, and says why",
			async () => {
				const gone = startTestRelay();
				const { port } = gone.relay;
				const { url } = gone;
				await gone.stop();
				await fresh();
				const panel = await keepOnWith(url);
				await panel.waitFor(
					`${status}.startsWith("Not connected: Could not connect to the relay")`,
					10_000,
				);
				expect(await panel.eval(status)).toContain("Trying again");
				expect(await panel.eval(`${id("stop-ai")}.hidden`)).toBe(false);
				const relay = startTestRelay({ port });
				await panel.waitFor(
					`${status} === "Waiting for an AI app to pair"`,
					15_000,
				);
				await relay.stop();
			},
		);

		slowTest("unchecked, it stops trying", async () => {
			const gone = startTestRelay();
			const { port } = gone.relay;
			const { url } = gone;
			await gone.stop();
			await fresh();
			const panel = await keepOnWith(url);
			await panel.waitFor(`${status}.includes("Trying again")`, 10_000);
			await panel.eval(`${id("keep-on")}.click()`);
			await panel.waitFor(`${status} === "Not connected"`);
			const relay = startTestRelay({ port });
			await Bun.sleep(6000);
			expect(relay.relay.sessionCount).toBe(0);
			await relay.stop();
		});
	});
});
