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
	nextShot: number;
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
	/** Find the case's elements on this page and outline them (`LoadResult`). */
	| { type: "case:load"; case: Case }
	/** Scroll to one annotation's element, or to another candidate (`AnnotationMatch`). */
	| { type: "case:show"; annotationId: string; candidate?: number }
	/** Remove the outlines (`OverlayState`). */
	| { type: "case:clear" }
	/**
	 * Scroll to the element `selector` and mark it with `number` for a
	 * screenshot (`DescribedElement`); the overlay's own bars are hidden.
	 */
	| { type: "element:mark"; selector: string; number: number }
	/** Remove that mark again (`OverlayState`). */
	| { type: "element:unmark" };

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
}

export interface LoadResult {
	caseId: string;
	url: string;
	matches: AnnotationMatch[];
}

/** The content script's answer to the `overlay:*` requests. */
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
	| { type: "capture"; caseId: string; shotId: string }
	| { type: "case:save"; request: SaveRequest }
	| { type: "images:discard"; caseId: string };

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
