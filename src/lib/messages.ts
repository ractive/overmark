/**
 * Messages between the side panel, the service worker and the content script
 * (`chrome.runtime` and `chrome.tabs` messaging).
 */

/** What the side panel (or the service worker) asks the content script. */
export type ContentRequest =
	| { type: "overlay:show" }
	| { type: "overlay:hide" }
	| { type: "overlay:state" };

/** The content script's answer to every `ContentRequest`. */
export interface OverlayState {
	visible: boolean;
	url: string;
	title: string;
}

/** The content script's file, as the build writes it. */
export const CONTENT_SCRIPT = "content.js";
