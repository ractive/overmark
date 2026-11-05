/**
 * The service worker: a click on the icon (or Alt+Shift+O) opens the side
 * panel and injects the content script into that tab (the click grants
 * `activeTab`). It also captures screenshots and writes cases for the content
 * script, which runs in the page's origin and cannot reach the extension's
 * storage.
 */

import { isSafeId, pendingImage } from "./lib/case.ts";
import {
	cropImages,
	drawMarks,
	PENDING_QUALITY,
	screenshotToWebp,
} from "./lib/images.ts";
import type {
	Broadcast,
	CaptureResult,
	ContentRequest,
	SaveResult,
	TabCapture,
	WorkerRequest,
	WorkerResponse,
} from "./lib/messages.ts";
import { saveCase } from "./lib/save.ts";
import { IdbStore, PENDING_MAX_AGE_MS } from "./lib/store.ts";
import { inject } from "./lib/tabs.ts";

const store = new IdbStore();

// Screenshots of saves that never finished (the tab was closed or navigated
// while saving) would otherwise stay in storage unseen.
void store
	.sweepPending(Date.now() - PENDING_MAX_AGE_MS)
	.catch((error: unknown) => console.warn("Overmark: sweep", error));

chrome.action.onClicked.addListener((tab) => {
	if (tab.id === undefined) return;
	// `sidePanel.open` needs the click's user gesture: call it before any await.
	void chrome.sidePanel
		.open({ windowId: tab.windowId })
		.catch((error: unknown) => console.warn("Overmark: side panel", error));
	void inject(tab.id).catch((error: unknown) =>
		console.warn("Overmark: cannot run on this tab", error),
	);
});

/** Chrome allows two `captureVisibleTab` calls a second. */
const CAPTURE_GAP_MS = 600;
let lastCapture = 0;
let captureQueue: Promise<unknown> = Promise.resolve();

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
			const image = await chrome.tabs.captureVisibleTab(windowId, {
				format: "png",
			});
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
			const saved = await saveCase(
				store,
				request.request,
				cropImages,
				new Date(),
				drawMarks,
			);
			await broadcast({ type: "cases:changed", caseId: saved.id });
			return {
				caseId: saved.id,
				title: saved.title,
				annotations: saved.annotations.length,
			} satisfies SaveResult;
		}
		case "capture:tab": {
			// From the side panel (an AI app's screenshot), not from a content script.
			if (!sender.url?.startsWith(chrome.runtime.getURL("")))
				throw new Error("only for Overmark's own pages");
			return {
				dataUrl: await capture(request.tabId, request.windowId),
			} satisfies TabCapture;
		}
		case "images:discard":
			await store.deleteImages(
				request.caseId,
				request.shotIds.filter(isSafeId).map(pendingImage),
			);
			return {};
	}
}

chrome.runtime.onMessage.addListener(
	(request: WorkerRequest, sender, sendResponse) => {
		if (sender.id !== chrome.runtime.id) return false;
		if (
			request?.type !== "capture" &&
			request?.type !== "case:save" &&
			request?.type !== "images:discard" &&
			request?.type !== "capture:tab"
		)
			return false;
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
