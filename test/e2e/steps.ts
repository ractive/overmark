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

/** Click Export on the open case; answers the path of the file in `folder`. */
export async function exportOpenCase(
	h: Harness,
	panel: Page,
	folder: string,
): Promise<string> {
	await h.browser.send("Browser.setDownloadBehavior", {
		behavior: "allow",
		downloadPath: folder,
		eventsEnabled: true,
	});
	const begun = h.browser.event("Browser.downloadWillBegin");
	await panel.click(`document.getElementById("export-case")`);
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
