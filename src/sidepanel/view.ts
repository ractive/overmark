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
import { type Size, sameSize } from "./size.ts";
import type { AiCall, PanelState } from "./state.ts";

/** What the user can do; main.ts carries it out and updates the state. */
export interface Actions {
	toggleAnnotate(): void;
	openCase(id: string): void;
	closeCase(): void;
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
	openAndLoad(c: Case): void;
	openPage(c: Case): void;
	matchSize(c: Case): void;
	addMarks(c: Case): void;
	exportCase(c: Case): void;
	deleteCase(c: Case): void;
	typeVerdict(caseId: string, text: string): void;
	saveVerdict(caseId: string, text: string): void;
	showMatch(caseId: string, a: Annotation, candidate: number): void;
	importReplace(): void;
	importCopy(): void;
	importCancel(): void;
}

const bar = byId<HTMLElement>("bar");
const home = byId<HTMLElement>("home");
const caseView = byId<HTMLElement>("case-view");
const pageText = byId<HTMLParagraphElement>("page");
const hint = byId<HTMLParagraphElement>("hint");
const annotate = byId<HTMLButtonElement>("annotate");
const casesList = byId<HTMLDivElement>("cases");
const allSites = byId<HTMLInputElement>("all-sites");
const aiStatus = byId<HTMLSpanElement>("ai-status");
const aiButton = byId<HTMLButtonElement>("ai-button");
const aiAction = byId<HTMLSpanElement>("ai-action");
const aiCall = byId<HTMLParagraphElement>("ai-call");
const stopAi = byId<HTMLButtonElement>("stop-ai");
const keepOn = byId<HTMLInputElement>("keep-on");
const importError = byId<HTMLDivElement>("import-error");
const importErrorText = byId<HTMLParagraphElement>("import-error-text");
const importPrompt = h("div", {
	class: "hint",
	id: "import-prompt",
	hidden: true,
});
byId<HTMLButtonElement>("import").parentElement?.after(importPrompt);

/** Why Overmark does not work on a tab yet, and what to do about it. */
export const NO_ACCESS =
	"Overmark may not run on this tab yet. Click the Overmark icon in the toolbar (or press Alt+Shift+O) while this tab is in front.";

const sizeOf = (s: Size) => `${s.width}×${s.height}`;

const percent = (score: number) => `${Math.round(score * 100)}%`;

function setHint(el: HTMLElement, text: string | undefined): void {
	el.hidden = text === undefined;
	el.textContent = text ?? "";
}

// --- home ----------------------------------------------------------------------

/** A case of the page in front loads when it is opened: no Load of its own. */
function caseItem(c: Case, actions: Actions, here: boolean): HTMLLIElement {
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
		here
			? null
			: h(
					"button",
					{
						type: "button",
						class: "load",
						"data-load": c.id,
						title: `Load “${c.title}” onto this tab`,
						onclick: () => actions.openAndLoad(c),
					},
					"Load",
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
			h("p", { class: "empty" }, "No cases yet. Annotate a page and save it."),
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
						...here.map((c) => caseItem(c, actions, isPageOf(c, url))),
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
						...other.map((c) => caseItem(c, actions, false)),
					),
				]
			: []),
	);
}

