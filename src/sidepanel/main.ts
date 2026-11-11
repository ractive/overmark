/**
 * The side panel: the tab in front, annotating it, the saved cases, and the
 * connection to an AI app. Actions change the panel's one state (state.ts);
 * view.ts draws it (DEC-011).
 */

import {
	type Annotation,
	type Case,
	isPageOf,
	nextNumbers,
	validateCase,
	withComment,
	withoutAnnotation,
	withoutFinding,
	withResolution,
} from "../lib/case.ts";
import {
	exportCase,
	exportFileName,
	MAX_IMPORT_BYTES,
	type ParsedExport,
	readExport,
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
import { byId, h, isWebPage, shortUrl, sitePattern } from "./dom.ts";
import { cssSize, onScreen, type Size, sameSize, windowFor } from "./size.ts";
import { Latest, Panel, type PanelState } from "./state.ts";
import { type Actions, NO_ACCESS, render } from "./view.ts";

const store = new IdbStore();

const importButton = byId<HTMLButtonElement>("import");
const importFile = byId<HTMLInputElement>("import-file");
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

/** A case to load onto a tab once the icon's click there lets Overmark in. */
let pendingLoad: { tabId: number; caseId: string } | undefined;

/**
 * Loads the case onto the tab and says how it went; `undefined` when it could
 * not, the hint says why.
 */
async function loadInto(
	c: Case,
	tabId: number,
	hint: (text: string) => void,
	work: { current: () => boolean },
): Promise<{ found: number; total: number } | undefined> {
	try {
		const result = await sendToTab<LoadResult | { error: string }>(tabId, {
			type: "case:load",
			case: c,
		});
		if ("error" in result) {
			hint(result.error);
			return undefined;
		}
		// Hidden meanwhile: the marks this load drew go too.
		if (!work.current()) {
			void chrome.tabs
				.sendMessage(tabId, { type: "case:clear", caseId: c.id })
				.catch(() => undefined);
			return undefined;
		}
		// Results describe the tab in front (see refreshTab).
		if ((await activeTab())?.id !== tabId) return undefined;
		const found = result.matches.filter(
			(m) => m.status !== "lost" && m.status !== "no-element",
		).length;
		update((s) => {
			s.loaded = {
				caseId: c.id,
				tabId,
				matches: new Map(result.matches.map((m) => [m.annotationId, m])),
			};
		});
		hint(
			`${found} of ${result.matches.length} marks found on ${shortUrl(result.url)}. Green: found. Amber, dashed: probable or unsure.`,
		);
		return { found, total: result.matches.length };
	} catch (error) {
		hint(describeError(error));
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
	hint: (text: string) => void,
): Promise<void> {
	const work = loadWork.start();
	for (const wait of [0, 1000, 2000]) {
		if (wait > 0) {
			await sleep(wait);
			if (!work.current() || !showing(c.id)) return;
			if ((await activeTab())?.id !== tabId) return;
		}
		const result = await loadInto(c, tabId, hint, work);
		if (result === undefined || result.found === result.total) return;
	}
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

/** The tab once it has loaded; `undefined` if it closed or took too long. */
function loadedTab(
	tabId: number,
	timeout = 30_000,
): Promise<chrome.tabs.Tab | undefined> {
	return new Promise((resolve) => {
		const done = (tab?: chrome.tabs.Tab) => {
			clearTimeout(timer);
			chrome.tabs.onUpdated.removeListener(updated);
			chrome.tabs.onRemoved.removeListener(removed);
			resolve(tab);
		};
		const updated = (
			id: number,
			info: { status?: string },
			tab: chrome.tabs.Tab,
		) => {
			if (id === tabId && info.status === "complete") done(tab);
		};
		const removed = (id: number) => {
			if (id === tabId) done();
		};
		const timer = setTimeout(() => done(), timeout);
		chrome.tabs.onUpdated.addListener(updated);
		chrome.tabs.onRemoved.addListener(removed);
		// It may have loaded before anyone listened.
		chrome.tabs.get(tabId).then(
			(tab) => {
				if (tab.status === "complete") done(tab);
			},
			() => done(),
		);
	});
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
					: { id: tab.id, url: tab.url ?? "", title: tab.title ?? "", size };
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
	update((s) => (s.current = c));
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

function openCase(id: string, caseHint?: string): void {
	hintWork.cancel();
	update((s) => {
		if (s.view.kind !== "case" || s.view.id !== id) {
			s.current = undefined;
			s.verdictStatus = undefined;
			releaseImages(s);
		}
		s.view = { kind: "case", id };
		s.caseHint = caseHint;
		s.deleteArmedAt = undefined;
		s.markEdit = undefined;
		s.markDeleteArmed = undefined;
		s.findingDeleteArmed = undefined;
	});
	void refreshCase();
}

function closeCase(): void {
	caseWork.cancel();
	imagesWork.cancel();
	hintWork.cancel();
	update((s) => {
		s.view = { kind: "home" };
		s.current = undefined;
		s.caseHint = undefined;
		s.deleteArmedAt = undefined;
		releaseImages(s);
	});
	void refreshCases();
}

/**
 * For an action on the open case: writes its outcome under that case's
 * buttons, unless the panel left the case, or a newer action took over.
 */
function caseHintWriter(): (text: string) => void {
	const work = hintWork.start();
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
	if (was !== undefined && options.clearTab)
		await chrome.tabs
			.sendMessage(was.tabId, { type: "case:clear", caseId: was.caseId })
			.catch(() => undefined);
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

async function finishImport(
	parsed: ParsedExport,
	copy: boolean,
): Promise<void> {
	update((s) => (s.importing = undefined));
	try {
		const c = await storeImport(store, parsed, { copy });
		// Results (and drawn marks) of the version it replaced describe other marks.
		if (state.loaded?.caseId === c.id) await forgetLoaded({ clearTab: true });
		announce(c.id);
		openCase(c.id);
		const url = state.tab?.url;
		if (url && isPageOf(c, url)) actions.loadOntoTab(c);
	} catch (error) {
		update((s) => (s.importError = `Could not import: ${message(error)}`));
	}
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

	openCase(id) {
		// The page in front is the case's: show its marks there too, unless
		// they are already (a load again would drop the candidates chosen).
		const c = state.cases.find((it) => it.id === id);
		const url = state.tab?.url;
		const loaded =
			state.loaded?.caseId === id || state.overlay?.loadedCase === id;
		if (c && url && isPageOf(c, url) && !loaded) return actions.openAndLoad(c);
		// Chrome hides the address of a tab Overmark may not run on yet: the
		// icon's click there tells it, and the case loads if it is that page's.
		const tab = state.tab;
		if (c && tab !== undefined && !tab.url && !loaded) {
			pendingLoad = { tabId: tab.id, caseId: id };
			return openCase(
				id,
				"If this tab shows the case's page, click the Overmark icon in the toolbar (or press Alt+Shift+O) and the case loads here.",
			);
		}
		openCase(id);
	},
	closeCase,

	loadOntoTab(c) {
		const hint = caseHintWriter();
		// Chrome hides the address of a tab Overmark may not run on: ask for
		// the case's site, the likeliest one. Another site needs the icon.
		const asked =
			state.tab !== undefined && !state.tab.url
				? askForSite(c.page.url)
				: undefined;
		void (async () => {
			const work = loadWork.start();
			const tab = await activeTab();
			if (tab?.id === undefined) return;
			// This load replaces one the icon's click would start.
			if (pendingLoad?.tabId === tab.id) pendingLoad = undefined;
			const loaded = await loadInto(c, tab.id, hint, work);
			// Allowed by Chrome's prompt only now: once more.
			if (loaded !== undefined || asked === undefined || !(await asked)) return;
			if (!work.current()) return;
			await refreshTab();
			if (state.tab?.id === tab.id && !state.tab.url)
				return hint(
					`This tab is not on ${shortUrl(c.page.url)}, so the access to that site does not reach it. Click the Overmark icon in the toolbar (or press Alt+Shift+O) while this tab is in front.`,
				);
			await loadInto(c, tab.id, hint, work);
		})();
	},

	hideFromTab(c) {
		loadWork.cancel();
		hintWork.cancel();
		// Where the panel loaded the case, and the tab in front where an AI app did.
		const tabs = new Set<number>();
		if (state.loaded?.caseId === c.id) tabs.add(state.loaded.tabId);
		if (state.overlay?.loadedCase === c.id && state.tab !== undefined)
			tabs.add(state.tab.id);
		update((s) => {
			s.loaded = undefined;
			s.caseHint = undefined;
			// The page's news would say so too, a moment later.
			if (s.overlay?.loadedCase === c.id) {
				const { loadedCase: _, ...rest } = s.overlay;
				s.overlay = rest;
			}
		});
		for (const tabId of tabs)
			void chrome.tabs
				.sendMessage(tabId, { type: "case:clear", caseId: c.id })
				.catch(() => undefined);
	},

	openAndLoad(c) {
		openCase(c.id);
		actions.loadOntoTab(c);
	},

	openPage(c) {
		if (!isWebPage(c.page.url)) return;
		const hint = caseHintWriter();
		// Now, while the click allows Chrome's prompt. The tab opens meanwhile,
		// and without a yes the icon's click lets Overmark run there (below).
		const asked = askForSite(c.page.url);
		void (async () => {
			try {
				const opened = await chrome.tabs.create({ url: c.page.url });
				if (opened.id === undefined) return;
				hint(`Opening ${shortUrl(c.page.url)}…`);
				const tab = await loadedTab(opened.id);
				if (tab === undefined)
					return hint(
						`${shortUrl(c.page.url)} did not finish loading. Press "Show marks on this tab" once it has.`,
					);
				// The user went on to another case or tab meanwhile: leave it be.
				if (!showing(c.id) || (await activeTab())?.id !== tab.id)
					return hint("");
				// Chrome tells the address only where Overmark may run. Elsewhere
				// the icon's click lets it: the case loads then (see onMessage).
				const url = tab.url;
				if (url === undefined) {
					pendingLoad = { tabId: opened.id, caseId: c.id };
					hint(
						"Click the Overmark icon in the toolbar (or press Alt+Shift+O) to load the case onto this tab.",
					);
					// A yes to Chrome's prompt after the page loaded: load it now,
					// unless the icon's click did already, as the click would.
					if (!(await asked) || pendingLoad?.tabId !== opened.id) return;
					pendingLoad = undefined;
					return await loadPending(c.id, opened.id);
				}
				// The page may have sent the tab elsewhere, to a sign-in say.
				if (!isPageOf(c, url))
					return hint(
						`The page went on to ${shortUrl(url)}, so the case was not loaded there.`,
					);
				await loadOnLoaded(c, opened.id, hint);
			} catch (error) {
				hint(`Could not open the page: ${message(error)}`);
			}
		})();
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

	addMarks: (c) => void startAnnotating(c),

	exportCase(c) {
		const hint = caseHintWriter();
		void (async () => {
			try {
				const zip = await exportCase(store, c);
				const url = URL.createObjectURL(
					new Blob([zip as Uint8Array<ArrayBuffer>], {
						type: "application/zip",
					}),
				);
				const link = h("a", { href: url, download: exportFileName(c) });
				document.body.append(link);
				link.click();
				link.remove();
				setTimeout(() => URL.revokeObjectURL(url), 30_000);
			} catch (error) {
				hint(`Could not export: ${message(error)}`);
			}
		})();
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
		update((s) => {
			s.markDeleteArmed = undefined;
			s.markEdit = {
				annotationId: a.id,
				mode,
				kind: a.resolution?.kind ?? "fixed",
				text: mode === "comment" ? a.comment : (a.resolution?.note ?? ""),
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
			value: withResolution(current, a.id, { kind, note }, now),
		}));
	},

	reopenMark(c, a) {
		const now = new Date().toISOString();
		void changeMark(c.id, a.id, (current) => ({
			value: withResolution(current, a.id, null, now),
		}));
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
		if (importing === undefined) return;
		void (async () => {
			const now = await store.getCase(importing.parsed.case.id);
			if (state.importing !== importing) return;
			// It changed under the prompt: ask again, with the new date.
			if (now !== undefined && now.updatedAt !== importing.existing.updatedAt)
				update((s) => (s.importing = { ...importing, existing: now }));
			else await finishImport(importing.parsed, false);
		})().catch((error: unknown) =>
			update((s) => (s.importError = `Could not import: ${message(error)}`)),
		);
	},
	importCopy() {
		if (state.importing) void finishImport(state.importing.parsed, true);
	},
	importCancel: () => update((s) => (s.importing = undefined)),
};

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
	void refreshTab();
});
chrome.permissions.onRemoved.addListener(() => {
	void refreshAllSites();
	void refreshTab();
});

byId<HTMLButtonElement>("annotate").addEventListener("click", () =>
	actions.toggleAnnotate(),
);

importButton.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
	const file = importFile.files?.[0];
	importFile.value = "";
	if (file === undefined) return;
	update((s) => (s.importError = undefined));
	try {
		if (file.size > MAX_IMPORT_BYTES)
			throw new Error(`it is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB`);
		const parsed = await readExport(new Uint8Array(await file.arrayBuffer()));
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
});
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
		// Overmark runs on the tab a case's address opened: the icon was clicked.
		if (from !== undefined && from === pendingLoad?.tabId) {
			const caseId = pendingLoad.caseId;
			pendingLoad = undefined;
			void loadPending(caseId, from);
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
			// out that another tab is in front now: it starts over.
			if (refreshing > 0) void refreshTab();
		}
	} else if (news?.type === "cases:changed") {
		caseChanged(news.caseId);
		void refreshTab();
	}
	return false;
});

/** The case its address opened a tab for, now that Overmark may run there. */
async function loadPending(caseId: string, tabId: number): Promise<void> {
	const c = state.current;
	if (c?.id !== caseId || !showing(caseId)) return;
	const tab = await chrome.tabs.get(tabId).catch(() => undefined);
	if (tab?.url === undefined || !isPageOf(c, tab.url)) return;
	if ((await activeTab())?.id !== tabId) return;
	await loadOnLoaded(c, tabId, caseHintWriter());
}

chrome.tabs.onActivated.addListener(() => void refreshTab());
// The tab's size: the window's, the panel's own width, or the zoom changed.
let resized: ReturnType<typeof setTimeout> | undefined;
const sizeChanged = () => {
	clearTimeout(resized);
	resized = setTimeout(() => void refreshSize(), 150);
};
let panelWindow: number | undefined;
void chrome.windows.getCurrent().then((w) => (panelWindow = w.id));
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
	if (info.status === "complete" || info.url !== undefined) void refreshTab();
});
chrome.tabs.onRemoved.addListener((id) => {
	if (id === state.loaded?.tabId) void forgetLoaded();
	if (id === pendingLoad?.tabId) pendingLoad = undefined;
});

void refreshTab();
void refreshAllSites();
