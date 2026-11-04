/**
 * The side panel: the tab in front, annotating it, and the saved cases.
 */

import { type Annotation, type Case, nextNumbers } from "../lib/case.ts";
import { summarize } from "../lib/element.ts";
import {
	exportCase,
	exportFileName,
	MAX_IMPORT_BYTES,
	type ParsedExport,
	readExport,
	storeImport,
} from "../lib/export.ts";
import type {
	AnnotationMatch,
	Broadcast,
	LoadResult,
	OverlayState,
} from "../lib/messages.ts";
import { IdbStore } from "../lib/store.ts";
import { NoAccessError, sendToTab } from "../lib/tabs.ts";
import { byId, formatDate, h, samePath, shortUrl } from "./dom.ts";

const store = new IdbStore();

const home = byId<HTMLElement>("home");
const caseView = byId<HTMLElement>("case-view");
const pageText = byId<HTMLParagraphElement>("page");
const hint = byId<HTMLParagraphElement>("hint");
const annotate = byId<HTMLButtonElement>("annotate");
const blurForms = byId<HTMLInputElement>("blur-forms");
const casesList = byId<HTMLDivElement>("cases");
const importButton = byId<HTMLButtonElement>("import");
const importFile = byId<HTMLInputElement>("import-file");

const BLUR_KEY = "overmark:blur-forms";

let overlay: OverlayState | undefined;
let tabUrl = "";
let openCaseId: string | undefined;
let objectUrls: string[] = [];
/** The case loaded onto a tab, and where its marks were found there. */
let loaded:
	| { caseId: string; tabId: number; matches: Map<string, AnnotationMatch> }
	| undefined;

function readSetting(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeSetting(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Storage blocked: the setting lasts until the panel closes.
	}
}

blurForms.checked = readSetting(BLUR_KEY) === "true";
blurForms.addEventListener("change", () =>
	writeSetting(BLUR_KEY, String(blurForms.checked)),
);

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
	const win = await chrome.windows.getCurrent();
	const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
	return tab;
}

function showHint(text: string | undefined): void {
	hint.hidden = text === undefined;
	hint.textContent = text ?? "";
}

function describeError(error: unknown): string {
	return error instanceof NoAccessError
		? "Overmark may not run on this tab yet. Click the Overmark icon in the toolbar (or press Alt+Shift+O) while this tab is in front."
		: `Could not reach the page: ${error instanceof Error ? error.message : String(error)}`;
}

function renderOverlay(): void {
	const on = overlay?.visible ?? false;
	annotate.textContent = on ? "Stop annotating" : "Annotate this page";
}

/** Show the overlay on the tab in front, optionally to add to a case. */
async function startAnnotating(target?: Case): Promise<void> {
	const tab = await activeTab();
	if (tab?.id === undefined) return;
	try {
		const next = nextNumbers(target);
		overlay = await sendToTab(tab.id, {
			type: "overlay:show",
			blurForms: blurForms.checked,
			...(target
				? {
						target: {
							caseId: target.id,
							title: target.title,
							nextAnnotation: next.annotation,
							nextShot: next.shot,
						},
					}
				: {}),
		});
		showHint(undefined);
	} catch (error) {
		showHint(describeError(error));
	}
	renderOverlay();
}

annotate.addEventListener("click", async () => {
	if (overlay?.visible) {
		const tab = await activeTab();
		if (tab?.id === undefined) return;
		try {
			overlay = await sendToTab(tab.id, { type: "overlay:hide" });
		} catch (error) {
			showHint(describeError(error));
		}
		renderOverlay();
		return;
	}
	await startAnnotating();
});

async function refreshTab(): Promise<void> {
	const tab = await activeTab();
	tabUrl = tab?.url ?? "";
	pageText.textContent = tab?.url
		? shortUrl(tab.url)
		: (tab?.title ?? "This page");
	showHint(undefined);
	overlay = undefined;
	if (tab?.id !== undefined) {
		try {
			overlay = (await chrome.tabs.sendMessage(tab.id, {
				type: "overlay:state",
			})) as OverlayState;
		} catch {
			// Not injected on this page yet.
		}
	}
	if (
		loaded !== undefined &&
		(tab?.id !== loaded.tabId || overlay?.loadedCase !== loaded.caseId)
	)
		forgetLoaded();
	renderOverlay();
	await renderCases();
}

/** The loaded case's results no longer describe the tab: drop them. */
function forgetLoaded(): void {
	const caseId = loaded?.caseId;
	loaded = undefined;
	if (caseId !== undefined && openCaseId === caseId) void openCase(caseId);
}

importButton.addEventListener("click", () => importFile.click());
const importPrompt = h("div", {
	class: "hint",
	id: "import-prompt",
	hidden: true,
});
importButton.parentElement?.after(importPrompt);

