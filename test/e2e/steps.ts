/** Steps the end-to-end tests share: the toolbar, saving, reading the database. */

import { join } from "node:path";
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
		lastNumber?: number;
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

/** Read until `done` holds for the answer. */
export async function until<T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
	timeoutMs = 5000,
): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > end)
			throw new Error(`timed out; last: ${JSON.stringify(value)}`);
		await Bun.sleep(50);
	}
}

interface DomNode {
	backendNodeId: number;
	attributes?: string[];
	children?: DomNode[];
	shadowRoots?: DomNode[];
}

function hostNode(node: DomNode): DomNode | undefined {
	const at = node.attributes?.indexOf("id") ?? -1;
	if (at >= 0 && node.attributes?.[at + 1] === "overmark-root") return node;
	for (const child of node.children ?? []) {
		const found = hostNode(child);
		if (found !== undefined) return found;
	}
	return undefined;
}

/**
 * Wait until the side panel has taken its width from the page and the
 * viewport keeps its size: the panel takes it a moment after the icon's
 * click, and a click measured before that lands beside the element (on Linux
 * in CI, past the overlay onto the page).
 */
export async function viewportSettled(page: Page): Promise<void> {
	// The panel is at least this wide (Chrome's minimum is 320 px).
	const PANEL_MIN = 200;
	const size = () =>
		page.eval<{ inner: number; outer: number; height: number }>(
			"({ inner: innerWidth, outer: outerWidth, height: innerHeight })",
		);
	const end = Date.now() + 5000;
	let last = await size();
	let steady = 0;
	while (last.outer - last.inner < PANEL_MIN || steady < 3) {
		if (Date.now() > end)
			throw new Error(
				`the viewport did not settle beside the side panel: ${JSON.stringify(last)}`,
			);
		await Bun.sleep(150);
		const now = await size();
		steady =
			now.inner === last.inner && now.height === last.height ? steady + 1 : 0;
		last = now;
	}
}

/**
 * Let `shadow` reach the overlay of a build that ships: its shadow root is
 * closed to the page, but not to CDP. Afterwards the host's `shadowRoot`
 * answers, for the page's world only.
 */
export async function reachOverlay(page: Page): Promise<void> {
	await page.waitFor(HOST);
	const { root } = (await page.send("DOM.getDocument", {
		depth: -1,
		pierce: true,
	})) as { root: DomNode };
	const shadowRoot = hostNode(root)?.shadowRoots?.[0];
	if (shadowRoot === undefined)
		throw new Error("the overlay has no shadow root");
	const { object } = (await page.send("DOM.resolveNode", {
		backendNodeId: shadowRoot.backendNodeId,
	})) as { object: { objectId: string } };
	await page.send("Runtime.callFunctionOn", {
		objectId: object.objectId,
		functionDeclaration: `function () { Object.defineProperty(this.host, "shadowRoot", { value: this }); }`,
	});
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
	// Without the tool, the click below would go to the page itself.
	await page.waitFor(
		`${shadow('[data-action="tool-element"]')}.getAttribute("aria-pressed") === "true"`,
	);
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
	await page
		.waitFor(
			`${shadow('[data-role="status"]')}?.textContent.startsWith("Saved")`,
			20_000,
		)
		.catch(async (error: unknown) => {
			const said = await page.eval(`${shadow(".toolbar")}.textContent`);
			throw new Error(`no save; the toolbar says: ${said}`, { cause: error });
		});
}

/** Run `body` (an expression using `image`, the stored `{ blob, width, height }`) on a case's image. */
function withImage(title: string, path: string, body: string): string {
	return `new Promise((resolve, reject) => {
	const open = indexedDB.open("overmark");
	open.onerror = () => reject(open.error);
	open.onsuccess = () => {
		const tx = open.result.transaction(["cases", "images"]);
		const cases = tx.objectStore("cases").getAll();
		tx.oncomplete = () => {
			const c = cases.result.find((x) => x.title === ${JSON.stringify(title)});
			if (!c) return reject(new Error("no case " + ${JSON.stringify(title)}));
			const get = open.result.transaction("images").objectStore("images").get(c.id + "/" + ${JSON.stringify(path)});
			get.onsuccess = async () => { try { const image = get.result; resolve(await (${body})); } catch (e) { reject(e); } };
			get.onerror = () => reject(get.error);
		};
	};
})`;
}

