/**
 * The side panel: the tab in front, annotating it, the saved cases, and the
 * connection to an AI app. Actions change the panel's one state (state.ts);
 * view.ts draws it (DEC-011).
 */

import {
	type Annotation,
	type Case,
	markStatus,
	nextNumbers,
	validateCase,
	withChoice,
	withComment,
	withoutAnnotation,
	withoutFinding,
	withReopen,
	withVerified,
} from "../lib/case.ts";
import {
	type CheckedExport,
	exportAllCases,
	exportAllFileName,
	exportCase,
	exportFileName,
	MAX_IMPORT_ALL_BYTES,
	readExports,
	storeImport,
} from "../lib/export.ts";
import type {
	AnnotationMatch,
	Broadcast,
	LoadResult,
	OverlayState,
} from "../lib/messages.ts";
import { IdbStore } from "../lib/store.ts";
import { NoAccessError, sendToTab } from "../lib/tabs.ts";
import { blurFormsNow, startAi } from "./ai.ts";
import { byId, isWebPage, shortUrl, sitePattern } from "./dom.ts";
import {
	askForDownloads,
	DOWNLOADS,
	type SavedFile,
	saveFile,
} from "./download.ts";
import { type Drawn, followStep, isFound, noneFound } from "./follow.ts";
import { cssSize, onScreen, type Size, sameSize, windowFor } from "./size.ts";
import {
	type Exported,
	type ImportBatch,
	Latest,
	Panel,
	type PanelState,
} from "./state.ts";
import { startSync, syncActions } from "./sync.ts";
import { type Actions, NO_ACCESS, render } from "./view.ts";

const store = new IdbStore();

const importButton = byId<HTMLButtonElement>("import");
const importFile = byId<HTMLInputElement>("import-file");
const exportAllButton = byId<HTMLButtonElement>("export-all");
const allSites = byId<HTMLInputElement>("all-sites");

const ALL_SITES = { origins: ["<all_urls>"] };

/** After a first click on Delete: the second click of a double-click is no decision. */
const DELETE_CLICK_GAP_MS = 500;
/** After a first click on Delete: a click much later is no decision either. */
const DELETE_ARMED_MS = 4000;

/**
 * Chrome's prompt to let Overmark run on the site of `url` from now on. It
 * shows only during a click, so call it before anything is awaited; it
 * answers yes at once where Overmark may run already.
 */
function askForSite(url: string): Promise<boolean> {
	const pattern = sitePattern(url);
	if (pattern === undefined || declinedSites.has(pattern))
		return Promise.resolve(false);
	return chrome.permissions.request({ origins: [pattern] }).then(
		(granted) => {
			if (!granted) declinedSites.add(pattern);
			return granted;
		},
		(error: unknown) => {
			// Not the user's no: a call outside a click, say.
			console.warn(`Overmark could not ask for ${pattern}: ${message(error)}`);
			return false;
		},
	);
}

/** Sites the user said no to: Chrome asks again only after the panel reopens. */
const declinedSites = new Set<string>();

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

function describeError(error: unknown): string {
	return error instanceof NoAccessError
		? NO_ACCESS
		: `Could not reach the page: ${message(error)}`;
}

// --- the state and its work ------------------------------------------------------

const panel = new Panel((state) => render(state, actions));
const update = (change: (s: PanelState) => void) => panel.update(change);
const state = panel.state;

/** One `Latest` per thing that is read asynchronously. */
const tabWork = new Latest();
const casesWork = new Latest();
const caseWork = new Latest();
const imagesWork = new Latest();
const hintWork = new Latest();
const sitesWork = new Latest();
const downloadsWork = new Latest();

/** Refreshes of the tab running now. */
let refreshing = 0;

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
	const win = await chrome.windows.getCurrent();
	const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
	return tab;
}

