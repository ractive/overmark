/**
 * The side panel: the tab in front, annotating it, the saved cases, and the
 * connection to an AI app. Actions change the panel's one state (state.ts);
 * view.ts draws it (DEC-011).
 */

import type { TabMcp, ToolCallStart } from "@ractive-ch/tab-mcp-client";
import {
	type Annotation,
	type Case,
	nextNumbers,
	validateCase,
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
	ContentRequest,
	LoadResult,
	OverlayState,
} from "../lib/messages.ts";
import { IdbStore } from "../lib/store.ts";
import { NoAccessError, sendToTab } from "../lib/tabs.ts";
import { byId, h, shortUrl } from "./dom.ts";
import {
	createConnection,
	DEFAULT_RELAY,
	KeepOn,
	relayProblem,
} from "./mcp.ts";
import { Latest, Panel, type PanelState } from "./state.ts";
import { type Actions, NO_ACCESS, render } from "./view.ts";

const store = new IdbStore();

const blurForms = byId<HTMLInputElement>("blur-forms");
const importButton = byId<HTMLButtonElement>("import");
const importFile = byId<HTMLInputElement>("import-file");
const relayInput = byId<HTMLInputElement>("relay");
const connectButton = byId<HTMLButtonElement>("connect");
const keepOn = byId<HTMLInputElement>("keep-on");
const allSites = byId<HTMLInputElement>("all-sites");

const BLUR_KEY = "overmark:blur-forms";
const RELAY_KEY = "overmark:relay";
const KEEP_ON_KEY = "overmark:keep-ai-on";

const ALL_SITES = { origins: ["<all_urls>"] };

/** After a first click on Delete: the second click of a double-click is no decision. */
const DELETE_CLICK_GAP_MS = 500;
/** After a first click on Delete: a click much later is no decision either. */
const DELETE_ARMED_MS = 4000;