async function finishImport(
	parsed: ParsedExport,
	options: { copy?: boolean } = {},
): Promise<void> {
	importPrompt.hidden = true;
	importPrompt.replaceChildren();
	const c = await storeImport(store, parsed, options);
	await openCase(c.id);
}

/** Ask before an import replaces a case that is here already. */
function askReplace(parsed: ParsedExport, existing: Case): void {
	const fail = (error: unknown) =>
		showHint(
			`Could not import: ${error instanceof Error ? error.message : String(error)}`,
		);
	importPrompt.replaceChildren(
		h(
			"p",
			{},
			`“${existing.title}” is here already (changed ${formatDate(existing.updatedAt)}); the file's copy was changed ${formatDate(parsed.case.updatedAt)}.`,
		),
		h(
			"div",
			{ class: "row" },
			h(
				"button",
				{
					type: "button",
					"data-action": "import-replace",
					onclick: () => void finishImport(parsed).catch(fail),
				},
				"Replace it",
			),
			h(
				"button",
				{
					type: "button",
					"data-action": "import-copy",
					onclick: () => void finishImport(parsed, { copy: true }).catch(fail),
				},
				"Keep both",
			),
			h(
				"button",
				{
					type: "button",
					onclick: () => {
						importPrompt.hidden = true;
						importPrompt.replaceChildren();
					},
				},
				"Cancel",
			),
		),
	);
	importPrompt.hidden = false;
}