/** The tab's size in CSS pixels, as a case records its viewport. */
async function tabSize(tab: chrome.tabs.Tab): Promise<Size | undefined> {
	if (tab.id === undefined || !tab.width || !tab.height) return undefined;
	const zoom = await chrome.tabs.getZoom(tab.id).catch(() => 1);
	return cssSize({ width: tab.width, height: tab.height }, zoom);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sizeText = (s: Size) => `${s.width}×${s.height}`;

/** The panel shows that case. */
const showing = (caseId: string) =>
	state.view.kind === "case" && state.view.id === caseId;

/** The newest load: Hide, or another load, makes the older ones stale. */
const loadWork = new Latest();

/** What the newest load draws where, until Hide or the case closes. */
let loadTarget: Drawn | undefined;

/** A load of the case onto the tab: it makes the older ones stale. */
function startLoad(target: Drawn): ReturnType<Latest["start"]> {
	loadTarget = target;
	return loadWork.start();
}

/** No load goes on, and none that is under way draws its marks. */
function stopLoads(): void {
	loadTarget = undefined;
	loadWork.cancel();
}

/**
 * Where the panel drew a case's marks last (DEC-022): they follow the open
 * case to the tab in front, and leave the tab they were on. Marks an AI app
 * loaded are the page's, not these.
 */
let drawn: Drawn | undefined;

/** A draw by `follow` under way. */
let drawing: Drawn | undefined;

/** Loads waiting for the page's answer: its news meanwhile may predate them. */
let loadsUnderWay = 0;

/**
 * Tabs the user took the open case's marks off ("Hide marks on this tab"):
 * they are not drawn there again by themselves until "Show marks on this
 * tab", or the case is opened again.
 */
const hiddenOn = new Set<number>();

/** The tab `follow` last saw in front: hints about another tab go. */
let followed: number | undefined;

const sameDrawn = (a: Drawn | undefined, b: Drawn | undefined) =>
	a !== undefined &&
	b !== undefined &&
	a.tabId === b.tabId &&
	a.caseId === b.caseId;

/** Take the panel's marks of that case off that tab; a closed or reloaded tab has none. */
function takeOff(d: Drawn): void {
	if (sameDrawn(drawn, d)) drawn = undefined;
	void chrome.tabs
		.sendMessage(d.tabId, { type: "case:clear", caseId: d.caseId })
		.catch(() => undefined);
}

/**
 * A tab Overmark may not run on yet, with the open case to draw there once
 * the icon's click (or "Allow on all sites") lets it in.
 */
let pendingLoad: { tabId: number; caseId: string } | undefined;

/**
 * Loads the case onto the tab and says how it went; `undefined` when it could
 * not, the hint says why. `again`: the marks not found are looked for once
 * more in a moment.
 */
async function loadInto(
	c: Case,
	tabId: number,
	hint: (text: string | undefined) => void,
	work: { current: () => boolean },
	again = false,
): Promise<{ found: number; total: number } | undefined> {
	const here = { tabId, caseId: c.id };
	try {
		loadsUnderWay++;
		const result = await sendToTab<LoadResult | { error: string }>(tabId, {
			type: "case:load",
			case: c,
		}).finally(() => loadsUnderWay--);
		if ("error" in result) {
			// A stale load's failure is about a tab no longer in question.
			if (work.current()) hint(result.error);
			return undefined;
		}
		// Hidden or closed meanwhile: the marks this load drew go too, unless a
		// newer load draws them there again.
		if (!work.current()) {
			if (sameDrawn(loadTarget, here)) drawn = here;
			else takeOff(here);
			return undefined;
		}
		drawn = here;
		// The marks follow the case to the tab in front (DEC-022), and the
		// results describe that tab (see refreshTab).
		if ((await activeTab())?.id !== tabId) {
			takeOff(here);
			return undefined;
		}
		const found = result.matches.filter(isFound).length;
		const settling = again && found < result.matches.length;
		update((s) => {
			s.loaded = {
				caseId: c.id,
				tabId,
				matches: new Map(result.matches.map((m) => [m.annotationId, m])),
				settling,
			};
		});
		// None found: the case view says so, and where the case is from.
		hint(
			noneFound(result.matches) && !settling
				? undefined
				: `${found} of ${result.matches.length} marks found on ${shortUrl(result.url)}. Green: found. Amber, dashed: probable or unsure.`,
		);
		return { found, total: result.matches.length };
	} catch (error) {
		if (work.current()) hint(describeError(error));
		return undefined;
	}
}

/**
 * Loads the case onto a page that has just loaded. What a script draws after
 * the load is not there yet: marks not found are looked for twice more, while
 * the panel still shows the case and the tab is in front.
 */
async function loadOnLoaded(
	c: Case,
	tabId: number,
	hint: (text: string | undefined) => void,
): Promise<void> {
	const target = { tabId, caseId: c.id };
	const work = startLoad(target);
	drawing = target;
	try {
		const waits = [0, 1000, 2000];
		for (const [i, wait] of waits.entries()) {
			if (wait > 0) {
				await sleep(wait);
				if (!work.current() || !showing(c.id) || hiddenOn.has(tabId)) return;
				if ((await activeTab())?.id !== tabId) return;
			}
			const result = await loadInto(c, tabId, hint, work, i < waits.length - 1);
			if (result === undefined || result.found === result.total) return;
		}
	} finally {
		if (drawing === target) drawing = undefined;
	}
}

/** The newest `follow`: one that started later knows the tab in front better. */
const followWork = new Latest();

/** The tab in front of the panel's window, as `follow` needs it. */
async function frontTab(): Promise<
	{ id: number; url: string; loading: boolean } | undefined
> {
	const tab = await activeTab();
	return tab?.id === undefined
		? undefined
		: { id: tab.id, url: tab.url ?? "", loading: tab.status === "loading" };
}

/**
 * The open case's marks follow it to the tab in front (DEC-022): drawn there,
 * taken off the tab they were on. Only the newest call acts: one that waited
 * for a slow page while another tab came to the front does nothing.
 */
async function follow(): Promise<void> {
	const work = followWork.start();
	// What the draw found goes under the case's buttons, unless the user did
	// something there meanwhile (Match size, Export): that one's outcome stays.
	const hint = followHint();
	const c = state.view.kind === "case" ? state.current : undefined;
	if (c === undefined || !showing(c.id)) {
		// Not read yet: opening it follows once it is.
		if (state.view.kind !== "case" && drawn !== undefined) takeOff(drawn);
		return;
	}
	const front = await frontTab();
	const pageCase =
		front === undefined || front.url === ""
			? undefined
			: (await overlayState(front.id))?.loadedCase;
	// Still the tab in front, and no newer follow: else that one decides.
	if ((await frontTab())?.id !== front?.id || !work.current()) return;
	// The panel went on to another case, or back to the list, meanwhile.
	if (state.current?.id !== c.id || !showing(c.id)) return;
	const step = followStep({
		caseId: c.id,
		tab: front,
		drawn,
		pageCase,
		hidden: hiddenOn,
	});
	if (step.clear !== undefined) takeOff(step.clear);
	if (front === undefined) return;
	if (front.id !== followed) {
		// What the hints said was about the tab before (opening the case
		// cleared them already).
		if (followed !== undefined) hint(undefined);
		followed = front.id;
	}
	if (step.action === "wait") {
		pendingLoad = { tabId: front.id, caseId: c.id };
		return;
	}
	if (step.action !== "draw") return;
	const target = { tabId: front.id, caseId: c.id };
	// Under way already (a page that starts loading again ends that).
	if (sameDrawn(drawing, target)) return;
	if (pendingLoad?.tabId === front.id) pendingLoad = undefined;
	await loadOnLoaded(c, front.id, hint);
}

/** Waits until the window has left full screen or maximised, three seconds at most. */
async function normalWindow(windowId: number): Promise<void> {
	for (let i = 0; i < 30; i++) {
		if ((await chrome.windows.get(windowId)).state === "normal") return;
		await sleep(100);
	}
}

/** Waits until the tab's size holds still, a second at most. */
async function settledSize(tabId: number): Promise<void> {
	let last = "";
	for (let i = 0; i < 10; i++) {
		await sleep(100);
		const tab = await chrome.tabs.get(tabId);
		const now = `${tab.width}×${tab.height}`;
		if (now === last) return;
		last = now;
	}
}

/** The overlay's state on the tab, or `undefined` where it is not injected. */
async function overlayState(tabId: number): Promise<OverlayState | undefined> {
	try {
		return (await chrome.tabs.sendMessage(tabId, {
			type: "overlay:state",
		})) as OverlayState;
	} catch {
		return undefined;
	}
}

async function refreshTab(): Promise<void> {
	const work = tabWork.start();
	refreshing++;
	try {
		const tab = await activeTab();
		const overlay =
			tab?.id === undefined ? undefined : await overlayState(tab.id);
		const size = tab === undefined ? undefined : await tabSize(tab);
		if (!work.current()) return;
		update((s) => {
			const next =
				tab?.id === undefined
					? undefined
					: {
							id: tab.id,
							url: tab.url ?? "",
							title: tab.title ?? "",
							size,
							loading: tab.status === "loading",
						};
			// A hint is about the tab in front when it was given; the first read
			// of that tab is no change of it.
			if (
				s.tab !== undefined &&
				(next?.id !== s.tab.id || next?.url !== s.tab.url)
			)
				s.hint = undefined;
			s.tab = next;
			s.overlay = overlay;
			// Results describe the tab they came from, with that case loaded.
			if (
				s.loaded !== undefined &&
				(tab?.id !== s.loaded.tabId || overlay?.loadedCase !== s.loaded.caseId)
			)
				s.loaded = undefined;
		});
	} finally {
		refreshing--;
	}
	await refreshCases();
}

/** Only the size of the tab in front: a window or the panel was resized, or zoomed. */
async function refreshSize(): Promise<void> {
	const tab = await activeTab();
	const size = tab && (await tabSize(tab));
	update((s) => {
		if (s.tab !== undefined && s.tab.id === tab?.id) s.tab = { ...s.tab, size };
	});
}

async function refreshCases(): Promise<void> {
	const work = casesWork.start();
	const cases = await store.listCases();
	if (work.current()) update((s) => (s.cases = cases));
}

function releaseImages(s: PanelState): void {
	for (const url of s.images?.urls.values() ?? []) URL.revokeObjectURL(url);
	s.images = undefined;
}

/** Read the open case again, and its images when it changed. */
async function refreshCase(): Promise<void> {
	if (state.view.kind !== "case") return;
	const id = state.view.id;
	const work = caseWork.start();
	const c = await store.getCase(id);
	if (!work.current()) return;
	if (c === undefined) return closeCase();
	const opened = state.current?.id !== c.id;
	update((s) => (s.current = c));
	// Just opened: its marks go to the tab in front (DEC-022).
	if (opened) void follow();
	if (state.images?.caseId === c.id && state.images.version === c.updatedAt)
		return;
	const images = imagesWork.start();
	const urls = new Map<string, string>();
	for (const path of [
		...c.shots.map((x) => x.image),
		...c.annotations.map((a) => a.crop),
	]) {
		const image = await store.getImage(c.id, path);
		if (image !== undefined) urls.set(path, URL.createObjectURL(image.blob));
	}
	if (!images.current()) {
		for (const url of urls.values()) URL.revokeObjectURL(url);
		return;
	}
	update((s) => {
		releaseImages(s);
		s.images = { caseId: c.id, version: c.updatedAt, urls };
	});
}

/** Open a case, and draw its marks on the tab in front (DEC-022). */
function openCase(id: string): void {
	hintWork.cancel();
	const other = state.view.kind !== "case" || state.view.id !== id;
	// Opened again: a Hide on a tab holds no longer.
	if (other) hiddenOn.clear();
	update((s) => {
		if (other) {
			s.current = undefined;
			s.verdictStatus = undefined;
			releaseImages(s);
		}
		s.view = { kind: "case", id };
		s.caseHint = undefined;
		s.deleteArmedAt = undefined;
		s.markEdit = undefined;
		s.markFilter = undefined;
		s.markDeleteArmed = undefined;
		s.findingDeleteArmed = undefined;
	});
	followed = undefined;
	void refreshCase();
}

/** Back to the list: the marks the panel drew leave the page. */
function closeCase(): void {
	caseWork.cancel();
	imagesWork.cancel();
	hintWork.cancel();
	stopLoads();
	hiddenOn.clear();
	pendingLoad = undefined;
	if (drawn !== undefined) takeOff(drawn);
	update((s) => {
		s.view = { kind: "home" };
		s.current = undefined;
		s.caseHint = undefined;
		s.deleteArmedAt = undefined;
		s.loaded = undefined;
		releaseImages(s);
	});
	void refreshCases();
}

/**
 * For an action on the open case: writes its outcome under that case's
 * buttons, unless the panel left the case, or a newer action took over.
 */
function caseHintWriter(): (text: string | undefined) => void {
	const work = hintWork.start();
	return (text) => {
		if (work.current()) update((s) => (s.caseHint = text));
	};
}

/**
 * For the panel's own draws: writes under the case's buttons while no action
 * of the user's has written there since, and stops no action's hint itself.
 */
function followHint(): (text: string | undefined) => void {
	const work = hintWork.peek();
	return (text) => {
		if (work.current()) update((s) => (s.caseHint = text));
	};
}

/** The loaded case's results no longer describe the tab: drop them (and the marks). */
async function forgetLoaded(
	options: { hint?: string; clearTab?: boolean } = {},
): Promise<void> {
	const was = state.loaded;
	update((s) => {
		s.loaded = undefined;
		if (options.hint !== undefined) s.caseHint = options.hint;
	});
	if (was !== undefined && options.clearTab) takeOff(was);
}

/**
 * A deleted case's draft goes, its marks and bar leave the page, and a
 * toolbar adding to it starts a new case.
 */
async function clearDeleted(caseId: string): Promise<void> {
	update((s) => s.verdictDrafts.delete(caseId));
	if (state.loaded?.caseId === caseId) await forgetLoaded({ clearTab: true });
	const tabId = state.tab?.id;
	if (tabId === undefined) return;
	// An AI app's load_case: only the page knows.
	const overlay = await overlayState(tabId);
	if (overlay?.loadedCase === caseId)
		await chrome.tabs
			.sendMessage(tabId, { type: "case:clear", caseId })
			.catch(() => undefined);
	if (overlay?.visible && overlay.target?.caseId === caseId)
		await startAnnotating();
}

/** Tell a panel in another window; a page does not hear its own message. */
function announce(caseId: string): void {
	const news: Broadcast = { type: "cases:changed", caseId };
	chrome.runtime.sendMessage(news).catch(() => undefined);
}

/** The case the tab's toolbar was adding to, as stored now; it may be gone. */
async function continued(
	overlay: OverlayState | undefined,
): Promise<Case | undefined> {
	return overlay?.target && store.getCase(overlay.target.caseId);
}

/** Show the overlay on the tab in front, optionally to add to a case. */
async function startAnnotating(target?: Case): Promise<void> {
	const tab = await activeTab();
	if (tab?.id === undefined) return;
	tabWork.cancel(); // a refresh still running must not overwrite this
	try {
		const next = nextNumbers(target);
		const overlay = await sendToTab<OverlayState>(tab.id, {
			type: "overlay:show",
			blurForms: await blurFormsNow(),
			...(target
				? {
						target: {
							caseId: target.id,
							title: target.title,
							nextAnnotation: next.annotation,
						},
					}
				: {}),
		});
		update((s) => {
			s.overlay = overlay;
			s.hint = overlay.saving
				? "Overmark is still saving the last marks on this page; the toolbar switches once that is done."
				: undefined;
		});
	} catch (error) {
		update((s) => (s.hint = describeError(error)));
	}
}

/** An import is at work, or its question is open: no other import starts. */
const importBusy = () =>
	state.importWork !== undefined || state.importing !== undefined;

/**
 * Do an import's work (on `what`, a file's name), one at a time: the import
 * buttons are off meanwhile, and a second import does not start.
 */
async function importWork(
	what: string,
	work: () => Promise<void>,
): Promise<void> {
	if (state.importWork !== undefined) return;
	update((s) => (s.importWork = what));
	try {
		await work();
	} finally {
		update((s) => (s.importWork = undefined));
	}
}

/** Store one case of a file; the drawn marks of the version it replaced go. */
async function storeOne(parsed: CheckedExport, copy: boolean): Promise<Case> {
	const c = await storeImport(store, parsed, { copy });
	// Results (and drawn marks) of the version it replaced describe other marks.
	if (state.loaded?.caseId === c.id) await forgetLoaded({ clearTab: true });
	announce(c.id);
	return c;
}

/**
 * Store the case asked about. A file's only case opens; in a file of several
 * the next one follows.
 */
async function finishImport(
	parsed: CheckedExport,
	copy: boolean,
	batch?: ImportBatch,
): Promise<void> {
	update((s) => (s.importing = undefined));
	try {
		const c = await storeOne(parsed, copy);
		if (batch !== undefined) {
			batch.stored++;
			return await importRest(batch);
		}
		// Its marks are drawn on the tab in front, as for any case opened.
		openCase(c.id);
	} catch (error) {
		update(
			(s) =>
				(s.importError =
					batch === undefined
						? `Could not import: ${message(error)}`
						: `Could not import every case of ${batch.name}: ${message(error)} ${batchText(batch)}`),
		);
		if (batch !== undefined) void refreshCases();
	}
}

/** "Imported all 3 cases of cases.zip." */
function batchText(b: ImportBatch): string {
	const skipped = b.skipped > 0 ? `, ${b.skipped} left as they were` : "";
	return b.stored === b.total
		? `Imported all ${b.total} cases of ${b.name}.`
		: `Imported ${b.stored} of the ${b.total} cases of ${b.name}${skipped}.`;
}

/**
 * Import a file's cases one after the other: a new one at once, one that is
 * here already after the same question as a single case (DEC-020).
 */
async function importRest(batch: ImportBatch): Promise<void> {
	try {
		for (let next = batch.rest.shift(); next; next = batch.rest.shift()) {
			const parsed = next;
			const existing = await store.getCase(parsed.case.id);
			if (existing !== undefined) {
				update((s) => (s.importing = { parsed, existing, batch }));
				return;
			}
			await storeOne(parsed, false);
			batch.stored++;
		}
		update((s) => (s.importDone = batchText(batch)));
	} catch (error) {
		update(
			(s) =>
				(s.importError = `Could not import every case of ${batch.name}: ${message(error)} ${batchText(batch)}`),
		);
	} finally {
		void refreshCases();
	}
}

/** The visible note while Chrome's prompt for downloads is open. */
function asking(of: Exported["of"], allowed: Promise<boolean>): void {
	if (state.downloads) return;
	update((s) => (s.askingDownloads = of));
	void allowed.then(() =>
		update((s) => {
			if (s.askingDownloads === of) s.askingDownloads = undefined;
		}),
	);
}

/** Save an export, and show where it went when Chrome tells. */
async function saveExport(
	of: Exported["of"],
	bytes: Uint8Array | Blob,
	name: string,
	allowed: Promise<boolean>,
): Promise<void> {
	const saved: SavedFile | undefined = await saveFile(bytes, name, allowed);
	if (saved !== undefined) update((s) => (s.exported = { of, ...saved }));
}

async function refreshDownloads(): Promise<void> {
	const work = downloadsWork.start();
	const granted = await chrome.permissions.contains(DOWNLOADS);
	if (work.current()) update((s) => (s.downloads = granted));
}

const actions: Actions = {
	toggleAnnotate() {
		void (async () => {
			const tab = await activeTab();
			if (tab?.id === undefined) return;
			tabWork.cancel();
			// Ask the page: the state may have changed while no panel was listening.
			const now = await overlayState(tab.id);
			try {
				if (!now?.visible) return await startAnnotating(await continued(now));
				const overlay = await sendToTab<OverlayState>(tab.id, {
					type: "overlay:hide",
				});
				update((s) => (s.overlay = overlay));
			} catch (error) {
				update((s) => (s.hint = describeError(error)));
			}
		})();
	},

	openCase,
	closeCase,

	loadOntoTab(c) {
		// Off while Overmark may not run on the tab (view.ts): the notice
		// above it says what lets it.
		const hint = caseHintWriter();
		void (async () => {
			const tab = await activeTab();
			if (tab?.id === undefined) return;
			const work = startLoad({ tabId: tab.id, caseId: c.id });
			// Shown again by hand: a Hide on this tab holds no longer.
			hiddenOn.delete(tab.id);
			// This load replaces one the icon's click would start.
			if (pendingLoad?.tabId === tab.id) pendingLoad = undefined;
			await loadInto(c, tab.id, hint, work);
		})();
	},

	hideFromTab(c) {
		stopLoads();
		hintWork.cancel();
		// Where the panel loaded the case, and the tab in front where an AI app did.
		const tabs = new Set<number>();
		if (state.loaded?.caseId === c.id) tabs.add(state.loaded.tabId);
		if (drawn?.caseId === c.id) tabs.add(drawn.tabId);
		if (state.overlay?.loadedCase === c.id && state.tab !== undefined)
			tabs.add(state.tab.id);
		// Not drawn there again by itself (DEC-022).
		if (state.tab !== undefined) hiddenOn.add(state.tab.id);
		for (const tabId of tabs) hiddenOn.add(tabId);
		update((s) => {
			s.loaded = undefined;
			s.caseHint = undefined;
			// The page's news would say so too, a moment later.
			if (s.overlay?.loadedCase === c.id) {
				const { loadedCase: _, ...rest } = s.overlay;
				s.overlay = rest;
			}
		});
		for (const tabId of tabs) takeOff({ tabId, caseId: c.id });
	},

	allowAllSites() {
		// Chrome asks only during a click: nothing may be awaited before this.
		void chrome.permissions.request(ALL_SITES).then(
			// A yes: permissions.onAdded draws the open case's marks.
			() => refreshAllSites(),
			(error: unknown) =>
				update(
					(s) => (s.hint = `Could not change the access: ${message(error)}`),
				),
		);
	},

	openDetails() {
		void chrome.tabs
			.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })
			.catch((error: unknown) =>
				update(
					(s) => (s.hint = `Could not open the details: ${message(error)}`),
				),
			);
	},

	openPage(c) {
		if (!isWebPage(c.page.url)) return;
		const hint = caseHintWriter();
		// Now, while the click allows Chrome's prompt. The tab opens meanwhile;
		// once it has loaded, the case's marks follow it there (DEC-022), and
		// without a yes the icon's click lets Overmark run there.
		void askForSite(c.page.url);
		void chrome.tabs
			.create({ url: c.page.url })
			.catch((error: unknown) =>
				hint(`Could not open the page: ${message(error)}`),
			);
	},

	matchSize(c) {
		const hint = caseHintWriter();
		void (async () => {
			try {
				const want = {
					width: c.page.viewport.width,
					height: c.page.viewport.height,
				};
				const first = await activeTab();
				if (first?.id === undefined) return;
				// A maximised or full-screen window takes no size; leaving that
				// state takes a moment (an animation on macOS).
				if ((await chrome.windows.get(first.windowId)).state !== "normal") {
					await chrome.windows.update(first.windowId, { state: "normal" });
					await normalWindow(first.windowId);
					await settledSize(first.id);
				}
				let screenShort = false;
				let before = "";
				for (let attempt = 0; attempt < 3; attempt++) {
					const tab = await activeTab();
					if (tab?.id === undefined || !tab.width || !tab.height) return;
					const win = await chrome.windows.get(tab.windowId);
					if (
						win.state !== "normal" ||
						win.width === undefined ||
						win.height === undefined
					)
						break;
					const zoom = await chrome.tabs.getZoom(tab.id).catch(() => 1);
					const bigger = windowFor(
						want,
						{ width: tab.width, height: tab.height },
						{ width: win.width, height: win.height },
						zoom,
					);
					// The panel's screen is the window's.
					const room = screen as Screen & {
						availLeft?: number;
						availTop?: number;
					};
					const bounds = onScreen(
						bigger,
						{ left: win.left ?? 0, top: win.top ?? 0 },
						{
							left: room.availLeft ?? 0,
							top: room.availTop ?? 0,
							width: room.availWidth,
							height: room.availHeight,
						},
					);
					screenShort =
						bounds.width < bigger.width || bounds.height < bigger.height;
					await chrome.windows.update(tab.windowId, bounds);
					// Chrome sizes the tab a moment after the window.
					await settledSize(tab.id);
					const now = await activeTab();
					const size = now && (await tabSize(now));
					if (size && sameSize(size, want)) {
						await refreshTab();
						return hint(
							`This tab is now ${sizeText(size)}, as when the marks were made.`,
						);
					}
					// Another try would change nothing.
					const after = size ? sizeText(size) : "";
					if (screenShort || after === before) break;
					before = after;
				}
				await refreshTab();
				const size = state.tab?.size;
				hint(
					size === undefined
						? "Could not change the window's size."
						: screenShort
							? `The screen leaves room for ${sizeText(size)}; the marks were made at ${sizeText(want)}.`
							: `Chrome would not make this tab ${sizeText(want)}; it is ${sizeText(size)}. The device toolbar in DevTools shows a page at any size.`,
				);
			} catch (error) {
				hint(`Could not change the window's size: ${message(error)}`);
			}
		})();
	},

	addMarks: (c) => {
		// The marks drawn now show, whatever the list was filtered by.
		update((s) => (s.markFilter = undefined));
		void startAnnotating(c);
	},

	exportCase(c) {
		// Chrome asks only during a click: nothing may be awaited before this.
		const allowed = askForDownloads();
		const of = { caseId: c.id };
		asking(of, allowed);
		const hint = caseHintWriter();
		update((s) => (s.exported = undefined));
		void (async () => {
			try {
				const zip = await exportCase(store, c);
				await saveExport(of, zip, exportFileName(c), allowed);
			} catch (error) {
				hint(`Could not export: ${message(error)}`);
			}
		})();
	},

	copyPath: (path) =>
		navigator.clipboard.writeText(path).then(
			() => true,
			() => false,
		),

	showFile(e) {
		try {
			chrome.downloads.show(e.downloadId);
		} catch (error) {
			const text = `Could not show the file: ${message(error)}`;
			if (e.of === "all") update((s) => (s.importError = text));
			else caseHintWriter()(text);
		}
	},

	deleteCase(c) {
		const armedAt = state.deleteArmedAt;
		if (armedAt === undefined) {
			const now = Date.now();
			update((s) => (s.deleteArmedAt = now));
			setTimeout(() => {
				update((s) => {
					if (s.deleteArmedAt === now) s.deleteArmedAt = undefined;
				});
			}, DELETE_ARMED_MS);
			return;
		}
		if (Date.now() - armedAt < DELETE_CLICK_GAP_MS) return;
		const hint = caseHintWriter();
		void store.deleteCase(c.id).then(
			() => {
				closeCase();
				void clearDeleted(c.id);
				announce(c.id);
			},
			(error: unknown) => hint(`Could not delete: ${message(error)}`),
		);
	},

	editMark(_c, a, mode) {
		const status = markStatus(a);
		update((s) => {
			s.markDeleteArmed = undefined;
			s.markEdit = {
				annotationId: a.id,
				mode,
				kind: status === "open" ? "fixed" : status,
				text:
					mode === "comment"
						? a.comment
						: mode === "resolve"
							? (a.resolution?.note ?? "")
							: "",
			};
		});
	},

	typeMark(change) {
		update((s) => {
			if (s.markEdit !== undefined) s.markEdit = { ...s.markEdit, ...change };
		});
	},

	cancelMarkEdit() {
		update((s) => (s.markEdit = undefined));
	},

	resolveMark(c, a, kind, note) {
		const now = new Date().toISOString();
		void changeMark(c.id, a.id, (current) => ({
			value: withChoice(current, a.id, kind, note, now),
		}));
	},

	verifyMark(c, a) {
		const now = new Date().toISOString();
		void changeMark(c.id, a.id, (current) => ({
			value: withVerified(current, a.id, undefined, now),
		}));
	},

	reopenMark(c, a, note) {
		// The developer reads it first: in the panel, a reopen says why.
		if (note.trim() === "") return;
		const now = new Date().toISOString();
		void changeMark(c.id, a.id, (current) => ({
			// Opened meanwhile: the form stays, and says why.
			value: withReopen(current, a.id, { note, refuseOpen: true }, now),
		}));
	},

	filterMarks(caseId, group) {
		update((s) => {
			const highest = Math.max(
				0,
				...(s.current?.annotations.map((a) => a.number) ?? []),
			);
			s.markFilter =
				group === undefined ? undefined : { caseId, group, upTo: highest };
		});
	},

	saveComment(c, a, text) {
		const now = new Date().toISOString();
		void changeMark(c.id, a.id, (current) => ({
			value: withComment(current, a.id, text, now),
		}));
	},

	deleteMark(c, a) {
		const armed = state.markDeleteArmed;
		if (armed?.annotationId !== a.id) {
			const at = Date.now();
			update((s) => {
				s.markEdit = undefined;
				s.markDeleteArmed = { annotationId: a.id, at };
			});
			setTimeout(() => {
				update((s) => {
					if (s.markDeleteArmed?.at === at) s.markDeleteArmed = undefined;
				});
			}, DELETE_ARMED_MS);
			return;
		}
		// A double click is no second thought, nor a second delete.
		if (Date.now() - armed.at < DELETE_CLICK_GAP_MS) return;
		if (deleting.has(a.id)) return;
		deleting.add(a.id);
		const now = new Date().toISOString();
		void changeMark(c.id, a.id, (current) =>
			withoutAnnotation(current, a.id, now),
		).finally(() => deleting.delete(a.id));
	},

	deleteFinding(c, a, findingId) {
		const armed = state.findingDeleteArmed;
		if (armed?.annotationId !== a.id || armed.findingId !== findingId) {
			const at = Date.now();
			update(
				(s) => (s.findingDeleteArmed = { annotationId: a.id, findingId, at }),
			);
			setTimeout(() => {
				update((s) => {
					if (s.findingDeleteArmed?.at === at) s.findingDeleteArmed = undefined;
				});
			}, DELETE_ARMED_MS);
			return;
		}
		// A double click is no second thought, nor a second delete.
		if (Date.now() - armed.at < DELETE_CLICK_GAP_MS) return;
		// A finding's id is unique on its mark only.
		const key = `${a.id} ${findingId}`;
		if (deleting.has(key)) return;
		deleting.add(key);
		const now = new Date().toISOString();
		void changeMark(
			c.id,
			a.id,
			(current) => ({ value: withoutFinding(current, a.id, findingId, now) }),
			// The mark's comment or resolve form, unsaved, stays open.
			{ keepEdit: true },
		).finally(() => {
			deleting.delete(key);
			update((s) => {
				const armed = s.findingDeleteArmed;
				if (armed?.annotationId === a.id && armed.findingId === findingId)
					s.findingDeleteArmed = undefined;
			});
		});
	},

	typeVerdict(caseId, text) {
		update((s) => {
			if (s.current?.id === caseId && text === (s.current.verdict ?? ""))
				s.verdictDrafts.delete(caseId);
			else s.verdictDrafts.set(caseId, text);
		});
	},

	saveVerdict(caseId, text) {
		const value = text.trim();
		void (async () => {
			try {
				// One transaction, so marks saved meanwhile are kept.
				const saved = await store.updateCase(caseId, (current) => {
					if (current === undefined)
						throw new Error("The case no longer exists.");
					return {
						value: validateCase({
							...current,
							verdict: value === "" ? null : value,
							updatedAt: new Date().toISOString(),
						}),
					};
				});
				update((s) => {
					s.verdictStatus = "Saved";
					// The stored text from now on, unless typing went on meanwhile.
					if (s.verdictDrafts.get(caseId) === text)
						s.verdictDrafts.delete(caseId);
					if (s.current?.id === caseId) s.current = saved;
				});
				announce(caseId);
				await refreshCase();
			} catch (error) {
				update((s) => (s.verdictStatus = `Not saved: ${message(error)}`));
			}
			setTimeout(() => update((s) => (s.verdictStatus = undefined)), 2500);
		})();
	},

	showMatch(caseId, a: Annotation, candidate) {
		const loaded = state.loaded;
		if (loaded === undefined || loaded.caseId !== caseId) return;
		const hint = caseHintWriter();
		void (async () => {
			try {
				const m = (await chrome.tabs.sendMessage(loaded.tabId, {
					type: "case:show",
					caseId,
					annotationId: a.id,
					candidate,
				})) as AnnotationMatch | { error: string } | null;
				if (m === null) {
					await forgetLoaded({
						hint: "The case is no longer loaded on that tab. Load it again to see its marks there.",
					});
					return;
				}
				if ("error" in m) return hint(m.error);
				update((s) => s.loaded?.matches.set(a.id, m));
			} catch (error) {
				hint(describeError(error));
			}
		})();
	},

	importReplace() {
		const importing = state.importing;
		if (importing === undefined || state.importWork !== undefined) return;
		void importWork(
			importing.batch?.name ?? importing.parsed.case.title,
			async () => {
				try {
					const now = await store.getCase(importing.parsed.case.id);
					if (state.importing !== importing) return;
					// It changed under the prompt: ask again, with the new date.
					if (
						now !== undefined &&
						now.updatedAt !== importing.existing.updatedAt
					)
						update((s) => (s.importing = { ...importing, existing: now }));
					else await finishImport(importing.parsed, false, importing.batch);
				} catch (error) {
					update(
						(s) => (s.importError = `Could not import: ${message(error)}`),
					);
				}
			},
		);
	},
	importCopy() {
		const importing = state.importing;
		if (importing === undefined || state.importWork !== undefined) return;
		void importWork(importing.batch?.name ?? importing.parsed.case.title, () =>
			finishImport(importing.parsed, true, importing.batch),
		);
	},
	importCancel() {
		if (state.importWork !== undefined) return;
		const batch = state.importing?.batch;
		update((s) => (s.importing = undefined));
		// In a file of several: this one stays as it is, the next one follows.
		if (batch !== undefined) {
			batch.skipped++;
			void importWork(batch.name, () => importRest(batch));
		}
	},

	...syncActions(() => panelSync),
};

