/**
 * Drawing the side panel from its state (DEC-011). `render` is the only code
 * that touches the panel's DOM. The open case's summary and buttons stay the
 * same elements while it is open, so typing, focus and clicks survive every
 * render; the other parts are redrawn when what they show changed.
 */

import {
	type Annotation,
	appLabel,
	type Case,
	isPageOf,
	MAX_COMMENT,
	MAX_VERDICT,
	RESOLUTION_KINDS,
	RESOLUTION_LABEL,
	type ResolutionKind,
	samePath,
} from "../lib/case.ts";
import { summarize } from "../lib/element.ts";
import type { AnnotationMatch, CandidateInfo } from "../lib/messages.ts";
import { byId, formatDate, h, isWebPage, shortUrl } from "./dom.ts";
import { noneFound } from "./follow.ts";
import { type Size, sameSize } from "./size.ts";
import type { AiCall, Exported, PanelState } from "./state.ts";

/** What the user can do; main.ts carries it out and updates the state. */
export interface Actions {
	toggleAnnotate(): void;
	openCase(id: string): void;
	/** "← All cases": end the toolbar adding to the case, then close it (DEC-023). */
	closeCase(): void;
	/** "← Back" from Settings, to the view underneath. */
	closeSettings(): void;
	loadOntoTab(c: Case): void;
	hideFromTab(c: Case): void;
	/** Open a mark's form: settle it, or edit its comment. */
	editMark(c: Case, a: Annotation, mode: "resolve" | "comment"): void;
	typeMark(change: { kind?: ResolutionKind; text?: string }): void;
	cancelMarkEdit(): void;
	resolveMark(c: Case, a: Annotation, kind: ResolutionKind, note: string): void;
	reopenMark(c: Case, a: Annotation): void;
	saveComment(c: Case, a: Annotation, text: string): void;
	deleteMark(c: Case, a: Annotation): void;
	/** An AI app's finding on a mark: the first click asks, the second deletes. */
	deleteFinding(c: Case, a: Annotation, findingId: string): void;
	openPage(c: Case): void;
	/** Chrome's prompt for "Allow on all sites"; call it in the click. */
	allowAllSites(): void;
	/** Overmark's page in chrome://extensions ("Allow access to file URLs"). */
	openDetails(): void;
	matchSize(c: Case): void;
	addMarks(c: Case): void;
	/** "Done adding": the toolbar adding to the case finishes, as its Done. */
	doneAdding(c: Case): void;
	exportCase(c: Case): void;
	/** Copy an exported file's path; whether it worked. */
	copyPath(path: string): Promise<boolean>;
	/** Show an exported file in the system's file manager. */
	showFile(e: Exported): void;
	deleteCase(c: Case): void;
	typeVerdict(caseId: string, text: string): void;
	saveVerdict(caseId: string, text: string): void;
	showMatch(caseId: string, a: Annotation, candidate: number): void;
	importReplace(): void;
	importCopy(): void;
	importCancel(): void;
	/** "Sync to a folder…" and "Change folder…" (Chrome's picker, in the click). */
	syncChoose(): void;
	syncStop(): void;
	/** "Allow access": Chrome's prompt for the folder, in the click. */
	syncAllow(): void;
	syncRetry(): void;
}

const bar = byId<HTMLElement>("bar");
const back = byId<HTMLButtonElement>("back");
const home = byId<HTMLElement>("home");
const caseView = byId<HTMLElement>("case-view");
const settingsView = byId<HTMLElement>("settings");
const pageText = byId<HTMLParagraphElement>("page");
const hint = byId<HTMLParagraphElement>("hint");
const annotate = byId<HTMLButtonElement>("annotate");
const annotateHint = byId<HTMLParagraphElement>("annotate-hint");
/** Its title in index.html, for when Overmark may run on the tab. */
const annotateTitle = annotate.title;
const casesList = byId<HTMLDivElement>("cases");
const allSites = byId<HTMLInputElement>("all-sites");
const aiStatus = byId<HTMLSpanElement>("ai-status");
const aiButton = byId<HTMLButtonElement>("ai-button");
const aiAction = byId<HTMLSpanElement>("ai-action");
const aiCall = byId<HTMLParagraphElement>("ai-call");
const stopAi = byId<HTMLButtonElement>("stop-ai");
const keepOn = byId<HTMLInputElement>("keep-on");
const importError = byId<HTMLDivElement>("import-error");
const importDone = byId<HTMLParagraphElement>("import-done");
const exportAll = byId<HTMLButtonElement>("export-all");
const importButton = byId<HTMLButtonElement>("import");
/** Their titles in index.html, for when no import is at work. */
const importTitle = importButton.title;
const exportAllTitle = exportAll.title;
const exportAllSaved = byId<HTMLDivElement>("export-all-saved");
const importErrorText = byId<HTMLParagraphElement>("import-error-text");
const syncBox = byId<HTMLDivElement>("sync");
const importPrompt = h("div", {
	class: "hint",
	id: "import-prompt",
	hidden: true,
});
importButton.parentElement?.after(importPrompt);

/** The titles of Import a case… and Export all cases while an import is at work. */
export const IMPORT_BUSY =
	"An import is at work: wait for it, or answer its question below, before choosing another file.";
export const EXPORT_ALL_BUSY =
	"An import is at work: wait for it, or answer its question below, before exporting all cases.";

/** Why Overmark does not work on a tab yet, and what to do about it. */
export const NO_ACCESS =
	"Overmark may not run on this tab yet. Click the Overmark icon in the toolbar (or press Alt+Shift+O) while this tab is in front.";

/** A tab Overmark is not let onto even with "Allow on all sites". */
export const CANNOT_RUN =
	"Overmark cannot run on this tab: Chrome keeps its own pages and the Chrome Web Store off limits to extensions.";

/** The same, where Overmark may not read files either: that is the toggle for them. */
export const CANNOT_RUN_FILES =
	"Overmark cannot run on this tab. A page of Chrome's own or the Chrome Web Store is off limits to extensions. A file on your computer needs “Allow access to file URLs” in Overmark's details.";

/** The title of a button that needs the page, while Overmark may not run there. */
export const NEEDS_ACCESS =
	"Overmark may not run on this tab yet: see the notice above.";

/**
 * Whether Overmark may run on the tab in front, as far as the panel knows:
 * Chrome tells the address only of a tab it may run on (a tab still loading
 * has none yet). `never`: not even with "Allow on all sites".
 */
export function access(state: PanelState): "yes" | "ask" | "never" {
	const tab = state.tab;
	if (tab === undefined || tab.url !== "" || tab.loading) return "yes";
	return state.allSites ? "never" : "ask";
}

/** "None of this case's marks were found on this page…" (DEC-022). */
export function noneFoundText(c: Case, url: string | undefined): string {
	const here = "None of this case's marks were found on this page.";
	return url !== undefined && url !== "" && isPageOf(c, url)
		? here
		: `${here} It is probably for another page: ${shortUrl(c.page.url)}.`;
}

const SVG = "http://www.w3.org/2000/svg";