importFile.addEventListener("change", async () => {
	const file = importFile.files?.[0];
	importFile.value = "";
	if (file === undefined) return;
	showHint(undefined);
	try {
		if (file.size > MAX_IMPORT_BYTES)
			throw new Error(`it is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB`);
		const parsed = await readExport(new Uint8Array(await file.arrayBuffer()));
		const existing = await store.getCase(parsed.case.id);
		if (existing !== undefined) askReplace(parsed, existing);
		else await finishImport(parsed);
	} catch (error) {
		showHint(
			`Could not import ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
});

// --- cases -----------------------------------------------------------------

function caseItem(c: Case): HTMLLIElement {
	const count = c.annotations.length;
	return h(
		"li",
		{},
		h(
			"button",
			{ type: "button", "data-case": c.id, onclick: () => void openCase(c.id) },
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

async function renderCases(): Promise<void> {
	const cases = await store.listCases();
	if (cases.length === 0) {
		casesList.replaceChildren(
			h("p", { class: "empty" }, "No cases yet. Annotate a page and save it."),
		);
		return;
	}
	const here = cases.filter((c) => tabUrl && samePath(c.page.url, tabUrl));
	const other = cases.filter((c) => !here.includes(c));
	casesList.replaceChildren(
		...(here.length > 0
			? [
					h("p", { class: "group-title" }, "For this page"),
					h(
						"ul",
						{ class: "cases", "data-group": "here" },
						...here.map(caseItem),
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
						...other.map(caseItem),
					),
				]
			: []),
	);
}

function releaseImages(): void {
	for (const url of objectUrls) URL.revokeObjectURL(url);
	objectUrls = [];
}

async function imageUrl(
	caseId: string,
	path: string,
): Promise<string | undefined> {
	const image = await store.getImage(caseId, path);
	if (image === undefined) return undefined;
	const url = URL.createObjectURL(image.blob);
	objectUrls.push(url);
	return url;
}

const percent = (score: number) => `${Math.round(score * 100)}%`;

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

function matchView(a: Annotation): HTMLElement | null {
	if (loaded === undefined) return null;
	const m = loaded.matches.get(a.id);
	if (m === undefined) return null;
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
					onclick: () => void showMatch(a, m.current),
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
					onclick: () => void showMatch(a, m.current + 1),
				},
				"Next candidate",
			),
		);
	if (buttons.childElementCount > 0) box.append(buttons);
	return box;
}

async function showMatch(a: Annotation, candidate: number): Promise<void> {
	if (loaded === undefined) return;
	try {
		const m = (await chrome.tabs.sendMessage(loaded.tabId, {
			type: "case:show",
			annotationId: a.id,
			candidate,
		})) as AnnotationMatch | null;
		if (m === null) {
			forgetLoaded();
			showCaseHint(
				"The case is no longer loaded on that tab. Load it again to see its marks there.",
			);
			return;
		}
		loaded.matches.set(a.id, m);
		const view = matchView(a);
		if (view) document.getElementById(`match-${a.id}`)?.replaceWith(view);
	} catch (error) {
		showCaseHint(describeError(error));
	}
}

function showCaseHint(text: string | undefined): void {
	const hintEl = document.getElementById("case-hint");
	if (hintEl === null) return;
	hintEl.hidden = text === undefined;
	hintEl.textContent = text ?? "";
}

async function loadOntoTab(c: Case): Promise<void> {
	const tab = await activeTab();
	if (tab?.id === undefined) return;
	try {
		const result = await sendToTab<LoadResult | { error: string }>(tab.id, {
			type: "case:load",
			case: c,
		});
		if ("error" in result) throw new Error(result.error);
		loaded = {
			caseId: c.id,
			tabId: tab.id,
			matches: new Map(result.matches.map((m) => [m.annotationId, m])),
		};
		await openCase(c.id);
		const found = result.matches.filter(
			(m) => m.status !== "lost" && m.status !== "no-element",
		).length;
		showCaseHint(
			`${found} of ${result.matches.length} marks found on ${shortUrl(result.url)}. Outlines: green found, amber dashed probable or unsure.`,
		);
	} catch (error) {
		showCaseHint(describeError(error));
	}
}

async function download(c: Case): Promise<void> {
	try {
		const zip = await exportCase(store, c);
		const url = URL.createObjectURL(
			new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
		);
		const link = h("a", { href: url, download: exportFileName(c) });
		document.body.append(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 30_000);
	} catch (error) {
		showCaseHint(
			`Could not export: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function openCase(id: string): Promise<void> {
	const c = await store.getCase(id);
	if (c === undefined) return closeCase();
	openCaseId = id;
	releaseImages();
	const verdict = h("textarea", {
		id: "verdict",
		placeholder: "What should change, as agreed?",
	});
	verdict.value = c.verdict ?? "";
	const saveVerdict = h(
		"button",
		{ type: "button", id: "save-verdict" },
		"Save verdict",
	);
	saveVerdict.addEventListener("click", async () => {
		const current = await store.getCase(id);
		if (current === undefined) return;
		const text = verdict.value.trim();
		await store.putCase({
			...current,
			verdict: text === "" ? null : text,
			updatedAt: new Date().toISOString(),
		});
		saveVerdict.textContent = "Saved";
		setTimeout(() => {
			saveVerdict.textContent = "Save verdict";
		}, 1500);
	});
	const del = h(
		"button",
		{ type: "button", class: "danger", id: "delete-case" },
		"Delete",
	);
	del.addEventListener("click", async () => {
		if (del.dataset["armed"] !== "true") {
			del.dataset["armed"] = "true";
			del.textContent = "Really delete?";
			return;
		}
		await store.deleteCase(id);
		closeCase();
	});
	const shots = h("div", { class: "shots" });
	for (const shot of c.shots) {
		const url = await imageUrl(c.id, shot.image);
		if (url) shots.append(h("img", { src: url, alt: `Screenshot ${shot.id}` }));
	}
	const list = h("ol", { class: "annotations" });
	for (const a of [...c.annotations].sort((x, y) => x.number - y.number)) {
		const crop = await imageUrl(c.id, a.crop);
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
				loaded?.caseId === c.id ? matchView(a) : null,
			),
		);
	}
	caseView.replaceChildren(
		h(
			"section",
			{ class: "case-header" },
			h(
				"button",
				{ type: "button", class: "link", onclick: () => closeCase() },
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
						onclick: () => void loadOntoTab(c),
					},
					"Load onto this tab",
				),
				h(
					"button",
					{
						type: "button",
						id: "add-marks",
						onclick: () => void startAnnotating(c),
					},
					"Add marks",
				),
				h(
					"button",
					{
						type: "button",
						id: "export-case",
						onclick: () => void download(c),
					},
					"Export",
				),
				del,
			),
			h("p", { class: "hint", id: "case-hint", hidden: true }),
		),
		h(
			"section",
			{},
			h("h2", {}, "Verdict"),
			verdict,
			h("div", { class: "row" }, saveVerdict),
		),
		h("section", {}, h("h2", {}, `Marks (${c.annotations.length})`), list),
		h("section", {}, h("h2", {}, "Screenshots"), shots),
	);
	home.hidden = true;
	caseView.hidden = false;
}

function closeCase(): void {
	openCaseId = undefined;
	releaseImages();
	caseView.replaceChildren();
	caseView.hidden = true;
	home.hidden = false;
	void renderCases();
}

chrome.runtime.onMessage.addListener((message: Broadcast, sender) => {
	if (sender.id !== chrome.runtime.id || message?.type !== "cases:changed")
		return false;
	if (openCaseId === message.caseId) void openCase(message.caseId);
	else void renderCases();
	void refreshTab();
	return false;
});

chrome.tabs.onActivated.addListener(() => void refreshTab());
chrome.tabs.onUpdated.addListener((id, info) => {
	if (id === loaded?.tabId && info.status === "loading") forgetLoaded();
	if (info.status === "complete" || info.url !== undefined) void refreshTab();
});
chrome.tabs.onRemoved.addListener((id) => {
	if (id === loaded?.tabId) forgetLoaded();
});

void refreshTab();