/** The sync to Downloads or a folder (DEC-021, DEC-025): the worker writes, the panel chooses. */
const panelSync = startSync(update);

// --- settings and import -------------------------------------------------------------

// "Blur form fields in screenshots" is the worker's (DEC-016): `ai.ts` shows
// it and sends a change over the panel's port.

async function refreshAllSites(): Promise<void> {
	const work = sitesWork.start();
	const granted = await chrome.permissions.contains(ALL_SITES);
	if (work.current()) update((s) => (s.allSites = granted));
}

allSites.addEventListener("change", () => {
	// Chrome asks only during a click: nothing may be awaited before this.
	const change = allSites.checked
		? chrome.permissions.request(ALL_SITES)
		: chrome.permissions.remove(ALL_SITES);
	void change
		.catch((error: unknown) =>
			update(
				(s) => (s.hint = `Could not change the access: ${message(error)}`),
			),
		)
		.then(refreshAllSites);
});
chrome.permissions.onAdded.addListener(() => {
	void refreshAllSites();
	void refreshDownloads();
	void refreshTab();
	// Overmark may run on the tab in front now: the open case's marks go there.
	void follow();
});
chrome.permissions.onRemoved.addListener(() => {
	void refreshAllSites();
	void refreshDownloads();
	void refreshTab();
});

