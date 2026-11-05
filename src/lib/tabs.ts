/**
 * Talking to the content script of a tab from an extension page or the
 * service worker, injecting it first when it is not there yet.
 */

import {
	CONTENT_SCRIPT,
	type ContentRequest,
	type OverlayState,
} from "./messages.ts";

/** Overmark may not run on this tab (no click on the icon, no host access). */
export class NoAccessError extends Error {
	override name = "NoAccessError";
}

/** Inject the content script; it ignores a second injection. */
export async function inject(tabId: number): Promise<void> {
	try {
		await chrome.scripting.executeScript({
			target: { tabId },
			files: [CONTENT_SCRIPT],
		});
	} catch (error) {
		throw new NoAccessError(
			error instanceof Error ? error.message : String(error),
		);
	}
}

/** Send a request to the tab's content script, injecting it if needed. */
export async function sendToTab<T = OverlayState>(
	tabId: number,
	request: ContentRequest,
): Promise<T> {
	try {
		return (await chrome.tabs.sendMessage(tabId, request)) as T;
	} catch {
		// No content script yet (or the page navigated): inject and try once more.
		await inject(tabId);
		return (await chrome.tabs.sendMessage(tabId, request)) as T;
	}
}
