/**
 * The side panel's one state (DEC-011): everything it shows comes from here,
 * and only `update` changes it, which schedules one `render`. Asynchronous
 * work (reading the store, asking the tab) ends in an `update`; a newer piece
 * of work for the same thing makes an older one drop its result (`Latest`).
 */

import type { Case, ResolveChoice, StatusGroup } from "../lib/case.ts";
import type { CheckedExport } from "../lib/export.ts";
import type { AnnotationMatch, OverlayState } from "../lib/messages.ts";
import type { SyncStatus, SyncTargetKind } from "../lib/sync.ts";
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
	/** The page's address where they were found. */
	url: string;
	/** The marks not found are looked for again in a moment. */
	settling?: boolean;
}

/**
 * Under the open case's buttons: a sentence, or `found`, what the panel's
 * draw found there, which the case view words from `loaded` as it is now
 * (`foundLine`): a mark saved since counts as the next draw would count it.
 */
export type CaseHint = string | { kind: "found" };

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

export type AiProblem = "tab" | "updated" | "unavailable" | "connection";

export interface PanelState {
	tab: TabInfo | undefined;
	overlay: OverlayState | undefined;
	/** Under "This page". */
	hint: string | undefined;
	cases: Case[];
	view: { kind: "home" } | { kind: "case"; id: string };
	/**
	 * The Settings view (the AI app card, the options) is drawn instead of
	 * the view underneath, which stays as it is: an open case stays open.
	 */
	settings: boolean;
	/**
	 * "← All cases" at work (DEC-023): the toolbar adding to the case is
	 * finishing; or it could not, with marks not in the case yet, and the
	 * next click leaves without them.
	 */
	leaving:
		| { phase: "finishing" }
		| { phase: "blocked"; left: number }
		| undefined;
	/**
	 * Tabs the user took the open case's marks off ("Hide marks"): they are
	 * not drawn there again by themselves until "Show marks", or the case is
	 * opened again (DEC-022).
	 */
	hiddenOn: Set<number>;
	/** The panel is drawing the open case's marks on this tab now. */
	drawing: number | undefined;
	/** The open case, once read. */
	current: Case | undefined;
	images: CaseImages | undefined;
	/** Under the open case's buttons. */
	caseHint: CaseHint | undefined;
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
	/** Sitegloss may use chrome.downloads (DEC-020). */
	downloads: boolean;
	/** When "Delete" was clicked once. */
	deleteArmedAt: number | undefined;
	/** A mark of the open case being resolved or its comment edited. */
	markEdit: MarkEdit | undefined;
	/**
	 * The open case's title being changed (DEC-026): the text typed, and why
	 * the last save failed.
	 */
	renaming: { caseId: string; text: string; error?: string } | undefined;
	/**
	 * The open case's link being added or changed (DEC-028): the text typed,
	 * and why the last save failed or the text is no link.
	 */
	linking: { caseId: string; text: string; error?: string } | undefined;
	/**
	 * The status chip pressed: the open case's list shows only those marks,
	 * while there are any and no mark above `upTo` (the highest number when
	 * it was pressed) was added.
	 */
	markFilter: { caseId: string; group: StatusGroup; upTo: number } | undefined;
	/**
	 * The mark whose pin was clicked on the page (DEC-027): the list opens it
	 * and brings it into view, once per click (`at`).
	 */
	picked: { caseId: string; annotationId: string; at: number } | undefined;
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
	/** Sitegloss may run on every site ("Allow on all sites"). */
	allSites: boolean;
	/** Sitegloss may read file:// pages ("Allow access to file URLs"); unknown at first. */
	fileAccess: boolean | undefined;
	/** The sync to Downloads or a folder (DEC-021, DEC-025). */
	sync: {
		/** Where it writes; `undefined`: not syncing. */
		target: SyncTargetKind | undefined;
		/** `downloads`, or the folder's id. */
		targetId: string | undefined;
		/** The folder's name, when syncing to a folder. */
		folder: string | undefined;
		/** The worker's status for this target, once it has one. */
		status: SyncStatus | undefined;
		/** What the panel itself could not do (the picker, the database). */
		problem: string | undefined;
		/** Chrome's prompt for downloads is open. */
		asking: boolean;
		/** "Change…": the Off state's buttons, while the target keeps running. */
		changing: boolean;
		/** The user said no to Allow access or Allow downloads. */
		refused: boolean;
	};
	ai: {
		status: string;
		connected: boolean;
		/** How many AI apps are paired, while connected. */
		apps: number;
		/** Connected, or on the way there: something "Stop AI access" can end. */
		active: boolean;
		/**
		 * `status` says that something is wrong or what the user has to do
		 * (DEC-024): the pill says so in red and the sentence shows under the
		 * top bar. `tab`: this page is no side panel; `updated`: the panel
		 * belongs to the version before; `unavailable`: the worker's
		 * connection could not start; `connection`: it failed, was lost or was
		 * taken over.
		 */
		problem: AiProblem | undefined;
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
	settings: false,
	leaving: undefined,
	hiddenOn: new Set(),
	drawing: undefined,
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
	renaming: undefined,
	linking: undefined,
	markFilter: undefined,
	picked: undefined,
	markDeleteArmed: undefined,
	findingDeleteArmed: undefined,
	verdictStatus: undefined,
	verdictDrafts: new Map(),
	allSites: false,
	fileAccess: undefined,
	sync: {
		target: undefined,
		targetId: undefined,
		folder: undefined,
		status: undefined,
		problem: undefined,
		asking: false,
		changing: false,
		refused: false,
	},
	ai: {
		status: "Not connected",
		connected: false,
		apps: 0,
		active: false,
		problem: undefined,
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
