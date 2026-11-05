/**
 * Messages between the side panel, the service worker and the content script
 * (`chrome.runtime` and `chrome.tabs` messaging).
 */

import type { Case } from "./case.ts";
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
	/** Find the case's elements on this page and outline them (`LoadResult`). */
	| { type: "case:load"; case: Case }
	/** Scroll to one annotation's element, or to another candidate (`AnnotationMatch`). */
	| { type: "case:show"; annotationId: string; candidate?: number }
	/** Remove the outlines (`OverlayState`). */
	| { type: "case:clear" };

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