/** A warning sign in the text's colour, for the panel's light and dark styles alike. */
function warningIcon(): SVGSVGElement {
	const svg = document.createElementNS(SVG, "svg");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("width", "16");
	svg.setAttribute("height", "16");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("class", "notice-icon");
	for (const [tag, attrs] of [
		[
			"path",
			{
				d: "M8 1.5 15 14H1z",
				fill: "none",
				stroke: "currentColor",
				"stroke-width": "1.5",
				"stroke-linejoin": "round",
			},
		],
		[
			"path",
			{
				d: "M8 6v3.5",
				stroke: "currentColor",
				"stroke-width": "1.6",
				"stroke-linecap": "round",
			},
		],
		["circle", { cx: "8", cy: "11.75", r: "0.95", fill: "currentColor" }],
	] as const) {
		const part = document.createElementNS(SVG, tag);
		for (const [key, value] of Object.entries(attrs))
			part.setAttribute(key, value);
		svg.append(part);
	}
	return svg;
}

/** A notice with the warning sign: its text, and a button where there is one. */
interface Notice {
	el: HTMLElement;
	text: HTMLParagraphElement;
	button: HTMLButtonElement;
}

function notice(id: string, button: HTMLButtonElement): Notice {
	const text = h("p", {});
	const el = h(
		"div",
		{ class: "notice", id, role: "status", hidden: true },
		warningIcon(),
		h("div", { class: "notice-body" }, text, button),
	);
	return { el, text, button };
}

/** The notice when Overmark may not run on the tab in front, with "Allow on all sites". */
function accessNotice(id: string, actions: () => Actions): Notice {
	return notice(
		id,
		h("button", {
			type: "button",
			onclick: (e) => {
				const button = e.currentTarget as HTMLButtonElement;
				if (button.dataset["action"] === "file-access") actions().openDetails();
				else actions().allowAllSites();
			},
		}),
	);
}

const ALLOW_ALL_SITES_TITLE =
	"Let Overmark run on every site, without a click on its icon on each tab. Chrome asks first; you can take it back in the options, in Settings (the AI pill at the top).";
const DETAILS_TITLE =
	"Open Overmark's page in chrome://extensions, where “Allow access to file URLs” is";

/**
 * Overmark may not run on the tab: "Allow on all sites" helps, or, where it
 * may run on all sites already, Chrome keeps the tab off limits; for a file
 * that is the "Allow access to file URLs" toggle, which the panel cannot
 * tell apart (Chrome hides the address), so it says both.
 */
function renderAccess(n: Notice, state: PanelState): void {
	const now = access(state);
	n.el.hidden = now === "yes";
	const files = now === "never" && state.fileAccess === false;
	n.text.textContent =
		now !== "never" ? NO_ACCESS : files ? CANNOT_RUN_FILES : CANNOT_RUN;
	n.button.hidden = now === "never" && !files;
	n.button.dataset["action"] = files ? "file-access" : "allow-all-sites";
	n.button.textContent = files
		? "Open Overmark's details"
		: "Allow on all sites";
	n.button.title = files ? DETAILS_TITLE : ALLOW_ALL_SITES_TITLE;
}

/** The actions of the last render, for the home view's notice made once. */
let lastActions: Actions | undefined;
const homeAccess = accessNotice("access-notice", () => lastActions as Actions);
annotate.before(homeAccess.el);

const sizeOf = (s: Size) => `${s.width}×${s.height}`;

const percent = (score: number) => `${Math.round(score * 100)}%`;

function setHint(el: HTMLElement, text: string | undefined): void {
	el.hidden = text === undefined;
	el.textContent = text ?? "";
}

/** Under Export while Chrome's prompt is open: what the answer does. */
export const ASKING_DOWNLOADS =
	"Chrome asks whether Overmark may manage your downloads. With a yes, Overmark shows here where the file went; with a no, it saves the file as before.";

/**
 * Under an Export button: where the file went, with Copy and Show in folder
 * (DEC-020); or, while Chrome asks for downloads, what that is for. `el`
 * keeps what it shows, so Copy's "Copied" survives a render.
 */
function renderSaved(
	el: HTMLElement,
	exported: Exported | undefined,
	asking: boolean,
	actions: Actions,
): void {
	const key = asking ? "asking" : exported ? String(exported.downloadId) : "";
	if (el.dataset["key"] === key) return;
	el.dataset["key"] = key;
	el.hidden = key === "";
	el.className = key === "" ? "" : "hint saved";
	if (asking) {
		el.replaceChildren(h("p", {}, ASKING_DOWNLOADS));
		return;
	}
	if (exported === undefined) {
		el.replaceChildren();
		return;
	}
	const copy: HTMLButtonElement = h(
		"button",
		{
			type: "button",
			"data-action": "copy-path",
			title: "Copy the file's full path",
			onclick: () =>
				void actions.copyPath(exported.path).then((ok) => {
					if (!ok) return;
					copy.textContent = "Copied";
					setTimeout(() => {
						copy.textContent = "Copy";
					}, 1500);
				}),
		},
		"Copy",
	);
	el.replaceChildren(
		h("p", {}, "Saved as"),
		h("code", { class: "path" }, exported.path),
		h(
			"div",
			{ class: "row" },
			copy,
			h(
				"button",
				{
					type: "button",
					"data-action": "show-file",
					title: "Open the folder with the file in your system's file manager",
					onclick: () => actions.showFile(exported),
				},
				"Show in folder",
			),
		),
	);
}

// --- the sync folder (DEC-021) --------------------------------------------------

/** The tooltips of the sync's buttons. */
export const SYNC_CHOOSE_TITLE =
	"Choose a folder, in iCloud Drive or Dropbox say: Overmark writes each case there as its own .zip file, as Export does, and again whenever it changes. A deleted case keeps its file. Nothing is read from the folder.";
const SYNC_CHANGE_TITLE =
	"Choose another folder: the cases are written there from now on; the files in this one stay";
const SYNC_STOP_TITLE =
	"Stop writing the cases to this folder; the files there stay";
const SYNC_ALLOW_TITLE =
	"Chrome asks whether Overmark may edit files in the folder again; then the cases changed meanwhile are written";
const SYNC_RETRY_TITLE = "Write the cases that are not in the folder yet";

/** Under "Sync paused": why, and what Allow access does. */
export const syncPausedText = (folder: string) =>
	`Chrome asks again for “${folder}” after the side panel was closed or the browser restarted. The cases changed meanwhile are written once you allow it. If Chrome offers to allow it on every visit, it stops asking.`;

function syncButton(
	action: string,
	label: string,
	title: string,
	onclick: () => void,
	primary = false,
): HTMLButtonElement {
	return h(
		"button",
		{
			type: "button",
			"data-action": action,
			title,
			onclick,
			...(primary ? { class: "primary" } : {}),
		},
		label,
	);
}

/** "Last synced …", or what the worker is at. */
function syncLine(status: PanelState["sync"]["status"]): string {
	if (status?.state === "syncing")
		return status.left === 1
			? "Writing 1 case…"
			: `Writing ${status.left ?? 0} cases…`;
	if (status?.lastSyncedAt !== undefined)
		return `Last synced ${formatDate(status.lastSyncedAt)}`;
	return status === undefined ? "Starting…" : "Not synced yet";
}

/**
 * "Sync to a folder…", or the folder with its state and Change folder… and
 * Stop syncing. Drawn again only when what it shows changed.
 */