byId<HTMLButtonElement>("annotate").addEventListener("click", () =>
	actions.toggleAnnotate(),
);

exportAllButton.addEventListener("click", () => {
	// Off while an import is at work (view.ts); it reads the cases it stores.
	if (importBusy()) return;
	// Chrome asks only during a click: nothing may be awaited before this.
	const allowed = askForDownloads();
	asking("all", allowed);
	update((s) => {
		s.exported = undefined;
		s.importError = undefined;
		s.importDone = undefined;
		s.exportingAll = true;
	});
	void (async () => {
		try {
			// The bytes go into a Blob at once, and are not kept beside it.
			const file = new Blob(
				[
					(await exportAllCases(
						store,
						await store.listCases(),
					)) as Uint8Array<ArrayBuffer>,
				],
				{ type: "application/zip" },
			);
			await saveExport("all", file, exportAllFileName(), allowed);
		} catch (error) {
			update(
				(s) =>
					(s.importError = `Could not export all cases: ${message(error)}`),
			);
		} finally {
			update((s) => (s.exportingAll = false));
		}
	})();
});

importButton.addEventListener("click", () => {
	if (!importBusy()) importFile.click();
});
importFile.addEventListener("change", () => {
	const file = importFile.files?.[0];
	importFile.value = "";
	if (file === undefined) return;
	// One import at a time: its question is answered before another file is read.
	if (importBusy()) return;
	update((s) => {
		s.importError = undefined;
		s.importDone = undefined;
	});
	void importWork(file.name, () => importOne(file));
});

