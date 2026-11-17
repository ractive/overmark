/**
 * The service worker: a click on the icon (or Alt+Shift+O) opens the side
 * panel and injects the content script into that tab (the click grants
 * `activeTab`). It captures screenshots and writes cases for the content
 * script, which runs in the page's origin and cannot reach the extension's
 * storage. And it holds the connection to the AI app (DEC-015), so that it
 * stays while the side panel is closed.
 *
 * Every listener is added here, at the top level, so that its event wakes
 * the worker; each worker start connects again if the user left AI access on.
 * With "Keep AI access on" that holds after a browser start, an update or a
 * reload; without it AI access is on only until the browser closes or the
 * extension is updated, reloaded or disabled, which clear
 * `chrome.storage.session`.
 *
 * It also writes the cases for the sync (DEC-021, DEC-025), to Downloads or
 * to the folder the user chose, after every change and at each start,
 * whoever made the change, and puts "!" on the icon while the sync needs the
 * user.
 */

import { BROWSER, FIREFOX, openPanel, PANEL } from "./lib/browser.ts";
import { isSafeId, pendingImage } from "./lib/case.ts";
import {
	cropImages,
	drawMarks,
	PENDING_QUALITY,
	screenshotToWebp,
} from "./lib/images.ts";
import { kvWhenOpen, openKv } from "./lib/kv.ts";
import {
	type Broadcast,
	type CaptureResult,
	type ContentRequest,
	isWorkerRequest,
	type NumberCheck,
	type SaveResult,
	type UndoResult,
	type WorkerRequest,
	type WorkerResponse,
} from "./lib/messages.ts";
import { fromPage, numberFree, saveCase, undoAdd } from "./lib/save.ts";
import { IdbStore, PENDING_MAX_AGE_MS } from "./lib/store.ts";
import {
	type ChosenFolder,
	downloadsTarget,
	folderTarget,
	kvSyncStore,
	PENDING_DOWNLOAD_KEY,
	type PendingDownload,
	SYNC_DATABASE,
	Sync,
	type SyncTarget,
} from "./lib/sync.ts";
import { injectOnClick } from "./lib/tabs.ts";
import { AddLedger } from "./lib/undo.ts";
import { badge } from "./worker/badge.ts";
import { ALARM, Connection } from "./worker/connection.ts";
import { chromeDownloads } from "./worker/downloads.ts";
import {
	isPanelSender,
	PANEL_PORT,
	type WorkerMessage,
} from "./worker/protocol.ts";

declare const SITEGLOSS_TEST_BUILD: boolean | undefined;
declare const SITEGLOSS_FIREFOX: boolean | undefined;

/**
 * A test build keeps the worker's errors on its global object, for the
 * end-to-end tests: Firefox's event page has a console no automation
 * reaches. (The define itself: other builds drop it.)
 */
if (typeof SITEGLOSS_TEST_BUILD !== "undefined" && SITEGLOSS_TEST_BUILD) {
	const errors: string[] = [];
	const text = (value: unknown) =>
		value instanceof Error ? value.message : String(value);
	globalThis.addEventListener("error", (e) =>
		errors.push(text((e as ErrorEvent).error ?? (e as ErrorEvent).message)),
	);
	globalThis.addEventListener("unhandledrejection", (e) =>
		errors.push(text((e as PromiseRejectionEvent).reason)),
	);
	const error = console.error.bind(console);
	console.error = (...args: unknown[]) => {
		errors.push(args.map(text).join(" "));
		error(...args);
	};
	Object.assign(globalThis, { siteglossErrors: errors });
}

const store = new IdbStore();
const added = new AddLedger(chrome.storage.session);

/**
 * The one writer of the sync (DEC-021, DEC-025). To Downloads it writes
 * whenever it likes, with the panel closed too. To a folder Chrome lets it
 * write only while an extension page (the side panel) is open and the user
 * allowed the folder; otherwise it says "paused" and writes what changed
 * meanwhile once the panel asks again. It runs at each start, so the icon's
 * "!" is there after a browser restart before the panel is opened.
 */
const syncKv = kvWhenOpen(() => openKv(SYNC_DATABASE));

/**
 * The end-to-end tests' folder is one of the private file system, which
 * never needs Chrome's OK: in a test build, `test:access` set to "prompt" in
 * the sync's database makes the worker see a folder that needs it again.
 */