function renderSync({ sync }: PanelState, actions: Actions): void {
	const status = sync.status;
	const key = JSON.stringify([
		sync.folder,
		status?.state,
		status?.lastSyncedAt,
		status?.left,
		status?.problem,
		sync.problem,
	]);
	if (syncBox.dataset["key"] === key) return;
	syncBox.dataset["key"] = key;
	const problem =
		sync.problem === undefined
			? []
			: [h("p", { class: "hint", role: "alert" }, sync.problem)];
	if (sync.folder === undefined) {
		syncBox.dataset["sync"] = "off";
		syncBox.replaceChildren(
			h(
				"div",
				{ class: "row" },
				syncButton("sync-choose", "Sync to a folder…", SYNC_CHOOSE_TITLE, () =>
					actions.syncChoose(),
				),
			),
			...problem,
		);
		return;
	}
	const state = status?.state ?? "syncing";
	syncBox.dataset["sync"] = state;
	const parts: HTMLElement[] = [];
	if (state === "paused") {
		parts.push(
			h("p", { class: "sync-state" }, "Sync paused: allow access again"),
			h("p", { class: "meta" }, syncPausedText(sync.folder)),
		);
	} else {
		parts.push(
			h(
				"p",
				{ class: "sync-state" },
				"Syncing to ",
				h("strong", { class: "folder" }, sync.folder),
			),
		);
	}
	parts.push(h("p", { class: "meta sync-line" }, syncLine(status)));
	if (state === "failed" && status?.problem !== undefined)
		parts.push(h("p", { class: "hint", role: "alert" }, status.problem));
	parts.push(...problem);
	parts.push(
		h(
			"div",
			{ class: "row" },
			...(state === "paused"
				? [
						syncButton(
							"sync-allow",
							"Allow access",
							SYNC_ALLOW_TITLE,
							() => actions.syncAllow(),
							true,
						),
					]
				: []),
			...(state === "failed"
				? [
						syncButton("sync-retry", "Try again", SYNC_RETRY_TITLE, () =>
							actions.syncRetry(),
						),
					]
				: []),
			syncButton("sync-change", "Change folder…", SYNC_CHANGE_TITLE, () =>
				actions.syncChoose(),
			),
			syncButton("sync-stop", "Stop syncing", SYNC_STOP_TITLE, () =>
				actions.syncStop(),
			),
		),
	);
	syncBox.replaceChildren(...parts);
}

// --- home ----------------------------------------------------------------------

/** A case: opening it draws its marks on the tab in front (DEC-022). */
function caseItem(c: Case, actions: Actions): HTMLLIElement {
	const count = c.annotations.length;
	// The bar beside it is a picture; the words say the same.
	const counts = countsText(c);
	return h(
		"li",
		{},
		h(
			"button",
			{
				type: "button",
				"data-case": c.id,
				title: `Open “${c.title}” and show its marks on the page in this tab`,
				onclick: () => actions.openCase(c.id),
			},
			h("span", { class: "title" }, c.title),
			h("span", { class: "meta" }, shortUrl(c.page.url)),
			h(
				"span",
				{ class: "meta" },
				`${count} mark${count === 1 ? "" : "s"}${counts ? ` (${counts})` : ""}, ${formatDate(c.updatedAt)}`,
			),
			progress(c),
			c.verdict
				? h(
						"span",
						{ class: "meta" },
						`Summary for the developer: ${c.verdict.slice(0, 80)}`,
					)
				: null,
		),
	);
}

/** What the case list and the import prompt show now. */
let casesKey: string | undefined;
let importKey: string | undefined;

function renderCases(state: PanelState, actions: Actions): void {
	const url = state.tab?.url ?? "";
	const key = JSON.stringify([
		url,
		state.cases.map((c) => [c.id, c.updatedAt, c.importedAt]),
	]);
	if (key === casesKey) return;
	casesKey = key;
	if (state.cases.length === 0) {
		casesList.replaceChildren(
			h(
				"p",
				{ class: "empty" },
				"No cases yet. Annotate a page and save it as a case, or import a case someone sent you.",
			),
		);
		return;
	}
	const here = state.cases.filter((c) => url && samePath(c.page.url, url));
	const other = state.cases.filter((c) => !here.includes(c));
	casesList.replaceChildren(
		...(here.length > 0
			? [
					h("p", { class: "group-title" }, "For this page"),
					h(
						"ul",
						{ class: "cases", "data-group": "here" },
						...here.map((c) => caseItem(c, actions)),
					),
				]
			: []),
		...(other.length > 0
			? [
					here.length > 0
						? h("p", { class: "group-title" }, "Other pages")
						: "",
					h(
						"ul",
						{ class: "cases", "data-group": "other" },
						...other.map((c) => caseItem(c, actions)),
					),
				]
			: []),
	);
}

function renderImportPrompt(state: PanelState, actions: Actions): void {
	const importing = state.importing;
	const batch = importing?.batch;
	const key = JSON.stringify([
		importing?.existing.id,
		importing?.existing.updatedAt,
		importing?.parsed.case.updatedAt,
		batch ? [batch.name, batch.rest.length] : null,
	]);
	if (key === importKey) return;
	importKey = key;
	if (importing === undefined) {
		importPrompt.hidden = true;
		importPrompt.replaceChildren();
		return;
	}
	importPrompt.replaceChildren(
		h(
			"p",
			{},
			`“${importing.existing.title}” is here already (changed ${formatDate(importing.existing.updatedAt)}); the file's copy was changed ${formatDate(importing.parsed.case.updatedAt)}.`,
		),
		...(batch
			? [
					h(
						"p",
						{ class: "meta" },
						`Case ${batch.total - batch.rest.length} of ${batch.total} in ${batch.name}.`,
					),
				]
			: []),
		h(
			"div",
			{ class: "row" },
			h(
				"button",
				{
					type: "button",
					"data-action": "import-replace",
					title:
						"Put the file's copy in place of the case here, with its marks and screenshots; what only the case here has is lost",
					onclick: () => actions.importReplace(),
				},
				"Replace it",
			),
			h(
				"button",
				{
					type: "button",
					"data-action": "import-copy",
					title:
						"Import the file's copy as a new case beside this one, its title ending in (copy)",
					onclick: () => actions.importCopy(),
				},
				"Keep both",
			),
			h(
				"button",
				{
					type: "button",
					"data-action": "import-cancel",
					title: batch
						? "Leave the case here as it is, and go on with the next case in the file"
						: "Import nothing; the case here stays as it is",
					onclick: () => actions.importCancel(),
				},
				batch ? "Skip" : "Cancel",
			),
		),
	);
	importPrompt.hidden = false;
}

/** "3 marks are drawn" and the like: what Annotate this page means now. */
export function annotateHintText(state: PanelState): string | undefined {
	const o = state.overlay;
	if (o === undefined) return undefined;
	const n = o.drafts;
	const one = n === 1;
	const marks = `${n} mark${one ? "" : "s"}`;
	if (!o.visible)
		return n === 0
			? undefined
			: `${marks} on this page ${one ? "is" : "are"} not saved yet. Annotate this page shows ${one ? "it" : "them"} again.`;
	if (o.saving) return "Saving…";
	return n === 0
		? "Draw on the page with the toolbar at its bottom."
		: `${marks} drawn. Click Save case… on the page's toolbar to keep ${one ? "it" : "them"}.`;
}

