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
	NumberCheck,
	SaveResult,
	TabCapture,
	UndoResult,
	WorkerRequest,
	WorkerResponse,
} from "./lib/messages.ts";
import { numberFree, saveCase, undoAdd } from "./lib/save.ts";
import { IdbStore, PENDING_MAX_AGE_MS } from "./lib/store.ts";
import { inject } from "./lib/tabs.ts";
import { AddLedger } from "./lib/undo.ts";

const store = new IdbStore();
const added = new AddLedger(chrome.storage.session);

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
						() => reject(new Error("Chrome did not deliver the screenshot.")),
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
				request.request,
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
					"this page did not add that mark; delete it in the side panel if it should go.",
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
		case "capture:tab": {
			// From the side panel (an AI app's screenshot), not from a content script.
			if (!sender.url?.startsWith(chrome.runtime.getURL("")))
				throw new Error("only for Overmark's own pages");
			return {
				dataUrl: await capture(request.tabId, request.windowId),
			} satisfies TabCapture;
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

chrome.runtime.onMessage.addListener(
	(request: WorkerRequest, sender, sendResponse) => {
		if (sender.id !== chrome.runtime.id) return false;
		if (
			request?.type !== "capture" &&
			request?.type !== "case:save" &&
			request?.type !== "case:number" &&
			request?.type !== "case:undo-add" &&
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
