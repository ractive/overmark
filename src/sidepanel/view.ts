/**
 * Drawing the side panel from its state (DEC-011). `render` is the only code
 * that touches the panel's DOM. Parts that hold what the user types (the
 * verdict) stay the same elements while their case is open, so typing, focus
 * and cursor survive every render; the other parts are redrawn when what they
 * show changed.
 */

import { type Annotation, type Case, MAX_VERDICT } from "../lib/case.ts";
import { summarize } from "../lib/element.ts";
import type { AnnotationMatch } from "../lib/messages.ts";
import { byId, formatDate, h, samePath, shortUrl } from "./dom.ts";
import type { PanelState } from "./state.ts";

/** What the user can do; main.ts carries it out and updates the state. */
export interface Actions {
	toggleAnnotate(): void;
	openCase(id: string): void;
	closeCase(): void;
	loadOntoTab(c: Case): void;
	addMarks(c: Case): void;
	exportCase(c: Case): void;
	deleteCase(c: Case): void;
	saveVerdict(caseId: string, text: string): void;
	showMatch(caseId: string, a: Annotation, candidate: number): void;
	importReplace(): void;
	importCopy(): void;
	importCancel(): void;
}

const home = byId<HTMLElement>("home");
const caseView = byId<HTMLElement>("case-view");
const pageText = byId<HTMLParagraphElement>("page");
const hint = byId<HTMLParagraphElement>("hint");
const annotate = byId<HTMLButtonElement>("annotate");
const casesList = byId<HTMLDivElement>("cases");
const importPrompt = h("div", {
	class: "hint",
	id: "import-prompt",
	hidden: true,
});
byId<HTMLButtonElement>("import").parentElement?.after(importPrompt);

const percent = (score: number) => `${Math.round(score * 100)}%`;

function setHint(el: HTMLElement, text: string | undefined): void {
	el.hidden = text === undefined;
	el.textContent = text ?? "";
}

// --- home ----------------------------------------------------------------------

function caseItem(c: Case, actions: Actions): HTMLLIElement {
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
			h(
				"span",
				{ class: "meta" },
				`${shortUrl(c.page.url)} · ${count} mark${count === 1 ? "" : "s"} · ${formatDate(c.updatedAt)}`,
			),
			c.verdict
				? h("span", { class: "meta" }, `Verdict: ${c.verdict.slice(0, 80)}`)
				: null,
		),
	);
}

function renderHome(state: PanelState, actions: Actions): void {
	const tab = state.tab;
	pageText.textContent = tab?.url
		? shortUrl(tab.url)
		: (tab?.title ?? "This page");
	setHint(hint, state.hint);
	annotate.textContent = state.overlay?.visible
		? "Stop annotating"
		: "Annotate this page";
	if (state.cases.length === 0) {
		casesList.replaceChildren(
			h("p", { class: "empty" }, "No cases yet. Annotate a page and save it."),
		);
	} else {
		const url = tab?.url ?? "";
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
						h(
							"p",
							{ class: "group-title" },
							here.length > 0 ? "Other pages" : "All cases",
						),
						h(
							"ul",
							{ class: "cases", "data-group": "other" },
							...other.map((c) => caseItem(c, actions)),
						),
					]
				: []),
		);
	}
	const importing = state.importing;
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

// --- one case ------------------------------------------------------------------

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

function matchView(
	caseId: string,
	a: Annotation,
	m: AnnotationMatch,
	actions: Actions,
): HTMLElement {
	const shown = m.candidates[m.current];
	const box = h(
		"div",
		{
			class: `match ${m.status}`,
			id: `match-${a.id}`,
			"data-status": m.status,
		},
		h("span", { class: "status" }, matchText(m)),
		shown
			? h(
					"p",
					{ class: "meta" },
					`${shown.summary}${shown.visible ? "" : " · hidden at this width"}`,
				)
			: null,
	);
	const buttons = h("div", { class: "row" });
	if (m.candidates.length > 0)
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
	if (buttons.childElementCount > 0) box.append(buttons);
	return box;
}

/** The parts of the open case's view, kept between renders. */
interface CaseParts {
	caseId: string;
	header: HTMLElement;
	verdict: HTMLTextAreaElement;
	verdictStatus: HTMLSpanElement;
	marks: HTMLElement;
	marksKey: string;
	shots: HTMLElement;
	shotsKey: string;
}

