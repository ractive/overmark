/**
 * Messages between the side panel, the service worker and the content script
 * (`chrome.runtime` and `chrome.tabs` messaging).
 */

import type { SaveRequest } from "./save.ts";

/** Annotations go into this existing case instead of a new one. */
export interface AnnotateTarget {
	caseId: string;
	title: string;
	nextAnnotation: number;
}

/** What the side panel (or the service worker) asks the content script. */
export type ContentRequest =
	| {
			type: "overlay:show";
			/** Add to this case; a new case when absent. */
			target?: AnnotateTarget;
			/** Blur form fields while capturing (password fields always). */
			blurForms?: boolean;
	  }
	| { type: "overlay:hide" }
	| { type: "overlay:state" };

/** The content script's answer to every `ContentRequest`. */
export interface OverlayState {
	visible: boolean;
	url: string;
	title: string;
	/** Marks drawn and not saved yet. */
	drafts: number;
	saving: boolean;
	target?: AnnotateTarget;
}

/** What the content script asks the service worker. */
export type WorkerRequest =
	/** Capture the visible tab as the pending screenshot `shotId` (save.ts). */
	| { type: "capture"; caseId: string; shotId: string }
	| { type: "case:save"; request: SaveRequest }
	/** Remove the pending screenshots of a save that was given up. */
	| { type: "images:discard"; caseId: string; shotIds: string[] };

export type WorkerResponse<T = object> =
	| ({ ok: true } & T)
	| { ok: false; error: string };

export interface CaptureResult {
	/** Pixels of the stored screenshot. */
	width: number;
	height: number;
}

export interface SaveResult {
	caseId: string;
	title: string;
	annotations: number;
}

/** What the service worker tells extension pages. */
export type Broadcast = { type: "cases:changed"; caseId: string };

/** The content script's file, as the build writes it. */
export const CONTENT_SCRIPT = "content.js";