/** Read a chosen file, and store its cases (or ask about the first one here already). */
async function importOne(file: File): Promise<void> {
	try {
		if (file.size > MAX_IMPORT_ALL_BYTES)
			throw new Error(
				`it is larger than ${MAX_IMPORT_ALL_BYTES / 1024 / 1024} MB`,
			);
		const cases = await readExports(new Uint8Array(await file.arrayBuffer()));
		const [parsed] = cases;
		if (cases.length > 1 || parsed === undefined)
			return await importRest({
				name: file.name,
				rest: cases,
				total: cases.length,
				stored: 0,
				skipped: 0,
			});
		const existing = await store.getCase(parsed.case.id);
		// Ask only when it would replace a case that is here already.
		if (existing === undefined) await finishImport(parsed, false);
		else update((s) => (s.importing = { parsed, existing }));
	} catch (error) {
		update(
			(s) =>
				(s.importError = `Could not import ${file.name}: ${message(error)}`),
		);
	}
}
byId<HTMLButtonElement>("import-dismiss").addEventListener("click", () =>
	update((s) => (s.importError = undefined)),
);

// --- AI app ------------------------------------------------------------------

/** A tool, or another panel, changed or deleted a case: show it. */
function caseChanged(caseId: string): void {
	if (state.view.kind === "case" && state.view.id === caseId)
		void refreshCase();
	void refreshCases();
	void store.getCase(caseId).then((c) => {
		if (c === undefined) return clearDeleted(caseId);
		// A mark settled or deleted elsewhere (an AI app, another window).
		return redrawLoaded(c);
	});
}