/** A stored image's bytes (base64) and the size the store recorded. */
export function imageBytes(
	control: Page,
	title: string,
	path: string,
): Promise<{ base64: string; width: number; height: number }> {
	return control.eval(
		withImage(
			title,
			path,
			`image.blob.arrayBuffer().then((b) => { let s = ""; for (const x of new Uint8Array(b)) s += String.fromCharCode(x); return { base64: btoa(s), width: image.width, height: image.height }; })`,
		),
	);
}

/** How many pixels of a stored image are within `tolerance` of a colour. */
export function countColour(
	control: Page,
	title: string,
	path: string,
	[r, g, b]: [number, number, number],
	tolerance = 12,
): Promise<number> {
	return control.eval(
		withImage(
			title,
			path,
			`createImageBitmap(image.blob).then((bitmap) => {
				const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
				const ctx = canvas.getContext("2d");
				ctx.drawImage(bitmap, 0, 0);
				const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
				let n = 0;
				for (let i = 0; i < data.length; i += 4)
					if (Math.abs(data[i] - ${r}) <= ${tolerance} && Math.abs(data[i + 1] - ${g}) <= ${tolerance} && Math.abs(data[i + 2] - ${b}) <= ${tolerance}) n++;
				return n;
			})`,
		),
	);
}

/**
 * The worker's settings database (`src/worker/kv.ts`), read or changed in an
 * extension page or the worker: `KV(code)` runs `code` with `store`, the
 * object store, in a transaction of `mode`, and answers every entry after it.
 */
export const KV = (code = "", mode: "readonly" | "readwrite" = "readonly") =>
	`new Promise((resolve, reject) => {
		const open = indexedDB.open("overmark-settings", 1);
		open.onupgradeneeded = () => open.result.createObjectStore("settings");
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const tx = open.result.transaction("settings", ${JSON.stringify(mode)});
			const store = tx.objectStore("settings");
			${code};
			const keys = store.getAllKeys();
			const values = store.getAll();
			tx.oncomplete = () => {
				open.result.close();
				resolve(Object.fromEntries(keys.result.map((k, i) => [k, values.result[i]])));
			};
			tx.onerror = () => reject(tx.error);
		};
	})`;

/** The worker's settings now, read in the control page (the same origin). */
export const settingsOf = (h: Harness) =>
	h.control.eval<Record<string, unknown>>(KV());

/** A session on the extension's service worker, which starts it if needed. */
export async function worker(h: Harness): Promise<Page> {
	await h.control.eval(WAKE_WORKER);
	const { targetId } = await workerTarget(h);
	return h.browser.attach(targetId);
}

/** A message the worker answers without doing anything: it starts it, though. */
const WAKE_WORKER = `chrome.runtime.sendMessage({ type: "images:discard", caseId: "c_none", shotIds: [] })`;

const workerTarget = (h: Harness) =>
	h.browser.waitForTarget(
		(t) =>
			t.type === "service_worker" &&
			t.url === `chrome-extension://${h.extensionId}/background.js`,
	);

/** Stop the service worker, as Chrome does when it is idle, and wake it again. */
export async function restartWorker(h: Harness): Promise<void> {
	await h.control.eval(WAKE_WORKER);
	const { targetId } = await workerTarget(h);
	await h.browser.send("Target.closeTarget", { targetId });
	await until(
		() => h.browser.targets(),
		(targets) => !targets.some((t) => t.targetId === targetId),
	);
	await h.control.eval(WAKE_WORKER);
	await until(
		() => workerTarget(h),
		(target) => target.targetId !== targetId,
	);
}

/**
 * Before a test: no page left from the tests before (a tab is found by its
 * address, and a page left with a toolbar or a case's marks is someone
 * else's state), and every side panel document (the control page, a real
 * side panel, one opened in a tab) on Home with no case open. A case left
 * open in one follows to the test's tab, draws its marks and hides its new
 * case's toolbar (DEC-023), so one failing test would take the ones after
 * it along. Pages close without the question unsaved marks ask.
 */