function renderHome(state: PanelState, actions: Actions): void {
	const tab = state.tab;
	// Under "This page": its address, else its title (Chrome tells the
	// address only of a tab Overmark may run on).
	pageText.textContent = tab?.url ? shortUrl(tab.url) : (tab?.title ?? "");
	pageText.hidden = pageText.textContent === "";
	renderAccess(homeAccess, state);
	setHint(hint, state.hint);
	const ok = access(state) === "yes";
	// "Annotate this page" always starts a new case (DEC-023).
	const up = state.overlay?.visible === true;
	const saving = up && state.overlay?.saving === true;
	annotate.disabled = !ok || saving;
	annotate.title = ok ? annotateTitle : NEEDS_ACCESS;
	annotate.textContent = up ? "Stop annotating" : "Annotate this page";
	annotate.classList.toggle("primary", !up);
	setHint(annotateHint, ok ? annotateHintText(state) : undefined);
	importError.hidden = state.importError === undefined;
	importErrorText.textContent = state.importError ?? "";
	// One import at a time, and no export of all cases while it stores them.
	const busy = state.importWork !== undefined || state.importing !== undefined;
	setHint(
		importDone,
		state.importWork !== undefined && state.importing === undefined
			? `Importing ${state.importWork}…`
			: state.importDone,
	);
	importButton.disabled = busy;
	importButton.title = busy ? IMPORT_BUSY : importTitle;
	exportAll.disabled = busy || state.exportingAll || state.cases.length === 0;
	exportAll.title = busy ? EXPORT_ALL_BUSY : exportAllTitle;
	renderSaved(
		exportAllSaved,
		state.exported?.of === "all" ? state.exported : undefined,
		state.askingDownloads === "all",
		actions,
	);
	renderCases(state, actions);
	renderImportPrompt(state, actions);
	renderSync(state, actions);
}

// --- one case ------------------------------------------------------------------

/** The colour of the mark on the page: the shown candidate decides (review.ts). */
function colourOf(m: AnnotationMatch): "found" | "unsure" | "lost" {
	if (m.status === "lost") return "lost";
	const sure = m.status !== "ambiguous" && m.candidates[m.current]?.found;
	return sure ? "found" : "unsure";
}

/** A mark's state in a word, for its head: the number's colour says it too, but not to everyone. */
function stateWord(
	a: Annotation,
	m: AnnotationMatch | undefined,
): string | undefined {
	if (a.resolution) return RESOLUTION_LABEL[a.resolution.kind];
	if (m === undefined || m.status === "no-element") return undefined;
	return { found: "Found", unsure: "Unsure", lost: "Not found" }[colourOf(m)];
}

function matchText(m: AnnotationMatch): string {
	if (m.current > 0)
		return `Candidate ${m.current + 1} of ${m.candidates.length} (${percent(m.score)})`;
	switch (m.status) {
		case "found":
			return `Found here (${percent(m.score)})`;
		case "probable":
			return `Probably here (${percent(m.score)})`;
		case "ambiguous":
			return `Unsure: candidate ${m.current + 1} of ${m.candidates.length}`;
		case "lost":
			return m.truncated
				? "Not found in the part of the page searched"
				: "Not found on this page";
		case "no-element":
			return "No element recorded";
	}
}

/** What is news about the element shown: the mark names the one it expected. */
function shownText(
	a: Annotation,
	shown: CandidateInfo | undefined,
): string | undefined {
	if (shown === undefined) return undefined;
	const expected = a.element !== null && shown.summary === summarize(a.element);
	if (shown.visible) return expected ? undefined : shown.summary;
	return expected
		? "Hidden at this width"
		: `${shown.summary}, hidden at this width`;
}

/** Whether the page can scroll to the mark: then its head offers Show. */
const canShow = (m: AnnotationMatch | undefined): m is AnnotationMatch =>
	m !== undefined && (m.candidates.length > 0 || m.status === "no-element");

/** Crops shown large (`caseId:annotationId`); the rest are small. */
const zoomed = new Set<string>();

/** A mark's crop, small at first: a click shows it large, another small again. */
function cropView(caseId: string, a: Annotation, src: string): HTMLElement {
	const key = `${caseId}:${a.id}`;
	const button: HTMLButtonElement = h(
		"button",
		{
			type: "button",
			class: "crop",
			"data-action": "zoom",
			"aria-pressed": String(zoomed.has(key)),
			"aria-label": `Mark ${a.number}, shown large`,
			title: "Show the crop larger, or small again",
			onclick: () => {
				const large = !zoomed.delete(key);
				if (large) zoomed.add(key);
				button.setAttribute("aria-pressed", String(large));
			},
		},
		h("img", { src, alt: "" }),
	);
	return button;
}

function matchView(
	caseId: string,
	a: Annotation,
	m: AnnotationMatch,
	actions: Actions,
): HTMLElement {
	const shown = m.candidates[m.current];
	const buttons = h("div", { class: "row" });
	// A sure match needs no other: offered where unsure, or to step back.
	if (m.candidates.length > 1 && (colourOf(m) !== "found" || m.current > 0))
		buttons.append(
			h(
				"button",
				{
					type: "button",
					"data-action": "next",
					title: "Show the next element on the page that could be this mark's",
					onclick: () => actions.showMatch(caseId, a, m.current + 1),
				},
				"Next candidate",
			),
		);
	const said = shownText(a, shown);
	return h(
		"div",
		{
			class: `match ${colourOf(m)}`,
			id: `match-${a.id}`,
			"data-status": m.status,
		},
		h(
			"div",
			{ class: "line" },
			h("span", { class: "status" }, matchText(m)),
			buttons.childElementCount > 0 ? buttons : null,
		),
		said ? h("p", { class: "meta" }, said) : null,
	);
}

/** The parts of the open case's view, kept between renders. */
interface CaseParts {
	/** The case as last drawn, for the buttons. */
	current: Case;
	title: HTMLElement;
	meta: HTMLElement;
	/** The case's address, a link where it is a web page. */
	page: HTMLButtonElement;
	/** The address where it is not a web page (only text, never a link). */
	about: HTMLSpanElement;
	madeAt: HTMLSpanElement;
	madeOn: HTMLSpanElement;
	/** How far the case has come: the counts and the bar. */
	status: HTMLElement;
	statusKey: string;
	/** The tab in front, where its size is not the case's. */
	size: HTMLElement;
	sizeText: HTMLSpanElement;
	origin: HTMLElement;
	/** Overmark may not run on the tab in front. */
	access: Notice;
	/** None of the case's marks were found on the tab in front (DEC-022). */
	noneFound: Notice;
	/** What the tab in front shows of the case, in one line. */
	tabLine: HTMLElement;
	/** Show, or Hide where the case is loaded on the tab in front. */
	loadButton: HTMLButtonElement;
	loadedHere: boolean;
	/** "Add marks", or "Done adding" while the toolbar adds to the case. */
	addMarks: HTMLButtonElement;
	adding: boolean;
	/** "← All cases" is finishing the marks, or could not (DEC-023). */
	leaving: HTMLElement;
	deleteButton: HTMLButtonElement;
	/** Where Export saved the file. */
	saved: HTMLElement;
	hint: HTMLElement;
	verdict: HTMLTextAreaElement;
	verdictStatus: HTMLSpanElement;
	saveVerdict: HTMLButtonElement;
	marks: HTMLElement;
	marksKey: string;
	shots: HTMLElement;
	shotsKey: string;
}

let parts: CaseParts | undefined;

