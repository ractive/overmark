/**
 * Messages between the side panel, the service worker and the content script
 * (`chrome.runtime` and `chrome.tabs` messaging).
 */

import type { Case, ElementDetails, Rect, Viewport } from "./case.ts";
import type { Inspection, Relation } from "./inspect.ts";
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
	 * Find the case's elements on this page and draw its marks (`LoadResult`, or
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
	/**
	 * The loaded case changed: draw its marks as they are now, keeping the
	 * candidates chosen (`LoadResult`, or `null` where another case is loaded).
	 */
	| { type: "case:update"; case: Case }
	/** Remove the marks (`OverlayState`): only that case's, where it is named. */
	| { type: "case:clear"; caseId?: string }
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
	/**
	 * Read the element of a loaded case's annotation (or, with `selector`, one
	 * relative to it) from the page: markup, styles, matching rules
	 * (`InspectResult`; `null` when another case, or none, is loaded, or the
	 * loaded copy lacks the annotation). Changes nothing on the page.
	 */
	| {
			type: "element:inspect";
			caseId: string;
			annotationId: string;
			/** The case's page: a mark without an element is looked for only there. */
			casePage: string;
			selector?: string;
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

/** The answer to `element:inspect`. */
export type InspectResult =
	| {
			ok: true;
			url: string;
			title: string;
			match: AnnotationMatch;
			/** How `selector` found the element; `mark` without one. */
			relation: Relation;
			/** A selector that finds the inspected element (empty in a shadow root). */
			selector: string;
			inspection: Inspection;
	  }
	| {
			ok: false;
			/**
			 * `lost` and `no-element`: the mark has no element on this page;
			 * `other-page`: a selector for a mark without an element, and the tab
			 * does not show the case's page.
			 */
			reason: "busy" | "lost" | "no-element" | "other-page" | "selector";
			error: string;
			match?: AnnotationMatch;
	  };

/** One of the best elements for an annotation on this page. */
export interface CandidateInfo {
	score: number;
	/** One line about the element (element.ts `summarize`). */
	summary: string;
	selector: string;
	/** Rendered with a size; `false` for hidden elements (e.g. another layout). */
	visible: boolean;
	/** Sure enough to be drawn as found (match.ts `isFound`). */
	found: boolean;
}

/** Where an annotation's element is on this page. */
export interface AnnotationMatch {
	annotationId: string;
	number: number;
	/** `no-element`: the annotation recorded no element. */
	status: MatchStatus | "no-element";
	/** The shown candidate's score (0 for lost). */
	score: number;
	/** Which candidate the mark is drawn on. */
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
	/** The case whose marks are drawn. */
	loadedCase?: string;
}

/** What the content script asks the service worker. */
export type WorkerRequest =
	/** Capture the visible tab as the pending screenshot `shotId` (save.ts). */
	| { type: "capture"; caseId: string; shotId: string }
	| { type: "case:save"; request: SaveRequest }
	/** Whether a mark can take `number` in the case (`NumberCheck`). */
	| { type: "case:number"; caseId: string; number: number }
	/** The toolbar's Undo: take out the mark it just added (`UndoResult`, save.ts `undoAdd`). */
	| { type: "case:undo-add"; caseId: string; annotationId: string }
	/** Remove the pending screenshots of a save that was given up. */
	| { type: "images:discard"; caseId: string; shotIds: string[] };

/**
 * The one-off messages the service worker answers. Nothing about the AI
 * connection is among them: that goes over the side panel's port (DEC-015).
 */
export const WORKER_REQUESTS: ReadonlySet<string> = new Set<
	WorkerRequest["type"]
>(["capture", "case:save", "case:number", "case:undo-add", "images:discard"]);

export function isWorkerRequest(message: unknown): message is WorkerRequest {
	return (
		typeof message === "object" &&
		message !== null &&
		WORKER_REQUESTS.has((message as { type?: unknown }).type as string)
	);
}

export type WorkerResponse<T = object> =
	| ({ ok: true } & T)
	| { ok: false; error: string };

export interface CaptureResult {
	/** Pixels of the stored screenshot. */
	width: number;
	height: number;
}

export interface NumberCheck {
	free: boolean;
	/** The case's next mark number. */
	next: number;
}

export interface UndoResult {
	/** `false`: the mark was gone already. */
	removed: boolean;
	next: number;
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
	| { type: "overlay:changed"; state: OverlayState }
	/** The worker's sync status changed (DEC-021). */
	| { type: "sync:changed" }
	/**
	 * From the side panel: bring the sync up to date now; `force` (Try again,
	 * a new choice) also after a failure only the user can end.
	 */
	| { type: "sync:run"; force?: boolean };

/** The content script's file, as the build writes it. */
export const CONTENT_SCRIPT = "content.js";