function testFolder(chosen: ChosenFolder): SyncTarget {
	const target = folderTarget(chosen, store);
	return {
		...target,
		permission: async () =>
			(await syncKv.get("test:access")) !== "prompt" && target.permission(),
	};
}

const sync = new Sync({
	cases: store,
	store: kvSyncStore(syncKv),
	downloads: downloadsTarget(chromeDownloads(syncKv, store)),
	// Saves in a row are one download per case, not one each (a burst of
	// Chrome's download bubble).
	quietMs: 2000,
	// The define itself, so other builds drop the test's folder.
	...(typeof SITEGLOSS_TEST_BUILD !== "undefined" && SITEGLOSS_TEST_BUILD
		? { folder: testFolder }
		: {}),
	notify: (status) => {
		badge.sync(status);
		void broadcast({ type: "sync:changed" });
	},
});
void sync.request();

/**
 * The end of a download the sync waits for wakes the worker, should it have
 * stopped meanwhile: its run settles it. At the top level where Sitegloss has
 * the (optional) permission, and once it is given.
 */
let hearingDownloads = false;
function hearDownloads(): void {
	if (hearingDownloads || chrome.downloads?.onChanged === undefined) return;
	hearingDownloads = true;
	chrome.downloads.onChanged.addListener((delta) => {
		if (delta.state === undefined) return;
		void syncKv.get(PENDING_DOWNLOAD_KEY).then(
			(p) => {
				if ((p as PendingDownload | undefined)?.id === delta.id)
					void sync.request();
			},
			() => undefined,
		);
	});
}
hearDownloads();
// The downloads permission taken back, or given; in Firefox, the data
// collection consent taken back ends AI access (`consentChanged`).
chrome.permissions.onRemoved.addListener(() => {
	void sync.request();
	if (FIREFOX) withConnection((c) => void c.consentChanged());
});
chrome.permissions.onAdded.addListener(() => {
	hearDownloads();
	void sync.request();
});

// Screenshots of saves that never finished (the tab was closed or navigated
// while saving) would otherwise stay in storage unseen.
void store
	.sweepPending(Date.now() - PENDING_MAX_AGE_MS)
	.catch((error: unknown) => console.warn("Sitegloss: sweep", error));

chrome.action.onClicked.addListener((tab) => {
	if (tab.id === undefined) return;
	// `sidePanel.open` (Firefox: `sidebarAction.open`) needs the click's user
	// gesture: call it before any await. With the tab, not only the window:
	// over another extension's panel for this tab (Claude in Chrome's, say),
	// `open({ windowId })` resolves and shows nothing. The panel stays the
	// global one, for every tab without a panel of its own.
	void openPanel({ tabId: tab.id, windowId: tab.windowId }).catch(
		(error: unknown) => console.warn("Sitegloss: side panel", error),
	);
	void injectOnClick(tab).catch((error: unknown) =>
		console.warn("Sitegloss: cannot run on this tab", error),
	);
});

/** Chrome allows two `captureVisibleTab` calls a second. */
const CAPTURE_GAP_MS = 600;
let lastCapture = 0;
let captureQueue: Promise<unknown> = Promise.resolve();

/** Chrome can leave a capture unanswered, and the next ones wait in the queue. */
const CAPTURE_TIMEOUT_MS = 8000;

/** The tab must still be the one in front of its window, or the capture would show another. */
async function ensureInFront(tabId: number, windowId: number): Promise<void> {
	const tab = await chrome.tabs.get(tabId);
	if (!tab.active || tab.windowId !== windowId)
		throw new Error(
			"The tab is no longer in front of its window; switch back to it and try again.",
		);
}

/** Capture the tab, which must be the one in front of its window before and after. */
function capture(tabId: number, windowId: number): Promise<string> {
	const run = async () => {
		const wait = lastCapture + CAPTURE_GAP_MS - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		try {
			await ensureInFront(tabId, windowId);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const image = await Promise.race([
				chrome.tabs.captureVisibleTab(windowId, { format: "png" }),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() =>
							reject(new Error(`${BROWSER} did not deliver the screenshot.`)),
						CAPTURE_TIMEOUT_MS,
					);
				}),
			]).finally(() => clearTimeout(timer));
			await ensureInFront(tabId, windowId);
			return image;
		} finally {
			lastCapture = Date.now();
		}
	};
	const next = captureQueue.then(run, run);
	captureQueue = next.catch(() => undefined);
	return next;
}

