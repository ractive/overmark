/**
 * The side panel's one state (DEC-011): everything it shows comes from here,
 * and only `update` changes it, which schedules one `render`. Asynchronous
 * work (reading the store, asking the tab) ends in an `update`; a newer piece
 * of work for the same thing makes an older one drop its result (`Latest`).
 */

import type { Case } from "../lib/case.ts";
import type { ParsedExport } from "../lib/export.ts";
import type { AnnotationMatch, OverlayState } from "../lib/messages.ts";

export interface TabInfo {
	id: number;
	url: string;
	title: string;
}

/** The case loaded onto a tab, and where its marks were found there. */
export interface Loaded {
	caseId: string;
	tabId: number;
	matches: Map<string, AnnotationMatch>;
}

/** Object URLs of one version of a case's images, by path. */
export interface CaseImages {
	caseId: string;
	version: string;
	urls: Map<string, string>;
}

export interface PanelState {
	tab: TabInfo | undefined;
	overlay: OverlayState | undefined;
	/** Under "This tab". */
	hint: string | undefined;
	cases: Case[];
	view: { kind: "home" } | { kind: "case"; id: string };
	/** The open case, once read. */
	current: Case | undefined;
	images: CaseImages | undefined;
	/** Under the open case's buttons. */
	caseHint: string | undefined;
	loaded: Loaded | undefined;
	/** An import that would replace a case that is here already. */
	importing: { parsed: ParsedExport; existing: Case } | undefined;
	/** "Delete" was clicked once. */
	deleteArmed: boolean;
	/** Next to "Save verdict": "Saved", or why not. */
	verdictStatus: string | undefined;
	ai: { status: string; connected: boolean };
}

export const initialState = (): PanelState => ({
	tab: undefined,
	overlay: undefined,
	hint: undefined,
	cases: [],
	view: { kind: "home" },
	current: undefined,
	images: undefined,
	caseHint: undefined,
	loaded: undefined,
	importing: undefined,
	deleteArmed: false,
	verdictStatus: undefined,
	ai: { status: "Not connected", connected: false },
});

/** The state and its one way to change. */
export class Panel {
	readonly state: PanelState = initialState();
	readonly #render: (state: PanelState) => void;
	#scheduled = false;

	constructor(render: (state: PanelState) => void) {
		this.#render = render;
	}

	/** Change the state; the panel renders once, after the current task. */
	update(change: (state: PanelState) => void): void {
		change(this.state);
		if (this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			this.#render(this.state);
		});
	}
}

/** Only the newest of overlapping pieces of work may write its result. */
export class Latest {
	#n = 0;

	/** Start a piece of work; `current()` says whether it is still the newest. */
	start(): { current: () => boolean } {
		const mine = ++this.#n;
		return { current: () => mine === this.#n };
	}

	/** Make every running piece of work stale. */
	cancel(): void {
		this.#n++;
	}
}