function readSetting(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeSetting(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Storage blocked: the setting lasts until the panel closes.
	}
}

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
		if (!work.current()) return;
		update((s) => {
			const next =
				tab?.id === undefined
					? undefined
					: { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" };
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

/** The loaded case's results no longer describe the tab: drop them (and the outlines). */
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
			.sendMessage(was.tabId, { type: "case:clear" })
			.catch(() => undefined);
}

/** A deleted case's draft goes, and its outlines and bar leave the page. */
async function clearDeleted(caseId: string): Promise<void> {
	update((s) => s.verdictDrafts.delete(caseId));
	if (state.loaded?.caseId === caseId) await forgetLoaded({ clearTab: true });
	// An AI app's load_case: only the page knows.
	const tabId = state.tab?.id;
	if (tabId !== undefined && (await overlayState(tabId))?.loadedCase === caseId)
		await chrome.tabs
			.sendMessage(tabId, { type: "case:clear" })
			.catch(() => undefined);
}

/** Tell a panel in another window; a page does not hear its own message. */
function announce(caseId: string): void {
	const news: Broadcast = { type: "cases:changed", caseId };
	chrome.runtime.sendMessage(news).catch(() => undefined);
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
			blurForms: blurForms.checked,
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
		// Results (and outlines) of the version it replaced describe other marks.
		if (state.loaded?.caseId === c.id) await forgetLoaded({ clearTab: true });
		announce(c.id);
		openCase(c.id);
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
			if (!now?.visible) return startAnnotating();
			try {
				const overlay = await sendToTab<OverlayState>(tab.id, {
					type: "overlay:hide",
				});
				update((s) => (s.overlay = overlay));
			} catch (error) {
				update((s) => (s.hint = describeError(error)));
			}
		})();
	},

	openCase: (id) => openCase(id),
	closeCase,

	loadOntoTab(c) {
		const hint = caseHintWriter();
		void (async () => {
			const tab = await activeTab();
			if (tab?.id === undefined) return;
			try {
				const result = await sendToTab<LoadResult | { error: string }>(tab.id, {
					type: "case:load",
					case: c,
				});
				if ("error" in result) return hint(result.error);
				const found = result.matches.filter(
					(m) => m.status !== "lost" && m.status !== "no-element",
				).length;
				update((s) => {
					s.loaded = {
						caseId: c.id,
						tabId: tab.id as number,
						matches: new Map(result.matches.map((m) => [m.annotationId, m])),
					};
				});
				hint(
					`${found} of ${result.matches.length} marks found on ${shortUrl(result.url)}. Outlines: green found, amber dashed probable or unsure.`,
				);
			} catch (error) {
				hint(describeError(error));
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

blurForms.checked = readSetting(BLUR_KEY) === "true";
blurForms.addEventListener("change", () => {
	writeSetting(BLUR_KEY, String(blurForms.checked));
	// An overlay already open on a tab took the setting when it was shown.
	const news: ContentRequest = {
		type: "overlay:settings",
		blurForms: blurForms.checked,
	};
	void chrome.tabs.query({}).then((tabs) => {
		for (const { id } of tabs)
			if (id !== undefined)
				chrome.tabs.sendMessage(id, news).catch(() => undefined);
	});
});

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
	});
}

function connectTo(relay: string): TabMcp {
	return createConnection(relay, store, {
		onChange: (caseId) => {
			caseChanged(caseId);
			announce(caseId);
		},
		blurForms: () => blurForms.checked,
	});
}

/** Shown while disconnected when the saved relay could not be used. */
let relayNote: string | undefined;
let relay = readSetting(RELAY_KEY) ?? DEFAULT_RELAY;
let mcp: TabMcp;
try {
	mcp = connectTo(relay);
} catch (error) {
	// A stored address the library refuses must not stop the panel.
	relayNote = `The saved relay ${relay} cannot be used (${message(error)}); using ${DEFAULT_RELAY}.`;
	relay = DEFAULT_RELAY;
	mcp = connectTo(relay);
}
relayInput.value = relay;
update((s) => (s.ai.keepOn = readSetting(KEEP_ON_KEY) === "true"));

const keep = new KeepOn(() => state.ai.keepOn, aiChanged);

function aiChanged(): void {
	const grants = mcp.grants;
	const connected = mcp.state !== "disconnected";
	const problem =
		keep.problem &&
		`Not connected: ${keep.problem}${keep.retrying ? " Trying again…" : ""}`;
	update((s) => {
		s.ai = {
			...s.ai,
			connected,
			active: connected || mcp.reconnecting !== undefined || keep.retrying,
			status:
				mcp.state === "connected"
					? grants.length > 0
						? `Connected: ${grants.map((g) => g.client.name).join(", ")}`
						: "Waiting for an AI app to pair"
					: mcp.state === "connecting"
						? "Connecting…"
						: mcp.reconnecting
							? "Connection lost, retrying…"
							: [relayNote, problem].filter(Boolean).join(" ") ||
								"Not connected",
		};
	});
}

function aiCalled({ tool, title, client }: ToolCallStart): void {
	update((s) => {
		s.ai.lastCall = {
			tool: title ?? tool,
			// The name is what the app declares; the host is verified.
			app: client.name ? `${client.name} (${client.host})` : client.host,
			at: Date.now(),
		};
	});
}

function watch(connection: TabMcp): void {
	for (const type of [
		"statechange",
		"grantschange",
		"reconnecting",
		"disconnected",
	])
		connection.addEventListener(type, aiChanged);
	connection.addEventListener("toolcall", (event) => aiCalled(event.detail));
	keep.watch(connection);
}
watch(mcp);
aiChanged();

relayInput.addEventListener("change", () => {
	const value = relayInput.value.trim();
	const refuse = (problem: string) => {
		relayInput.setCustomValidity(problem);
		relayInput.reportValidity();
	};
	const problem = relayProblem(value);
	if (problem !== undefined) return refuse(problem);
	// Build the new connection first: the setting and the old connection
	// change only once it exists.
	let next: TabMcp;
	try {
		next = connectTo(value);
	} catch (error) {
		return refuse(message(error));
	}
	relayInput.setCustomValidity("");
	writeSetting(RELAY_KEY, value);
	relayNote = undefined;
	mcp.disconnect();
	mcp = next;
	watch(mcp);
	aiChanged();
	keep.connect();
});

connectButton.addEventListener("click", () => {
	const connection = mcp;
	void connection.showConnectDialog().catch((error: unknown) => {
		if (connection === mcp) keep.failed(error);
	});
});

function setKeepOn(on: boolean): void {
	update((s) => (s.ai.keepOn = on));
	writeSetting(KEEP_ON_KEY, String(on));
}

keepOn.addEventListener("change", () => {
	setKeepOn(keepOn.checked);
	if (state.ai.keepOn) keep.connect();
	else keep.stop();
});

// Ends the session, not the pairing: the AI app works again after the next
// connect. "Keep AI access on" would undo that, so it goes off too.
byId<HTMLButtonElement>("stop-ai").addEventListener("click", () => {
	setKeepOn(false);
	keep.stop();
	mcp.disconnect();
	aiChanged();
});

keep.connect();

// --- news from the pages and the browser -----------------------------------------

chrome.runtime.onMessage.addListener((news: Broadcast, sender) => {
	if (sender.id !== chrome.runtime.id) return false;
	if (news?.type === "overlay:changed") {
		const from = sender.tab?.id;
		// The page's own Hide removed the loaded case's outlines.
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

chrome.tabs.onActivated.addListener(() => void refreshTab());
chrome.tabs.onUpdated.addListener((id, info) => {
	if (id === state.loaded?.tabId && info.status === "loading")
		void forgetLoaded();
	if (info.status === "complete" || info.url !== undefined) void refreshTab();
});
chrome.tabs.onRemoved.addListener((id) => {
	if (id === state.loaded?.tabId) void forgetLoaded();
});

void refreshTab();
void refreshAllSites();