async function broadcast(message: Broadcast): Promise<void> {
	if (message.type === "cases:changed") void sync.request();
	try {
		await chrome.runtime.sendMessage(message);
	} catch {
		// No side panel open.
	}
}

async function handle(
	request: WorkerRequest,
	sender: chrome.runtime.MessageSender,
): Promise<object> {
	switch (request.type) {
		case "capture": {
			const tab = sender.tab;
			if (tab?.id === undefined) throw new Error("not sent from a tab");
			if (!isSafeId(request.caseId) || !isSafeId(request.shotId))
				throw new Error("invalid id");
			const png = await capture(tab.id, tab.windowId);
			// Encoding takes a while; the page need not stay blurred for it.
			const taken: ContentRequest = { type: "page:captured" };
			void chrome.tabs.sendMessage(tab.id, taken).catch(() => undefined);
			const image = await screenshotToWebp(png, PENDING_QUALITY);
			await store.putImage(request.caseId, pendingImage(request.shotId), {
				...image,
				storedAt: Date.now(),
			});
			return {
				width: image.width,
				height: image.height,
			} satisfies CaptureResult;
		}
		case "case:save": {
			const from = request.request.imagesFrom;
			if (from !== undefined && !isSafeId(from)) throw new Error("invalid id");
			const saved = await saveCase(
				store,
				fromPage(request.request),
				cropImages,
				new Date(),
				drawMarks,
			);
			// Marks added one by one: the page that added them may undo them.
			const tabId = sender.tab?.id;
			if (
				request.request.keepPending &&
				tabId !== undefined &&
				sender.documentId !== undefined
			)
				for (const draft of request.request.annotations) {
					const a = saved.annotations.find((x) => x.number === draft.number);
					if (a !== undefined)
						await added.record({
							caseId: saved.id,
							annotationId: a.id,
							shot: a.shot,
							comment: a.comment,
							tabId,
							documentId: sender.documentId,
						});
				}
			await broadcast({ type: "cases:changed", caseId: saved.id });
			return {
				caseId: saved.id,
				title: saved.title,
				annotations: saved.annotations.length,
			} satisfies SaveResult;
		}
		case "case:number":
			if (!isSafeId(request.caseId)) throw new Error("invalid id");
			return (await numberFree(
				store,
				request.caseId,
				request.number,
			)) satisfies NumberCheck;
		case "case:undo-add": {
			if (!isSafeId(request.caseId) || !isSafeId(request.annotationId))
				throw new Error("invalid id");
			const mark = await added.find(
				request.caseId,
				request.annotationId,
				sender.tab?.id,
				sender.documentId,
			);
			if (mark === undefined)
				throw new Error(
					`this page did not add that mark; delete it in the ${PANEL} if it should go.`,
				);
			const result = await undoAdd(
				store,
				request.caseId,
				request.annotationId,
				mark,
			);
			await added.remove(mark);
			if (result.removed)
				await broadcast({ type: "cases:changed", caseId: request.caseId });
			return result satisfies UndoResult;
		}
		case "images:discard":
			if (!isSafeId(request.caseId)) throw new Error("invalid id");
			await store.deleteImages(
				request.caseId,
				request.shotIds.filter(isSafeId).map(pendingImage),
			);
			return {};
	}
}

/** A page of the extension itself (the side panel), not a content script. */
const fromExtensionPage = (sender: chrome.runtime.MessageSender) =>
	sender.url?.startsWith(chrome.runtime.getURL("")) === true;

chrome.runtime.onMessage.addListener(
	(request: WorkerRequest | Broadcast, sender, sendResponse) => {
		if (sender.id !== chrome.runtime.id) return false;
		// The side panel changed a case, or opened: the sync folder follows.
		if (
			(request?.type === "cases:changed" || request?.type === "sync:run") &&
			fromExtensionPage(sender)
		) {
			void sync.request(request.type === "sync:run" && request.force === true);
			return false;
		}
		if (!isWorkerRequest(request)) return false;
		handle(request, sender).then(
			(result) =>
				sendResponse({ ok: true, ...result } satisfies WorkerResponse),
			(error: unknown) =>
				sendResponse({
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				} satisfies WorkerResponse),
		);
		return true; // answers asynchronously
	},
);