function renderImportPrompt(state: PanelState, actions: Actions): void {
	const importing = state.importing;
	const key = JSON.stringify([
		importing?.existing.id,
		importing?.existing.updatedAt,
		importing?.parsed.case.updatedAt,
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
		h(
			"div",
			{ class: "row" },
			h(
				"button",
				{
					type: "button",
					"data-action": "import-replace",
					onclick: () => actions.importReplace(),
				},
				"Replace it",
			),
			h(
				"button",
				{
					type: "button",
					"data-action": "import-copy",
					onclick: () => actions.importCopy(),
				},
				"Keep both",
			),
			h(
				"button",
				{ type: "button", onclick: () => actions.importCancel() },
				"Cancel",
			),
		),
	);
	importPrompt.hidden = false;
}

function renderHome(state: PanelState, actions: Actions): void {
	const tab = state.tab;
	pageText.textContent = tab?.url
		? shortUrl(tab.url)
		: tab?.title || "This page";
	// Chrome tells the address only of a tab Overmark may run on.
	setHint(hint, state.hint ?? (tab && !tab.url ? NO_ACCESS : undefined));
	const target = state.overlay?.target;
	annotate.textContent = state.overlay?.visible
		? "Stop annotating"
		: state.cases.some((c) => c.id === target?.caseId)
			? "Continue annotating"
			: "Annotate this page";
	allSites.checked = state.allSites;
	importError.hidden = state.importError === undefined;
	importErrorText.textContent = state.importError ?? "";
	renderCases(state, actions);
	renderImportPrompt(state, actions);
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
	/** The tab in front, where its size is not the case's. */
	size: HTMLElement;
	sizeText: HTMLSpanElement;
	origin: HTMLElement;
	/** Load, or Hide where the case is loaded on the tab in front. */
	loadButton: HTMLButtonElement;
	loadedHere: boolean;
	deleteButton: HTMLButtonElement;
	hint: HTMLElement;
	verdict: HTMLTextAreaElement;
	verdictStatus: HTMLSpanElement;
	marks: HTMLElement;
	marksKey: string;
	shots: HTMLElement;
	shotsKey: string;
}

let parts: CaseParts | undefined;

function createParts(c: Case, actions: Actions): CaseParts {
	const verdict: HTMLTextAreaElement = h("textarea", {
		id: "verdict",
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
		title: h("h2"),
		meta: h("p", { class: "meta chips" }, page, about, madeAt, madeOn),
		page,
		about,
		madeAt,
		madeOn,
		size: h(
			"p",
			{ class: "meta size", id: "case-size", hidden: true },
			sizeText,
			h(
				"button",
				{
					type: "button",
					id: "match-size",
					onclick: () => actions.matchSize(created.current),
				},
				"Match size",
			),
		),
		sizeText,
		origin: h("p", { class: "hint", id: "case-origin", hidden: true }),
		loadButton: h("button", {
			type: "button",
			class: "primary wide",
			id: "load-case",
			onclick: () =>
				created.loadedHere
					? actions.hideFromTab(created.current)
					: actions.loadOntoTab(created.current),
		}),
		loadedHere: false,
		deleteButton: h("button", {
			type: "button",
			class: "danger",
			id: "delete-case",
			onclick: () => actions.deleteCase(created.current),
		}),
		hint: h("p", { class: "hint", id: "case-hint", hidden: true }),
		verdict,
		verdictStatus,
		marks: h("section"),
		marksKey: "",
		shots: h("section"),
		shotsKey: "",
	};
	const header = h(
		"section",
		{ class: "case-header" },
		h(
			"button",
			{ type: "button", class: "link", onclick: () => actions.closeCase() },
			"← All cases",
		),
		created.title,
		created.meta,
		created.size,
		created.origin,
		created.loadButton,
		h(
			"div",
			{ class: "row" },
			h(
				"button",
				{
					type: "button",
					id: "add-marks",
					title:
						"Each mark you draw on the page goes into this case when its comment is done",
					onclick: () => actions.addMarks(created.current),
				},
				"Add marks",
			),
			h(
				"button",
				{
					type: "button",
					id: "export-case",
					onclick: () => actions.exportCase(created.current),
				},
				"Export",
			),
			created.deleteButton,
		),
		created.hint,
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
				h(
					"button",
					{
						type: "button",
						class: "small",
						id: "save-verdict",
						onclick: () => actions.saveVerdict(c.id, verdict.value),
					},
					"Save summary",
				),
			),
			verdict,
		),
	);
	caseView.replaceChildren(header, created.marks, created.shots);
	return created;
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
	const button = (label: string, action: string, onclick: () => void) =>
		h(
			"button",
			{ type: "button", class: "small", "data-mark-action": action, onclick },
			label,
		);
	return h(
		"div",
		{ class: "mark-actions" },
		a.resolution
			? button("Reopen", "reopen", () => actions.reopenMark(c, a))
			: button("Resolve…", "resolve", () => actions.editMark(c, a, "resolve")),
		a.resolution
			? button("Change…", "resolve", () => actions.editMark(c, a, "resolve"))
			: null,
		button("Edit comment", "comment", () => actions.editMark(c, a, "comment")),
		h(
			"button",
			{
				type: "button",
				class: "small danger",
				"data-mark-action": "delete",
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
	p.loadedHere =
		(state.loaded?.caseId === c.id && state.loaded.tabId === state.tab?.id) ||
		state.overlay?.loadedCase === c.id;
	p.loadButton.textContent = p.loadedHere
		? "Hide marks on this tab"
		: "Show marks on this tab";
	p.loadButton.classList.toggle("primary", !p.loadedHere);
	const armed = state.deleteArmedAt !== undefined;
	p.deleteButton.toggleAttribute("data-armed", armed);
	p.deleteButton.textContent = armed ? "Really delete?" : "Delete";
	setHint(p.hint, state.caseHint);

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
				markCounts(c),
				progress(c),
			),
			items.length > 0
				? h("ol", { class: "annotations" }, ...items)
				: h("p", { class: "empty" }, "No marks yet."),
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
	aiButton.title = aiStatus.scrollWidth > aiStatus.clientWidth ? ai.status : "";
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

/** Draw the panel from `state`. */
export function render(state: PanelState, actions: Actions): void {
	renderAi(state);
	const onCase = state.view.kind === "case";
	home.hidden = onCase;
	caseView.hidden = !onCase;
	if (onCase) {
		renderCase(state, actions);
	} else {
		parts = undefined;
		caseView.replaceChildren();
		renderHome(state, actions);
	}
}
