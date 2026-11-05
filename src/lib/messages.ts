/**
 * Messages between the side panel, the service worker and the content script
 * (`chrome.runtime` and `chrome.tabs` messaging).
 */

import type { Case, ElementDetails, Rect, Viewport } from "./case.ts";
import type { MatchStatus } from "./match.ts";
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
	| { type: "overlay:state" }
	/** The side panel's "Blur form fields" changed (`OverlayState`). */
	| { type: "overlay:settings"; blurForms: boolean }
	/**
	 * Find the case's elements on this page and outline them (`LoadResult`, or
	 * `{ error }`, also while the page is busy).
	 */
	| { type: "case:load"; case: Case }
	/**
	 * Scroll to one annotation's element, or to another candidate
	 * (`AnnotationMatch`, or `{ error }` while the page is busy).
	 */
	| {
			type: "case:show";
			/** `null` comes back when another case (or none) is loaded. */
			caseId: string;
			annotationId: string;
			candidate?: number;
	  }
	/** Remove the outlines (`OverlayState`). */
	| { type: "case:clear" }
	/**
	 * Scroll to the element `selector` and mark it with `number` for a
	 * screenshot (`DescribedElement`); the overlay's own bars and the user's
	 * unsaved marks are hidden, form fields blurred as for a save. Refused
	 * while the page is busy.
	 */
	| {
			type: "element:mark";
			selector: string;
			number: number;
			blurForms: boolean;
	  }
	/** Remove that mark and the blur again (`Released`). */
	| { type: "element:unmark" }
	/** Blur form fields for a screenshot of the page as it is (`BlurResult`). */
	| { type: "page:blur"; blurForms: boolean }
	/** Undo `page:blur` (`Released`). */
	| { type: "page:unblur" }
	/** The screenshot a mark asked for is taken: the overlay can come back. */
	| { type: "page:captured" };

/** The answer to `page:blur`: refused while the page is busy. */
export type BlurResult = { ok: true } | { ok: false; error: string };

/**
 * The answer to `element:unmark` and `page:unblur`. `held: false`: the page no
 * longer held that activity (it timed out, or a navigation replaced the page),
 * so a screenshot taken for it may show the page without mark or blur.
 */
export interface Released {
	held: boolean;
}

/** The answer to `element:mark`. */
export type DescribedElement =
	| {
			ok: true;
			details: ElementDetails;
			/** The element's box in window coordinates. */
			rect: Rect;
			viewport: Viewport;
			scroll: { x: number; y: number };
			url: string;
			title: string;
	  }
	| { ok: false; error: string };

/** One of the best elements for an annotation on this page. */
export interface CandidateInfo {
	score: number;
	/** One line about the element (element.ts `summarize`). */
	summary: string;
	selector: string;
	/** Rendered with a size; `false` for hidden elements (e.g. another layout). */
	visible: boolean;
}

/** Where an annotation's element is on this page. */
export interface AnnotationMatch {
	annotationId: string;
	number: number;
	/** `no-element`: the annotation recorded no element. */
	status: MatchStatus | "no-element";
	/** The shown candidate's score (0 for lost). */
	score: number;
	/** Which candidate is outlined. */
	current: number;
	candidates: CandidateInfo[];
	/** Only part of the page was searched (very many elements, or out of time). */
	truncated?: boolean;
}

export interface LoadResult {
	caseId: string;
	url: string;
	matches: AnnotationMatch[];
}

/** The content script's answer to the `overlay:*` and `case:clear` requests. */
export interface OverlayState {
	visible: boolean;
	url: string;
	title: string;
	/** Marks drawn and not saved yet. */
	drafts: number;
	saving: boolean;
	target?: AnnotateTarget;
	/** The case whose elements are outlined. */
	loadedCase?: string;
}

/** What the content script asks the service worker. */
export type WorkerRequest =
	/** Capture the visible tab as the pending screenshot `shotId` (save.ts). */
	| { type: "capture"; caseId: string; shotId: string }
	| { type: "case:save"; request: SaveRequest }
	/** Remove the pending screenshots of a save that was given up. */
	| { type: "images:discard"; caseId: string; shotIds: string[] }
	/**
	 * From the side panel: a PNG data URL of `tabId`, which must be in front
	 * of `windowId` (`TabCapture`), through the worker's rate-limited queue.
	 */
	| { type: "capture:tab"; tabId: number; windowId: number };

export interface TabCapture {
	dataUrl: string;
}

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

/**
 * What extension pages hear without asking: the service worker saved a case,
 * or a content script's overlay was shown or hidden (also from its own
 * toolbar).
 */
export type Broadcast =
	| { type: "cases:changed"; caseId: string }
	| { type: "overlay:changed"; state: OverlayState };

/** The content script's file, as the build writes it. */
export const CONTENT_SCRIPT = "content.js";