/**
 * The case changed while its marks are on a page: they follow, and the
 * candidates chosen there stay.
 */
async function redrawLoaded(c: Case): Promise<void> {
	const tabs = new Set<number>();
	if (state.loaded?.caseId === c.id) tabs.add(state.loaded.tabId);
	if (state.overlay?.loadedCase === c.id && state.tab !== undefined)
		tabs.add(state.tab.id);
	for (const tabId of tabs) {
		const result = (await chrome.tabs
			.sendMessage(tabId, { type: "case:update", case: c })
			.catch(() => null)) as LoadResult | null;
		if (result === null) continue;
		update((s) => {
			if (s.loaded?.caseId === c.id && s.loaded.tabId === tabId)
				s.loaded = {
					...s.loaded,
					matches: new Map(result.matches.map((m) => [m.annotationId, m])),
				};
		});
	}
}

/**
 * Marks (their id) and findings (mark id, space, finding id) being deleted
 * now: a second click waits for the first.
 */
const deleting = new Set<string>();

/**
 * Change a mark of a case in one transaction, then show and draw the result.
 * The mark's form closes, unless `keepEdit`: a change the form is not about.
 */
async function changeMark(
	caseId: string,
	annotationId: string,
	change: (current: Case) => { value: Case; images?: string[] },
	{ keepEdit = false } = {},
): Promise<void> {
	const hint = caseHintWriter();
	try {
		// The images go in the same transaction: a save may take a freed path.
		const saved = await store.updateCase(caseId, (current) => {
			if (current === undefined) throw new Error("The case no longer exists.");
			const next = change(current);
			return {
				value: validateCase(next.value),
				deleteImages: next.images ?? [],
			};
		});
		update((s) => {
			// Another mark's form, opened meanwhile, stays.
			if (!keepEdit && s.markEdit?.annotationId === annotationId)
				s.markEdit = undefined;
			if (s.markDeleteArmed?.annotationId === annotationId)
				s.markDeleteArmed = undefined;
			if (s.current?.id === caseId) s.current = saved;
		});
		announce(caseId);
		await refreshCase();
		await redrawLoaded(saved);
	} catch (error) {
		hint(`Not saved: ${message(error)}`);
	}
}