function createParts(c: Case, actions: Actions): CaseParts {
	const verdict: HTMLTextAreaElement = h("textarea", {
		id: "verdict",
		rows: "2",
		placeholder:
			"What should change, as agreed. Whoever loads this case sees it first.",
		maxlength: String(MAX_VERDICT),
		"data-case": c.id,
		oninput: () => actions.typeVerdict(c.id, verdict.value),
	});
	const verdictStatus = h("span", { class: "meta", id: "verdict-status" });
	const page = h("button", {
		type: "button",
		class: "link page-link",
		id: "open-page",
		title: "Open this page in a new tab and load the case there",
		onclick: () => actions.openPage(created.current),
	});
	const about = h("span");
	const madeAt = h("span");
	const madeOn = h("span");
	const sizeText = h("span");
	const created: CaseParts = {
		current: c,
		title: h("h2", { class: "case-title" }),
		meta: h("p", { class: "meta case-meta" }, page, about, madeAt, madeOn),
		page,
		about,
		madeAt,
		madeOn,
		status: h("div", { class: "case-status", id: "case-status" }),
		statusKey: "",
		size: h(
			"p",
			{ class: "meta size", id: "case-size", hidden: true },
			sizeText,
			h(
				"button",
				{
					type: "button",
					id: "match-size",
					title:
						"Resize the browser window so this tab is as large as it was when the marks were made",
					onclick: () => actions.matchSize(created.current),
				},
				"Match size",
			),
		),
		sizeText,
		origin: h("p", { class: "hint", id: "case-origin", hidden: true }),
		access: accessNotice("case-access", () => actions),
		noneFound: notice(
			"none-found",
			h(
				"button",
				{
					type: "button",
					"data-action": "open-case-page",
					title:
						"Open the page the marks were made on in a new tab; the case's marks are drawn there",
					onclick: () => actions.openPage(created.current),
				},
				"Open the case's page",
			),
		),
		tabLine: h("p", { class: "tab-line", id: "tab-line", hidden: true }),
		loadButton: h("button", {
			type: "button",
			class: "quiet",
			id: "load-case",
			onclick: () =>
				created.loadedHere
					? actions.hideFromTab(created.current)
					: actions.loadOntoTab(created.current),
		}),
		loadedHere: false,
		addMarks: h(
			"button",
			{
				type: "button",
				id: "add-marks",
				class: "primary",
				onclick: () =>
					created.adding
						? actions.doneAdding(created.current)
						: actions.addMarks(created.current),
			},
			"Add marks",
		),
		adding: false,
		leaving: h("p", {
			class: "hint",
			id: "leave-hint",
			role: "status",
			hidden: true,
		}),
		deleteButton: h("button", {
			type: "button",
			class: "danger",
			id: "delete-case",
			onclick: () => actions.deleteCase(created.current),
		}),
		saved: h("div", { id: "export-saved", hidden: true }),
		hint: h("p", { class: "hint", id: "case-hint", hidden: true }),
		verdict,
		verdictStatus,
		saveVerdict: h(
			"button",
			{
				type: "button",
				class: "small",
				id: "save-verdict",
				hidden: true,
				onclick: () => actions.saveVerdict(c.id, verdict.value),
			},
			"Save summary",
		),
		marks: h("section"),
		marksKey: "",
		shots: h("section"),
		shotsKey: "",
	};
	const header = h(
		"section",
		{ class: "case-header" },
		created.title,
		created.meta,
		created.origin,
		created.status,
		h(
			"div",
			{ class: "row case-actions" },
			created.addMarks,
			h(
				"button",
				{
					type: "button",
					id: "export-case",
					title:
						"Save this case as one .zip file: its marks, comments, AI findings, summary and screenshots, and case.md to read them without Overmark. Someone imports it with Import a case…",
					onclick: () => actions.exportCase(created.current),
				},
				"Export",
			),
		),
		created.leaving,
		created.saved,
		// What the tab in front shows of the case (DEC-022, DEC-023).
		h(
			"div",
			{ class: "this-tab", id: "this-tab" },
			created.access.el,
			created.noneFound.el,
			created.tabLine,
			created.hint,
			created.size,
			created.loadButton,
		),
		// What the whole case comes to: the case's, not a mark's. Stored as
		// verdict, its name before (DEC-019).
		h(
			"div",
			{ class: "verdict" },
			h(
				"div",
				{ class: "verdict-head" },
				h("label", { for: "verdict" }, "Summary for the developer"),
				verdictStatus,
				created.saveVerdict,
			),
			verdict,
		),
	);
	caseView.replaceChildren(
		header,
		created.marks,
		created.shots,
		h("section", { class: "case-footer" }, created.deleteButton),
	);
	return created;
}

/** One line on what the tab in front shows of the case, where there is one. */
function tabLineText(
	state: PanelState,
	c: Case,
	adding: boolean,
): string | undefined {
	if (adding)
		return "Adding marks: draw on the page. Each mark is saved into this case when its comment is done.";
	const o = state.overlay;
	if (o !== undefined && o.drafts > 0 && o.target === undefined) {
		const one = o.drafts === 1;
		return `${o.drafts} unsaved mark${one ? " is" : "s are"} on this page. Add marks puts ${one ? "it" : "them"} into this case; go back to All cases to save ${one ? "it" : "them"} as a new one.`;
	}
	const tabId = state.tab?.id;
	if (tabId === undefined) return undefined;
	if (state.hiddenOn.has(tabId)) return "Marks are hidden on this tab.";
	if (
		state.drawing === tabId &&
		!(state.loaded?.caseId === c.id && state.loaded.tabId === tabId)
	)
		return "Looking for the marks on this tab…";
	return undefined;
}

/** Under the action row while "← All cases" waits for the toolbar (DEC-023). */
export function leavingText(
	leaving: PanelState["leaving"],
): string | undefined {
	if (leaving === undefined) return undefined;
	if (leaving.phase === "finishing") return "Finishing the marks…";
	const one = leaving.left === 1;
	return `${leaving.left} mark${one ? " is" : "s are"} not in the case yet; the toolbar on the page says why. Click ← All cases again to leave without ${one ? "it" : "them"}.`;
}

// --- a mark's status and its actions ---------------------------------------

/** "5 open, 2 fixed, 1 won't fix"; nothing while every mark is open. */
function countsText(c: Case): string | undefined {
	const resolved = c.annotations.filter((a) => a.resolution);
	if (resolved.length === 0) return undefined;
	const parts = [`${c.annotations.length - resolved.length} open`];
	for (const kind of RESOLUTION_KINDS) {
		const n = resolved.filter((a) => a.resolution?.kind === kind).length;
		if (n > 0) parts.push(`${n} ${RESOLUTION_LABEL[kind].toLowerCase()}`);
	}
	return parts.join(", ");
}

function markCounts(c: Case): HTMLElement | null {
	const text = countsText(c);
	return text ? h("p", { class: "meta mark-counts" }, text) : null;
}

/** How far the case has come, as a bar: open, then each way of settling. */
function progress(c: Case): HTMLElement | null {
	if (c.annotations.length === 0) return null;
	const count = (kind?: ResolutionKind) =>
		c.annotations.filter((a) => a.resolution?.kind === kind).length;
	const parts: [string, number][] = [
		["open", count()],
		...RESOLUTION_KINDS.map((k): [string, number] => [k, count(k)]),
	];
	// The counts above say it in words: the bar is only a picture of them.
	// A span: it also sits inside a case's button in the list.
	return h(
		"span",
		{ class: "progress", "aria-hidden": "true" },
		...parts
			.filter(([, n]) => n > 0)
			.map(([kind, n]) =>
				h("span", { "data-kind": kind, style: `flex-grow: ${n}` }),
			),
	);
}

function resolutionLine(a: Annotation): HTMLElement | null {
	const r = a.resolution;
	if (r === undefined) return null;
	return h(
		"p",
		{ class: "resolution", "data-kind": r.kind },
		h("span", { class: "kind" }, RESOLUTION_LABEL[r.kind]),
		r.note ? h("span", { class: "note" }, r.note) : null,
	);
}