// --- The AI app (DEC-015) ---------------------------------------------------

const ready = Connection.start({
	store,
	capture,
	changed: () => void sync.request(),
});
ready.catch((error: unknown) =>
	console.error("Sitegloss: AI connection", error),
);

const withConnection = (use: (connection: Connection) => void) =>
	void ready.then(use, () => {});

// Commands come only over the side panel's own port; content scripts reach
// `chrome.runtime` too, so its sender is checked, and any other port closed.
chrome.runtime.onConnect.addListener((port) => {
	if (
		port.name !== PANEL_PORT ||
		!isPanelSender(port.sender ?? {}, chrome.runtime.id, {
			origin: chrome.runtime.getURL(""),
			// Firefox's test build: automation cannot reach the sidebar, so
			// the panel's page runs in a tab there.
			// (The defines themselves: other builds drop it.)
			inTab:
				typeof SITEGLOSS_TEST_BUILD !== "undefined" &&
				SITEGLOSS_TEST_BUILD &&
				typeof SITEGLOSS_FIREFOX !== "undefined" &&
				SITEGLOSS_FIREFOX,
		})
	) {
		port.disconnect();
		return;
	}
	// Until the connection has started (a worker that just woke), keep what
	// the panel says: Chrome hands a message only to the listeners there are.
	const early: unknown[] = [];
	const keep = (message: unknown) => void early.push(message);
	let gone = false;
	port.onMessage.addListener(keep);
	port.onDisconnect.addListener(() => {
		gone = true;
	});
	void ready.then(
		(c) => {
			port.onMessage.removeListener(keep);
			if (!gone) c.addPanel(port, early);
		},
		(error: unknown) => {
			// Not silence: the panel says AI access is not available, and why.
			port.onMessage.removeListener(keep);
			const news: WorkerMessage = {
				type: "failed",
				problem: error instanceof Error ? error.message : String(error),
			};
			try {
				if (!gone) port.postMessage(news);
			} catch {
				// Closed meanwhile.
			}
		},
	);
});

// The worker starts for these too, which connects again if AI access was on.
chrome.runtime.onInstalled.addListener(() => withConnection((c) => c.keepUp()));
chrome.runtime.onStartup.addListener(() => withConnection((c) => c.keepUp()));
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === ALARM) withConnection((c) => c.keepUp());
});

/**
 * A notification's answer: its button Allow (0) or Always allow (1); a
 * click on its body, or the user closing it, is Don't allow. On the worker's
 * global object too, for the DevTools Protocol, which cannot click a
 * notification: the end-to-end tests answer through the same functions a
 * click calls.
 *
 * Firefox's notifications have no buttons and close by themselves, which
 * fires `onClosed` too, without `byUser`: there a notification only tells,
 * a click on it opens the sidebar of the window in front, where the
 * question is answered, and a close is no answer.
 */
function notificationButton(id: string, index: number): void {
	withConnection((c) => c.notificationButton(id, index));
}
function notificationDismissed(id: string): void {
	withConnection((c) => c.notificationDismissed(id));
}
if (FIREFOX)
	chrome.notifications.onClicked.addListener(() => {
		// At once, in the click's gesture, which an await would end.
		void openPanel({}).catch((error: unknown) =>
			console.warn("Sitegloss: sidebar", error),
		);
	});
else {
	chrome.notifications.onButtonClicked.addListener(notificationButton);
	chrome.notifications.onClicked.addListener(notificationDismissed);
	chrome.notifications.onClosed.addListener((id, byUser) => {
		if (byUser) notificationDismissed(id);
	});
}
Object.assign(globalThis, {
	siteglossNotificationButton: notificationButton,
	siteglossNotificationDismissed: notificationDismissed,
});

/**
 * Firefox stops an idle event page after 30 s, its WebSocket to the relay
 * with it; Chrome keeps a worker whose WebSocket carries messages. A call
 * to an extension API resets Firefox's idle timer, so while AI access is on
 * the event page makes one this often (as tab-mcp does).
 */
const FIREFOX_KEEPALIVE_MS = 20_000;
if (FIREFOX)
	setInterval(
		() =>
			withConnection((c) => {
				if (c.active) void chrome.runtime.getPlatformInfo().catch(() => {});
			}),
		FIREFOX_KEEPALIVE_MS,
	);