// The header's AI pill leaves an open case: the AI app card is on the home view.
void startAi(update, () => {
	if (state.view.kind === "case") closeCase();
});

// --- news from the pages and the browser -----------------------------------------

chrome.runtime.onMessage.addListener((news: Broadcast, sender) => {
	if (sender.id !== chrome.runtime.id) return false;
	if (news?.type === "overlay:changed") {
		const from = sender.tab?.id;
		// Overmark runs on the tab the open case waits for: the icon was clicked.
		if (from !== undefined && from === pendingLoad?.tabId) {
			pendingLoad = undefined;
			void follow();
		}
		// The page's own Hide (on its bar) took the panel's marks off: it
		// holds as the panel's Hide does.
		if (
			from !== undefined &&
			from === drawn?.tabId &&
			news.state.loadedCase === undefined &&
			loadsUnderWay === 0 &&
			// Its results: a page loaded again (no results then) starts empty.
			state.loaded?.tabId === from &&
			state.loaded.caseId === drawn.caseId
		) {
			hiddenOn.add(from);
			drawn = undefined;
			// The searches again must not draw them back.
			if (loadTarget?.tabId === from) stopLoads();
		}
		// The page's own Hide removed the loaded case's marks.
		if (
			state.loaded !== undefined &&
			from === state.loaded.tabId &&
			news.state.loadedCase !== state.loaded.caseId
		)
			void forgetLoaded();
		// Only the tab the panel shows matters.
		if (from !== undefined && from === state.tab?.id) {
			update((s) => (s.overlay = news.state));
			// A refresh may have read the page before this news, or be finding
			// out that another tab is in front now: it starts over. A tab whose
			// address Chrome hid lets Overmark in now: the icon was clicked.
			if (refreshing > 0 || state.tab.url === "") void refreshTab();
		}
	} else if (news?.type === "cases:changed") {
		caseChanged(news.caseId);
		void refreshTab();
	} else if (news?.type === "sync:changed") void panelSync.refresh();
	return false;
});