function markActions(
	c: Case,
	a: Annotation,
	armed: boolean,
	actions: Actions,
): HTMLElement {
	const button = (
		label: string,
		action: string,
		title: string | undefined,
		onclick: () => void,
	) =>
		h(
			"button",
			{
				type: "button",
				class: "small",
				"data-mark-action": action,
				title,
				onclick,
			},
			label,
		);
	return h(
		"div",
		{ class: "mark-actions" },
		a.resolution
			? button(
					"Reopen",
					"reopen",
					"Make the mark open again; its resolution and note go",
					() => actions.reopenMark(c, a),
				)
			: button(
					"Resolve…",
					"resolve",
					"Mark it fixed, won't fix or can't reproduce, with a note if you like",
					() => actions.editMark(c, a, "resolve"),
				),
		a.resolution
			? button(
					"Change…",
					"resolve",
					"Change how it was resolved, or its note",
					() => actions.editMark(c, a, "resolve"),
				)
			: null,
		button("Edit comment", "comment", undefined, () =>
			actions.editMark(c, a, "comment"),
		),
		h(
			"button",
			{
				type: "button",
				class: "small danger",
				"data-mark-action": "delete",
				title: armed
					? "Click again to delete this mark"
					: "Delete this mark and its crop (click twice); its number is not given again",
				...(armed ? { "data-armed": true } : {}),
				onclick: () => actions.deleteMark(c, a),
			},
			armed ? "Really delete?" : "Delete",
		),
	);
}

/** The form that has had its focus: a redraw does not take it again. */
let focusedForm: string | undefined;

/** Focus a mark's form when it opens, not each time the list is drawn again. */
function focusOnOpen(form: string, field: HTMLElement): void {
	field.dataset["form"] = form;
	// Drawn again while typing in it: the new field takes over, caret and all.
	const typing = document.activeElement as HTMLInputElement | null;
	if (focusedForm === form) {
		if (typing?.dataset["form"] !== form) return;
		const at = typing.selectionStart;
		queueMicrotask(() => {
			field.focus();
			if (at !== null && "setSelectionRange" in field)
				(field as HTMLInputElement).setSelectionRange(at, at);
		});
		return;
	}
	focusedForm = form;
	queueMicrotask(() => field.focus());
}

function resolveForm(
	c: Case,
	a: Annotation,
	kind: ResolutionKind,
	note: string,
	actions: Actions,
): HTMLElement {
	const name = `resolution-${a.id}`;
	const noteField: HTMLInputElement = h("input", {
		type: "text",
		class: "note",
		placeholder: "Note (optional): why, or what was done",
		maxlength: String(MAX_COMMENT),
		"aria-label": `Note for mark ${a.number}`,
		value: note,
		oninput: () => actions.typeMark({ text: noteField.value }),
		onkeydown: (e) => {
			const key = (e as KeyboardEvent).key;
			if (key === "Enter") submit();
			if (key === "Escape") actions.cancelMarkEdit();
		},
	});
	const chosen = () =>
		(form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)
			?.value ?? kind) as ResolutionKind;
	const submit = () => actions.resolveMark(c, a, chosen(), noteField.value);
	const form = h(
		"div",
		{ class: "mark-form", "data-form": "resolve" },
		h(
			"fieldset",
			{},
			h("legend", {}, `Resolve mark ${a.number} as`),
			...RESOLUTION_KINDS.map((k) =>
				h(
					"label",
					{ class: "choice" },
					h("input", {
						type: "radio",
						name,
						value: k,
						checked: k === kind,
						onchange: () => actions.typeMark({ kind: k }),
					}),
					RESOLUTION_LABEL[k],
				),
			),
		),
		noteField,
		h(
			"div",
			{ class: "row" },
			h(
				"button",
				{
					type: "button",
					class: "primary small",
					"data-mark-action": "resolve-done",
					onclick: submit,
				},
				a.resolution ? "Save" : "Resolve",
			),
			h(
				"button",
				{
					type: "button",
					class: "small",
					onclick: () => actions.cancelMarkEdit(),
				},
				"Cancel",
			),
		),
	);
	focusOnOpen(`${a.id}:resolve`, noteField);
	return form;
}

function commentForm(
	c: Case,
	a: Annotation,
	text: string,
	actions: Actions,
): HTMLElement {
	const field: HTMLTextAreaElement = h(
		"textarea",
		{
			maxlength: String(MAX_COMMENT),
			"aria-label": `Comment of mark ${a.number}`,
			oninput: () => actions.typeMark({ text: field.value }),
			onkeydown: (e) => {
				const k = e as KeyboardEvent;
				if (k.key === "Enter" && (k.metaKey || k.ctrlKey)) save();
				if (k.key === "Escape") actions.cancelMarkEdit();
			},
		},
		text,
	);
	const save = () => actions.saveComment(c, a, field.value);
	focusOnOpen(`${a.id}:comment`, field);
	return h(
		"div",
		{ class: "mark-form", "data-form": "comment" },
		field,
		h(
			"div",
			{ class: "row" },
			h(
				"button",
				{
					type: "button",
					class: "primary small",
					"data-mark-action": "comment-done",
					onclick: save,
				},
				"Save",
			),
			h(
				"button",
				{
					type: "button",
					class: "small",
					onclick: () => actions.cancelMarkEdit(),
				},
				"Cancel",
			),
		),
	);
}

