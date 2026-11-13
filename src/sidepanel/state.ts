/**
 * The side panel's one state (DEC-011): everything it shows comes from here,
 * and only `update` changes it, which schedules one `render`. Asynchronous
 * work (reading the store, asking the tab) ends in an `update`; a newer piece
 * of work for the same thing makes an older one drop its result (`Latest`).
 */

import type { Case, ResolveChoice, StatusGroup } from "../lib/case.ts";
import type { CheckedExport } from "../lib/export.ts";
import type { AnnotationMatch, OverlayState } from "../lib/messages.ts";
import type { SyncStatus } from "../lib/sync.ts";
import type { Size } from "./size.ts";

export interface MarkEdit {
	annotationId: string;
	/** Resolve… or Change…, Edit comment, or Reopen… with its note (DEC-023). */
	mode: "resolve" | "comment" | "reopen";
	/** The status chosen (resolve). */
	kind: ResolveChoice;
	/** The note (resolve, reopen) or the comment (comment), as typed. */
	text: string;
}

export interface TabInfo {
	id: number;
	url: string;
	title: string;
	/** In CSS pixels, as a case's viewport; unknown where Chrome does not say. */
	size: Size | undefined;
	/** Still loading: an address not known yet says nothing about access. */
	loading?: boolean;
}

/** The case loaded onto a tab, and where its marks were found there. */
export interface Loaded {
	caseId: string;
	tabId: number;
	matches: Map<string, AnnotationMatch>;
	/** The marks not found are looked for again in a moment. */
	settling?: boolean;
}

/** Object URLs of one version of a case's images, by path. */
export interface CaseImages {
	caseId: string;
	version: string;
	urls: Map<string, string>;
}

/** Where the last export went, as Chrome told (DEC-020). */
export interface Exported {
	/** The case exported, or every case. */
	of: { caseId: string } | "all";
	downloadId: number;
	/** The file's absolute path. */
	path: string;
}

/** A file of several cases being imported, one after the other. */
export interface ImportBatch {
	/** The file's name. */
	name: string;
	/** The cases still to import, after the one asked about. */
	rest: CheckedExport[];
	total: number;
	stored: number;
	skipped: number;
}

/** An AI app's last tool call. */
export interface AiCall {
	/** The tool's title. */
	tool: string;
	app: string;
	/** `Date.now()` when it came. */
	at: number;
}

export interface PanelState {
	tab: TabInfo | undefined;
	overlay: OverlayState | undefined;
	/** Under "This page". */
	hint: string | undefined;
	cases: Case[];
	view: { kind: "home" } | { kind: "case"; id: string };
	/** The open case, once read. */
	current: Case | undefined;
	images: CaseImages | undefined;
	/** Under the open case's buttons. */
	caseHint: string | undefined;
	loaded: Loaded | undefined;
	/**
	 * An import that would replace a case that is here already; in a file of
	 * several cases, with the rest of them.
	 */
	importing:
		| { parsed: CheckedExport; existing: Case; batch?: ImportBatch }
		| undefined;
	/**
	 * Why the last import or "Export all cases" failed, until the next one or a
	 * dismiss.
	 */
	importError: string | undefined;
	/**
	 * What an import is at work on (a file's name, or the case asked about),
	 * while it reads or stores; no other import starts meanwhile.
	 */
	importWork: string | undefined;
	/** What importing a file of several cases came to, until the next import. */
	importDone: string | undefined;
	/** "Export all cases" is at work. */
	exportingAll: boolean;
	/** Where the last export went, when Chrome told; until the next one. */
	exported: Exported | undefined;
	/** Chrome's prompt for "downloads" is open for this export. */
	askingDownloads: Exported["of"] | undefined;
	/** Overmark may use chrome.downloads (DEC-020). */
	downloads: boolean;
	/** When "Delete" was clicked once. */
	deleteArmedAt: number | undefined;
	/** A mark of the open case being resolved or its comment edited. */
	markEdit: MarkEdit | undefined;
	/** The status chip pressed: the open case's list shows only those marks. */
	markFilter: { caseId: string; group: StatusGroup } | undefined;
	/** A mark's Delete, clicked once: the second click deletes. */
	markDeleteArmed: { annotationId: string; at: number } | undefined;
	/**
	 * A finding's Delete, clicked once: the second click deletes. A finding's
	 * id is unique on its mark only (a case from a file).
	 */
	findingDeleteArmed:
		| { annotationId: string; findingId: string; at: number }
		| undefined;
	/**
	 * Next to "Save summary": "Saved", or why not. The summary for the
	 * developer is stored as `verdict` (DEC-019).
	 */
	verdictStatus: string | undefined;
	/** Summaries typed and not saved yet, by case. */
	verdictDrafts: Map<string, string>;
	/** Overmark may run on every site ("Allow on all sites"). */
	allSites: boolean;
	/** Overmark may read file:// pages ("Allow access to file URLs"); unknown at first. */
	fileAccess: boolean | undefined;
	/** The sync to a folder (DEC-021). */
	sync: {
		/** The folder's name; `undefined`: not syncing. */
		folder: string | undefined;
		/** The worker's status for this folder, once it has one. */
		status: SyncStatus | undefined;
		/** What the panel itself could not do (the picker, Allow access). */
		problem: string | undefined;
	};
	ai: {
		status: string;
		connected: boolean;
		/** Connected, or on the way there: something "Stop AI access" can end. */
		active: boolean;
		/** "Keep AI access on". */
		keepOn: boolean;
		lastCall: AiCall | undefined;
	};
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
	importError: undefined,
	importWork: undefined,
	importDone: undefined,
	exportingAll: false,
	exported: undefined,
	askingDownloads: undefined,
	downloads: false,
	deleteArmedAt: undefined,
	markEdit: undefined,
	markFilter: undefined,
	markDeleteArmed: undefined,
	findingDeleteArmed: undefined,
	verdictStatus: undefined,
	verdictDrafts: new Map(),
	allSites: false,
	fileAccess: undefined,
	sync: { folder: undefined, status: undefined, problem: undefined },
	ai: {
		status: "Not connected",
		connected: false,
		active: false,
		keepOn: false,
		lastCall: undefined,
	},
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

export { Latest } from "../lib/latest.ts";
