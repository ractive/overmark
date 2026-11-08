/**
 * Drawing the side panel from its state (DEC-011). `render` is the only code
 * that touches the panel's DOM. The open case's verdict and buttons stay the
 * same elements while it is open, so typing, focus and clicks survive every
 * render; the other parts are redrawn when what they show changed.
 */

import {
	type Annotation,
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
const aiCall = byId<HTMLParagraphElement>("ai-call");
const stopAi = byId<HTMLButtonElement>("stop-ai");
const connectButton = byId<HTMLButtonElement>("connect");
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
				`${count} mark${count === 1 ? "" : "s"}, ${formatDate(c.updatedAt)}`,
			),
			c.verdict
				? h("span", { class: "meta" }, `Verdict: ${c.verdict.slice(0, 80)}`)
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

function matchView(
	caseId: string,
	a: Annotation,
	m: AnnotationMatch,
	actions: Actions,
): HTMLElement {
	const shown = m.candidates[m.current];
	const buttons = h("div", { class: "row" });
	if (m.candidates.length > 0 || m.status === "no-element")
		buttons.append(
			h(
				"button",
				{
					type: "button",
					"data-action": "show",
					onclick: () => actions.showMatch(caseId, a, m.current),
				},
				"Show",
			),
		);
	if (m.candidates.length > 1)
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
	about: HTMLSpanElement;
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
		placeholder: "What should change, as agreed?",
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
	const sizeText = h("span");
	const created: CaseParts = {
		current: c,
		title: h("h2"),
		meta: h("p", { class: "meta" }, page, about),
		page,
		about,
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
	);
	const verdictSection = h(
		"section",
		{},
		h("h2", {}, "Verdict"),
		verdict,
		h(
			"div",
			{ class: "row" },
			h(
				"button",
				{
					type: "button",
					id: "save-verdict",
					onclick: () => actions.saveVerdict(c.id, verdict.value),
				},
				"Save verdict",
			),
			verdictStatus,
		),
	);
	caseView.replaceChildren(
		header,
		created.marks,
		verdictSection,
		created.shots,
	);
	return created;
}

// --- a mark's status and its actions ---------------------------------------

/** "5 open, 2 fixed, 1 won't fix"; nothing while every mark is open. */
function markCounts(c: Case): HTMLElement | null {
	const resolved = c.annotations.filter((a) => a.resolution);
	if (resolved.length === 0) return null;
	const parts = [`${c.annotations.length - resolved.length} open`];
	for (const kind of RESOLUTION_KINDS) {
		const n = resolved.filter((a) => a.resolution?.kind === kind).length;
		if (n > 0) parts.push(`${n} ${RESOLUTION_LABEL[kind].toLowerCase()}`);
	}
	return h("p", { class: "meta mark-counts" }, parts.join(", "));
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
	// The verdict: what the store has, unless the user typed another.
	const draft = state.verdictDrafts.get(c.id);
	const verdict = draft ?? c.verdict ?? "";
	if (p.verdict.value !== verdict) p.verdict.value = verdict;
	p.verdictStatus.textContent =
		state.verdictStatus ?? (draft === undefined ? "" : "Not saved yet");

	p.title.textContent = c.title;
	const web = isWebPage(c.page.url);
	p.page.hidden = !web;
	p.page.textContent = web ? shortUrl(c.page.url) : "";
	p.about.textContent = `${web ? "" : c.page.url}, ${sizeOf(c.page.viewport)}, ${formatDate(c.createdAt)}`;
	const size = state.tab?.size;
	p.size.hidden = size === undefined || sameSize(size, c.page.viewport);
	p.sizeText.textContent = size
		? `This tab is ${sizeOf(size)}, the marks were made at ${sizeOf(c.page.viewport)}. `
		: "";
	setHint(
		p.origin,
		c.importedAt === undefined
			? undefined
			: `Imported from a file on ${formatDate(c.importedAt)}. Its comments and verdict are whoever wrote the file's, whatever author they name.`,
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
	const marksKey = JSON.stringify([
		c.updatedAt,
		images?.version,
		loaded ? [...loaded.matches.values()] : null,
		// What is typed stays out: a key press redraws nothing.
		edit ? [edit.annotationId, edit.mode] : null,
		markArmed ?? null,
	]);
	if (marksKey !== p.marksKey) {
		const list = h("ol", { class: "annotations" });
		for (const a of [...c.annotations].sort((x, y) => x.number - y.number)) {
			const crop = images?.urls.get(a.crop);
			const m = loaded?.matches.get(a.id);
			list.append(
				h(
					"li",
					{
						class: "annotation",
						"data-annotation": a.id,
						...(m ? { "data-colour": colourOf(m) } : {}),
						...(a.resolution ? { "data-resolved": a.resolution.kind } : {}),
					},
					h("span", { class: "number" }, String(a.number)),
					h(
						"div",
						{ class: "body" },
						h(
							"div",
							{ class: "head" },
							h(
								"span",
								{ class: a.comment ? "comment" : "comment none" },
								a.comment || "No comment",
							),
							a.author === "ai" ? h("span", { class: "tag" }, "AI") : null,
						),
						crop ? h("img", { src: crop, alt: `Mark ${a.number}` }) : null,
						a.resolution ? resolutionLine(a) : null,
						a.element ? h("p", { class: "meta" }, summarize(a.element)) : null,
						m ? matchView(c.id, a, m, actions) : null,
						edit?.annotationId === a.id
							? edit.mode === "resolve"
								? resolveForm(c, a, edit.kind, edit.text, actions)
								: commentForm(c, a, edit.text, actions)
							: markActions(c, a, markArmed === a.id, actions),
					),
				),
			);
		}
		const marks = h(
			"section",
			{},
			h("h2", {}, `Marks (${c.annotations.length})`),
			markCounts(c),
			list,
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
		const shots = h("section", {}, h("h2", {}, "Screenshots"), list);
		p.shots.replaceWith(shots);
		p.shots = shots;
		p.shotsKey = shotsKey;
	}
}

// --- the AI app ------------------------------------------------------------------

function callText(call: AiCall): string {
	const time = new Date(call.at).toLocaleTimeString();
	return `Last AI call: ${call.tool}, by ${call.app}, at ${time}`;
}

function renderAi({ ai }: PanelState): void {
	aiStatus.textContent = ai.status;
	bar.dataset["ai"] = ai.connected
		? "connected"
		: ai.active
			? "waiting"
			: "off";
	stopAi.hidden = !ai.active;
	keepOn.checked = ai.keepOn;
	setHint(aiCall, ai.lastCall && callText(ai.lastCall));
	connectButton.textContent = ai.connected
		? "AI connection…"
		: "Connect AI app";
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