function renderCase(state: PanelState, actions: Actions): void {
	const c = state.current;
	if (c === undefined) {
		parts = undefined;
		caseView.replaceChildren(h("p", { class: "meta" }, "Loading…"));
		return;
	}
	if (parts?.current.id !== c.id) parts = createParts(c, actions);
	const p = parts;
	p.current = c;
	// The summary: what the store has, unless the user typed another.
	const draft = state.verdictDrafts.get(c.id);
	const verdict = draft ?? c.verdict ?? "";
	if (p.verdict.value !== verdict) p.verdict.value = verdict;
	p.verdictStatus.textContent =
		state.verdictStatus ?? (draft === undefined ? "" : "Not saved yet");
	// Only while the text differs from what is stored.
	p.saveVerdict.hidden = draft === undefined;

	p.title.textContent = c.title;
	const web = isWebPage(c.page.url);
	p.page.hidden = !web;
	p.page.textContent = web ? shortUrl(c.page.url) : "";
	p.about.hidden = web;
	p.about.textContent = web ? "" : c.page.url;
	p.madeAt.textContent = sizeOf(c.page.viewport);
	p.madeOn.textContent = formatDate(c.createdAt);
	const size = state.tab?.size;
	p.size.hidden = size === undefined || sameSize(size, c.page.viewport);
	p.sizeText.textContent = size
		? `This tab is ${sizeOf(size)}, the marks were made at ${sizeOf(c.page.viewport)}. `
		: "";
	setHint(
		p.origin,
		c.importedAt === undefined
			? undefined
			: `Imported from a file on ${formatDate(c.importedAt)}. Its comments, summary and findings are whoever wrote the file's, whatever author or AI app they name.`,
	);
	// Marks the panel loaded, or an AI app (the page says so).
	const here =
		state.loaded?.caseId === c.id && state.loaded.tabId === state.tab?.id
			? state.loaded
			: undefined;
	p.loadedHere = here !== undefined || state.overlay?.loadedCase === c.id;
	renderAccess(p.access, state);
	const ok = access(state) === "yes";
	// The toolbar on the tab in front adds to this case (DEC-023).
	p.adding =
		state.overlay?.visible === true && state.overlay.target?.caseId === c.id;
	p.addMarks.disabled = !ok || state.leaving?.phase === "finishing";
	p.addMarks.textContent = p.adding ? "Done adding" : "Add marks";
	p.addMarks.classList.toggle("primary", !p.adding);
	p.addMarks.title = !ok
		? NEEDS_ACCESS
		: p.adding
			? "Stop adding marks: the toolbar goes once each mark is in the case"
			: "Each mark you draw on the page goes into this case when its comment is done";
	setHint(p.leaving, leavingText(state.leaving));
	setHint(p.tabLine, ok ? tabLineText(state, c, p.adding) : undefined);
	// The search is over and found none: the case is probably for another page.
	const none =
		here !== undefined &&
		!here.settling &&
		noneFound([...here.matches.values()]);
	const looking =
		state.drawing !== undefined &&
		state.drawing === state.tab?.id &&
		here === undefined;
	p.loadButton.hidden = !ok || none || looking;
	p.loadButton.textContent = p.loadedHere ? "Hide marks" : "Show marks";
	p.loadButton.title = p.loadedHere
		? "Take this case's marks off the page in this tab; they stay off on this tab until you show them again"
		: "Look for each mark's element on the page in this tab and draw the marks there";
	p.noneFound.el.hidden = !none;
	p.noneFound.text.textContent = none ? noneFoundText(c, state.tab?.url) : "";
	p.noneFound.button.hidden =
		!none || !isWebPage(c.page.url) || isPageOf(c, state.tab?.url ?? "");
	const armed = state.deleteArmedAt !== undefined;
	p.deleteButton.toggleAttribute("data-armed", armed);
	p.deleteButton.textContent = armed ? "Really delete?" : "Delete";
	p.deleteButton.title = armed
		? "Click again to delete this case and its screenshots"
		: "Delete this case and its screenshots from this browser (click twice). Files exported before stay.";
	const of = (e: Exported["of"] | undefined) =>
		e !== undefined && e !== "all" && e.caseId === c.id;
	renderSaved(
		p.saved,
		of(state.exported?.of) ? state.exported : undefined,
		of(state.askingDownloads),
		actions,
	);
	setHint(p.hint, state.caseHint);
	const statusKey = JSON.stringify(
		c.annotations.map((a) => a.resolution?.kind ?? null),
	);
	if (statusKey !== p.statusKey) {
		p.statusKey = statusKey;
		p.status.replaceChildren(
			...[markCounts(c), progress(c)].filter((e) => e !== null),
		);
	}

	const images = state.images?.caseId === c.id ? state.images : undefined;
	const loaded = state.loaded?.caseId === c.id ? state.loaded : undefined;
	const edit = state.markEdit;
	if (edit === undefined) focusedForm = undefined;
	const markArmed = state.markDeleteArmed?.annotationId;
	const findingArmed = state.findingDeleteArmed;
	const marksKey = JSON.stringify([
		c.updatedAt,
		images?.version,
		loaded ? [...loaded.matches.values()] : null,
		// What is typed stays out: a key press redraws nothing.
		edit ? [edit.annotationId, edit.mode] : null,
		markArmed ?? null,
		findingArmed ? [findingArmed.annotationId, findingArmed.findingId] : null,
		ok,
	]);
	if (marksKey !== p.marksKey) {
		const sorted = [...c.annotations].sort((x, y) => x.number - y.number);
		const items = sorted.map((a) =>
			markItem(c, a, {
				crop: images?.urls.get(a.crop),
				match: loaded?.matches.get(a.id),
				edit: edit?.annotationId === a.id ? edit : undefined,
				armed: markArmed === a.id,
				findingArmed:
					findingArmed?.annotationId === a.id
						? findingArmed.findingId
						: undefined,
				actions,
				canReach: ok,
				changed: () => syncToggleAll(),
			}),
		);
		const toggleAll: HTMLButtonElement = h("button", {
			type: "button",
			class: "link",
			id: "toggle-marks",
			onclick: () => {
				const open = !items.every((li) => li.hasAttribute("data-open"));
				// A mark being edited keeps its form in view.
				for (const li of items)
					if (open || li.dataset["annotation"] !== edit?.annotationId)
						setOpen(c.id, li, open);
				syncToggleAll();
			},
		});
		const syncToggleAll = () => {
			const all = items.every((li) => li.hasAttribute("data-open"));
			toggleAll.textContent = all ? "Collapse all" : "Expand all";
		};
		syncToggleAll();
		toggleAll.hidden = items.length === 0;
		const marks = h(
			"section",
			{ class: "marks", "aria-labelledby": "marks-heading" },
			h(
				"div",
				{ class: "marks-bar" },
				h(
					"h2",
					{ id: "marks-heading" },
					"Marks ",
					h("span", { class: "count" }, String(c.annotations.length)),
				),
				toggleAll,
			),
			items.length > 0
				? h("ol", { class: "annotations" }, ...items)
				: h(
						"p",
						{ class: "empty" },
						"No marks yet. Click Add marks and draw on the page.",
					),
		);
		p.marks.replaceWith(marks);
		p.marks = marks;
		p.marksKey = marksKey;
	}

	const shotsKey = JSON.stringify([c.updatedAt, images?.version]);
	if (shotsKey !== p.shotsKey) {
		const list = h("div", { class: "shots" });
		for (const shot of c.shots) {
			const url = images?.urls.get(shot.image);
			if (url)
				list.append(h("img", { src: url, alt: `Screenshot ${shot.id}` }));
		}
		// The record as taken: there to look at, so out of the way until asked.
		const shots: HTMLDetailsElement = h(
			"details",
			{ class: "shots-section", id: "case-shots" },
			h(
				"summary",
				{},
				"Screenshots ",
				h("span", { class: "count" }, String(c.shots.length)),
			),
			list,
		);
		shots.open = p.shots.hasAttribute("open");
		p.shots.replaceWith(shots);
		p.shots = shots;
		p.shotsKey = shotsKey;
	}
}

// --- a mark in the list -------------------------------------------------------

/** Marks shown open (`caseId:annotationId`); the rest show only their head. */
const openMarks = new Set<string>();

function setOpen(caseId: string, li: HTMLElement, open: boolean): void {
	const key = `${caseId}:${li.dataset["annotation"]}`;
	if (open) openMarks.add(key);
	else openMarks.delete(key);
	li.toggleAttribute("data-open", open);
	li.querySelector(".mark-toggle")?.setAttribute("aria-expanded", String(open));
	const body = li.querySelector<HTMLElement>(".body");
	if (body) body.hidden = !open;
}

interface MarkContext {
	crop: string | undefined;
	match: AnnotationMatch | undefined;
	edit: PanelState["markEdit"];
	armed: boolean;
	/** The finding of this mark whose Delete was clicked once. */
	findingArmed: string | undefined;
	actions: Actions;
	/** Overmark may run on the tab in front: Show can scroll it. */
	canReach: boolean;
	/** A mark opened or closed by its own head. */
	changed: () => void;
}

/**
 * One mark: a head (its number, comment and Show) that opens and closes the
 * rest (crop, where it is, its actions). A mark being edited stays open.
 */