/** The window this panel is in. */
let panelWindow: number | undefined;
void chrome.windows.getCurrent().then((w) => (panelWindow = w.id));
chrome.tabs.onActivated.addListener(({ windowId }) => {
	void refreshTab();
	// The open case's marks follow it to the tab in front of this window.
	if (panelWindow === undefined || windowId === panelWindow) void follow();
});
// The tab's size: the window's, the panel's own width, or the zoom changed.
let resized: ReturnType<typeof setTimeout> | undefined;
const sizeChanged = () => {
	clearTimeout(resized);
	resized = setTimeout(() => void refreshSize(), 150);
};
chrome.windows.onBoundsChanged.addListener((w) => {
	if (w.id === panelWindow) sizeChanged();
});
chrome.tabs.onZoomChange.addListener(({ tabId }) => {
	if (tabId === state.tab?.id) sizeChanged();
});
window.addEventListener("resize", sizeChanged);
chrome.tabs.onUpdated.addListener((id, info) => {
	if (id === state.loaded?.tabId && info.status === "loading")
		void forgetLoaded();
	// A new page: a draw under way was for the old one.
	if (id === drawing?.tabId && info.status === "loading") drawing = undefined;
	if (info.status === "complete" || info.url !== undefined) {
		void refreshTab();
		// Loaded, reloaded or navigated: the open case's marks are drawn there
		// again when it is the tab in front and the page no longer shows them;
		// a new address within the page (a hash, pushState) keeps them (DEC-022).
		void follow();
	}
});
chrome.tabs.onRemoved.addListener((id) => {
	if (id === state.loaded?.tabId) void forgetLoaded();
	if (id === pendingLoad?.tabId) pendingLoad = undefined;
	if (id === drawn?.tabId) drawn = undefined;
	hiddenOn.delete(id);
});

void refreshTab();
void refreshAllSites();
void refreshDownloads();
// Turning "Allow access to file URLs" on or off reloads Overmark: once is enough.
void chrome.extension.isAllowedFileSchemeAccess().then(
	(allowed) => update((s) => (s.fileAccess = allowed)),
	() => undefined,
);