let parts: CaseParts | undefined;

function createParts(c: Case, actions: Actions): CaseParts {
	const verdict = h("textarea", {
		id: "verdict",
		placeholder: "What should change, as agreed?",
		maxlength: String(MAX_VERDICT),
		"data-case": c.id,
	});
	verdict.value = c.verdict ?? "";
	verdict.dataset["saved"] = c.verdict ?? "";
	const verdictStatus = h("span", { class: "meta", id: "verdict-status" });
	const created: CaseParts = {
		caseId: c.id,
		header: h("section"),
		verdict,
		verdictStatus,
		marks: h("section"),
		marksKey: "",
		shots: h("section"),
		shotsKey: "",
	};
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
		created.header,
		verdictSection,
		created.marks,
		created.shots,
	);
	return created;
}

function renderCase(state: PanelState, actions: Actions): void {
	const c = state.current;
	if (c === undefined) {
		parts = undefined;
		caseView.replaceChildren(h("p", { class: "meta" }, "Loading…"));
		return;
	}
	if (parts?.caseId !== c.id) parts = createParts(c, actions);
	const p = parts;
	// The verdict: what the store has, unless the user is typing another.
	const typing = p.verdict.value !== p.verdict.dataset["saved"];
	p.verdict.dataset["saved"] = c.verdict ?? "";
	if (!typing) p.verdict.value = c.verdict ?? "";
	p.verdictStatus.textContent = state.verdictStatus ?? "";

	const header = h(
		"section",
		{ class: "case-header" },
		h(
			"button",
			{ type: "button", class: "link", onclick: () => actions.closeCase() },
			"← All cases",
		),
		h("h2", {}, c.title),
		h(
			"p",
			{ class: "meta" },
			`${shortUrl(c.page.url)} · ${c.page.viewport.width}×${c.page.viewport.height} · ${formatDate(c.createdAt)}`,
		),
		h(
			"div",
			{ class: "row" },
			h(
				"button",
				{
					type: "button",
					class: "primary",
					id: "load-case",
					onclick: () => actions.loadOntoTab(c),
				},
				"Load onto this tab",
			),
			h(
				"button",
				{ type: "button", id: "add-marks", onclick: () => actions.addMarks(c) },
				"Add marks",
			),
			h(
				"button",
				{
					type: "button",
					id: "export-case",
					onclick: () => actions.exportCase(c),
				},
				"Export",
			),
			h(
				"button",
				{
					type: "button",
					class: "danger",
					id: "delete-case",
					"data-armed": state.deleteArmed ? "true" : false,
					onclick: () => actions.deleteCase(c),
				},
				state.deleteArmed ? "Really delete?" : "Delete",
			),
		),
		h(
			"p",
			{ class: "hint", id: "case-hint", hidden: state.caseHint === undefined },
			state.caseHint ?? "",
		),
	);
	p.header.replaceWith(header);
	p.header = header;

	const images = state.images?.caseId === c.id ? state.images : undefined;
	const loaded = state.loaded?.caseId === c.id ? state.loaded : undefined;
	const marksKey = JSON.stringify([
		c.updatedAt,
		images?.version,
		loaded ? [...loaded.matches.values()] : null,
	]);
	if (marksKey !== p.marksKey) {
		const list = h("ol", { class: "annotations" });
		for (const a of [...c.annotations].sort((x, y) => x.number - y.number)) {
			const crop = images?.urls.get(a.crop);
			const m = loaded?.matches.get(a.id);
			list.append(
				h(
					"li",
					{ class: "annotation", "data-annotation": a.id },
					h(
						"div",
						{ class: "head" },
						h("span", { class: "number" }, String(a.number)),
						h(
							"span",
							{ class: a.comment ? "comment" : "comment none" },
							a.comment || "No comment",
						),
						a.author === "ai" ? h("span", { class: "tag" }, "AI") : null,
					),
					crop ? h("img", { src: crop, alt: `Mark ${a.number}` }) : null,
					a.element ? h("p", { class: "meta" }, summarize(a.element)) : null,
					m ? matchView(c.id, a, m, actions) : null,
				),
			);
		}
		const marks = h(
			"section",
			{},
			h("h2", {}, `Marks (${c.annotations.length})`),
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

/** Draw the panel from `state`. */
export function render(state: PanelState, actions: Actions): void {
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