function markItem(c: Case, a: Annotation, x: MarkContext): HTMLElement {
	const { match: m, edit, actions } = x;
	const bodyId = `mark-body-${a.id}`;
	const state = stateWord(a, m);
	const li: HTMLElement = h("li", {
		class: "annotation",
		"data-annotation": a.id,
		...(m ? { "data-colour": colourOf(m) } : {}),
		...(a.resolution ? { "data-resolved": a.resolution.kind } : {}),
	});
	const toggle = h(
		"button",
		{
			type: "button",
			class: "mark-toggle",
			"aria-controls": bodyId,
			onclick: () => {
				// Its form stays in view while it is being edited.
				if (edit) return;
				setOpen(c.id, li, !li.hasAttribute("data-open"));
				x.changed();
			},
		},
		h("span", { class: "chevron", "aria-hidden": "true" }),
		h("span", { class: "number" }, String(a.number)),
		h(
			"span",
			{ class: a.comment ? "comment" : "comment none" },
			a.comment || "No comment",
		),
		a.author === "ai" ? h("span", { class: "tag" }, "AI") : null,
		a.findings?.length
			? h(
					"span",
					{ class: "tag findings-count" },
					`${a.findings.length} AI finding${a.findings.length === 1 ? "" : "s"}`,
				)
			: null,
		state ? h("span", { class: "state" }, state) : null,
	);
	const show = canShow(m)
		? h(
				"button",
				{
					type: "button",
					class: "small show",
					"data-action": "show",
					"aria-label": `Show mark ${a.number} on the page`,
					title: x.canReach
						? "Scroll the page to this mark and outline it"
						: NEEDS_ACCESS,
					disabled: !x.canReach,
					onclick: () => actions.showMatch(c.id, a, m.current),
				},
				"Show",
			)
		: null;
	const body = h(
		"div",
		{ class: "body", id: bodyId },
		x.crop ? cropView(c.id, a, x.crop) : null,
		a.resolution ? resolutionLine(a) : null,
		findingsList(c, a, x.findingArmed, actions),
		a.element ? h("p", { class: "meta" }, summarize(a.element)) : null,
		m ? matchView(c.id, a, m, actions) : null,
		edit
			? edit.mode === "resolve"
				? resolveForm(c, a, edit.kind, edit.text, actions)
				: commentForm(c, a, edit.text, actions)
			: markActions(c, a, x.armed, actions),
	);
	li.append(h("div", { class: "mark-head" }, toggle, show), body);
	setOpen(c.id, li, edit !== undefined || openMarks.has(`${c.id}:${a.id}`));
	return li;
}

/** When a finding was written, and last changed. */
function findingTime(at: string, editedAt: string | undefined): string {
	return editedAt
		? `${formatDate(at)}, edited ${formatDate(editedAt)}`
		: formatDate(at);
}

/**
 * The AI apps' findings on a mark, under the user's comment and apart from
 * it: each with its app and time, and a Delete that asks once more.
 */
function findingsList(
	c: Case,
	a: Annotation,
	armed: string | undefined,
	actions: Actions,
): HTMLElement | null {
	const findings = a.findings ?? [];
	if (findings.length === 0) return null;
	return h(
		"section",
		{ class: "findings", "aria-label": `AI findings on mark ${a.number}` },
		h("h3", {}, "AI findings"),
		h(
			"ul",
			{},
			...findings.map((f) =>
				h(
					"li",
					{ "data-finding": f.id },
					h("p", { class: "finding-text" }, f.text),
					h(
						"div",
						{ class: "finding-meta" },
						h(
							"span",
							{ class: "meta" },
							`${appLabel(f.app)}${f.imported ? ", as the file says" : ""}, ${findingTime(f.at, f.editedAt)}`,
						),
						h(
							"button",
							{
								type: "button",
								class: "small danger",
								"data-finding-action": "delete",
								"aria-label":
									armed === f.id
										? `Really delete this finding on mark ${a.number}?`
										: `Delete this finding on mark ${a.number}`,
								title:
									armed === f.id
										? "Click again to delete this finding"
										: "Delete this AI finding (click twice); the mark and your comment stay",
								...(armed === f.id ? { "data-armed": true } : {}),
								onclick: () => actions.deleteFinding(c, a, f.id),
							},
							armed === f.id ? "Really delete?" : "Delete",
						),
					),
				),
			),
		),
	);
}

// --- the AI app ------------------------------------------------------------------

function callText(call: AiCall): string {
	const time = new Date(call.at).toLocaleTimeString();
	return `Last AI call: ${call.tool}, by ${call.app}, at ${time}`;
}

function renderAi({ ai }: PanelState): void {
	aiStatus.textContent = ai.status;
	// A long problem is cut to one line: then its whole is the button's title.
	aiButton.title =
		aiStatus.scrollWidth > aiStatus.clientWidth
			? ai.status
			: ai.active
				? "Go to the AI app card: the paired apps and what they may do"
				: "Turn AI access on and go to the AI app card";
	// Waiting for an app to pair: nothing to do but wait (a click shows how).
	aiAction.hidden = ai.active && !ai.connected;
	aiAction.textContent = ai.connected ? "Manage" : "Turn on";
	bar.dataset["ai"] = ai.connected
		? "connected"
		: ai.active
			? "waiting"
			: "off";
	stopAi.hidden = !ai.active;
	keepOn.checked = ai.keepOn;
	setHint(aiCall, ai.lastCall && callText(ai.lastCall));
}

/**
 * A click on the back button this soon after the last one, which it did
 * something else for, is that double click's second (as Delete's).
 */
export const BACK_CLICK_GAP_MS = 500;

/** The back button's last click, and what it did then. */
let lastBack: { at: number; role: string } | undefined;

/**
 * The top bar's back button (DEC-023): "← All cases" closes the open case,
 * "← Back" leaves Settings for the view underneath; none on Home. One button
 * that changes its meaning under the pointer: the second click of a double
 * click does nothing (as Delete's).
 */
function renderBack(state: PanelState, actions: Actions): void {
	const onCase = state.view.kind === "case";
	const role = state.settings
		? "settings"
		: `case ${state.leaving?.phase ?? ""}`;
	const click = (act: () => void) => () => {
		const at = Date.now();
		const last = lastBack;
		lastBack = { at, role };
		if (
			last !== undefined &&
			last.role !== role &&
			at >= last.at &&
			at - last.at < BACK_CLICK_GAP_MS
		)
			return;
		act();
	};
	back.hidden = !state.settings && !onCase;
	if (state.settings) {
		back.textContent = "← Back";
		back.setAttribute(
			"aria-label",
			onCase ? "Back to the case" : "Back to all cases",
		);
		back.title = onCase ? "Back to the open case" : "Back to the cases";
		back.disabled = false;
		back.onclick = click(() => actions.closeSettings());
		return;
	}
	back.textContent = "← All cases";
	back.setAttribute("aria-label", "All cases: close this case");
	back.title =
		"Close this case: the toolbar stops adding to it, and its marks leave this tab";
	back.disabled = state.leaving?.phase === "finishing";
	back.onclick = click(() => actions.closeCase());
}

/** Draw the panel from `state`. */
export function render(state: PanelState, actions: Actions): void {
	lastActions = actions;
	renderAi(state);
	renderBack(state, actions);
	allSites.checked = state.allSites;
	const onCase = state.view.kind === "case";
	home.hidden = onCase || state.settings;
	caseView.hidden = !onCase || state.settings;
	settingsView.hidden = !state.settings;
	if (onCase) {
		renderCase(state, actions);
	} else {
		parts = undefined;
		caseView.replaceChildren();
	}
	// Under an open case and Settings too: Home is as it is when it shows
	// again ("← All cases", or a case the panel opened from the page).
	renderHome(state, actions);
}