export async function resetPanel(h: Harness): Promise<void> {
	const panelUrl = `chrome-extension://${h.extensionId}/sidepanel/index.html`;
	const pages = async () =>
		(await h.browser.targets()).filter((t) => t.type === "page");
	const closing = (await pages())
		.filter((t) => /^(https?|file):/.test(t.url))
		.map((t) => t.targetId);
	for (const targetId of closing)
		await h.browser
			.send("Target.closeTarget", { targetId })
			.catch(() => undefined);
	await until(pages, (now) => !now.some((t) => closing.includes(t.targetId)));
	const home = `!document.getElementById("home").hidden && document.getElementById("back").hidden`;
	await h.control.goto(panelUrl);
	await h.control.waitFor(home);
	for (const t of await pages()) {
		if (t.targetId === h.control.targetId || !t.url.startsWith(panelUrl))
			continue;
		const other = await h.browser.attachPage(t.targetId);
		await other.goto(panelUrl);
		await other.waitFor(home);
	}
}

/** The side panel's document in the control page, in front, on its home view. */
export async function panelHome(h: Harness): Promise<Page> {
	await h.control.goto(
		`chrome-extension://${h.extensionId}/sidepanel/index.html`,
	);
	await h.control.activate();
	// The list moves what is below it when it arrives.
	const { cases } = await h.control.eval<Db>(READ_DB);
	await h.control.waitFor(
		cases.length === 0
			? `document.getElementById("cases").childElementCount > 0`
			: `document.querySelectorAll("[data-case]").length === ${cases.length}`,
	);
	return h.control;
}

/** Open the case `title` from the side panel's list. */
export async function openCase(panel: Page, title: string): Promise<void> {
	const item = `[...document.querySelectorAll("[data-case]")].find((e) => e.textContent.includes(${JSON.stringify(title)}))`;
	await panel.waitFor(item);
	await panel.click(item);
	await panel.waitFor(`document.getElementById("export-case")`);
}

/**
 * Click Export on the open case; answers the path the panel shows (the test
 * build has "downloads").
 */
export function exportOpenCase(h: Harness, panel: Page): Promise<string> {
	return downloadShown(
		h,
		panel,
		`document.getElementById("export-case")`,
		"export-saved",
	);
}

/**
 * Click the button `button` (an expression) that saves through the
 * `downloads` API (DEC-020), into Chrome's own downloads folder; answers the
 * path the panel shows in `saved` (an element's id) once the file is there.
 */
export async function downloadShown(
	h: Harness,
	panel: Page,
	button: string,
	saved: string,
): Promise<string> {
	// Chrome's own way, by its settings: CDP's "allow" names a file by a GUID.
	await h.browser.send("Browser.setDownloadBehavior", { behavior: "default" });
	await panel.click(button);
	const code = `document.querySelector("#${saved} code")?.textContent`;
	await panel.waitFor(code, 15_000);
	const path = await panel.eval<string>(code);
	if (Bun.file(path).size === 0) throw new Error(`${path} is empty or missing`);
	return path;
}

/**
 * Click the button `button` (an expression) that saves a file; answers its
 * path in `folder` once Chrome has written it.
 */
export async function download(
	h: Harness,
	panel: Page,
	folder: string,
	button: string,
): Promise<string> {
	await h.browser.send("Browser.setDownloadBehavior", {
		behavior: "allow",
		downloadPath: folder,
		eventsEnabled: true,
	});
	const begun = h.browser.event("Browser.downloadWillBegin");
	await panel.click(button);
	const { suggestedFilename } = (await begun) as { suggestedFilename: string };
	const path = join(folder, suggestedFilename);
	// Chrome may still be writing it: it is done when it has stopped growing.
	let size = -1;
	await until(
		async () => {
			const before = size;
			size = Bun.file(path).size;
			await Bun.sleep(200);
			return before;
		},
		(before) => before > 0 && before === size,
	);
	return path;
}

/** Choose `file` through the side panel's Import button and file input. */
export async function importFile(panel: Page, file: string): Promise<void> {
	await panel.send("Page.setInterceptFileChooserDialog", { enabled: true });
	const chooser = panel.event("Page.fileChooserOpened");
	await panel.click(`document.getElementById("import")`);
	const { backendNodeId } = (await Promise.race([
		chooser,
		Bun.sleep(5000).then(() => {
			throw new Error("the Import button opened no file chooser");
		}),
	])) as { backendNodeId: number };
	await panel.send("DOM.setFileInputFiles", { files: [file], backendNodeId });
	await panel.send("Page.setInterceptFileChooserDialog", { enabled: false });
}

/** Keys of the images store under a case. */
export const imagesOf = (db: Db, caseId: string) =>
	db.images
		.filter((i) => i.key.startsWith(`${caseId}/`))
		.map((i) => i.key.slice(caseId.length + 1))
		.sort();
