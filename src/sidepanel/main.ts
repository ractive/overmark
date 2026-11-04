/**
 * The side panel: the tab in front, annotating it, and the saved cases.
 */

import type { TabMcp } from "@ractive-ch/tab-mcp-client";
import {
	type Annotation,
	type Case,
	MAX_VERDICT,
	nextNumbers,
	validateCase,
} from "../lib/case.ts";
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
import { createConnection, DEFAULT_RELAY, relayProblem } from "./mcp.ts";

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
const relayInput = byId<HTMLInputElement>("relay");
const connectButton = byId<HTMLButtonElement>("connect");
const aiStatus = byId<HTMLSpanElement>("ai-status");
const keepOn = byId<HTMLInputElement>("keep-on");

const BLUR_KEY = "overmark:blur-forms";
const RELAY_KEY = "overmark:relay";
const KEEP_ON_KEY = "overmark:keep-ai-on";

let overlay: OverlayState | undefined;
let tabUrl = "";
/** The tab the panel shows. */
let shownTabId: number | undefined;
/** Bumped by every newer piece of news, so an older `refreshTab()` drops its result. */
let generation = 0;
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
	generation++; // a refresh still running must not overwrite this
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
						},
					}
				: {}),
		});
		showHint(
			overlay?.saving
				? "Overmark is still saving the last marks on this page; the toolbar switches once that is done."
				: undefined,
		);
	} catch (error) {
		showHint(describeError(error));
	}
	renderOverlay();
}

/** The overlay's state on the tab, or `undefined` where it is not injected. */
async function overlayState(tabId: number): Promise<OverlayState | undefined> {
	try {
		return (await chrome.tabs.sendMessage(tabId, {
			type: "overlay:state",
		})) as OverlayState;
	} catch {
		return undefined;
	}
}

annotate.addEventListener("click", async () => {
	const tab = await activeTab();
	if (tab?.id === undefined) return;
	generation++; // a refresh still running must not overwrite this
	// Ask the page: the state may have changed while no panel was listening.
	overlay = await overlayState(tab.id);
	if (overlay?.visible) {
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
	const mine = ++generation;
	const tab = await activeTab();
	if (mine !== generation) return;
	shownTabId = tab?.id;
	tabUrl = tab?.url ?? "";
	pageText.textContent = tab?.url
		? shortUrl(tab.url)
		: (tab?.title ?? "This page");
	showHint(undefined);
	const state = tab?.id === undefined ? undefined : await overlayState(tab.id);
	if (mine !== generation) return;
	overlay = state;
	if (
		loaded !== undefined &&
		(tab?.id !== loaded.tabId || overlay?.loadedCase !== loaded.caseId)
	)
		void forgetLoaded();
	renderOverlay();
	await renderCases();
}

/**
 * The loaded case's results no longer describe the tab: drop them (and with
 * `clearTab`, the outlines too), show the case again, then `hint`.
 */
async function forgetLoaded(
	options: { hint?: string; clearTab?: boolean } = {},
): Promise<void> {
	const was = loaded;
	loaded = undefined;
	if (was !== undefined && options.clearTab)
		await chrome.tabs
			.sendMessage(was.tabId, { type: "case:clear" })
			.catch(() => undefined);
	if (was !== undefined && openCaseId === was.caseId)
		await openCase(was.caseId, options.hint);
	else if (options.hint !== undefined) showCaseHint(options.hint);
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
	// Results (and outlines) of the version it replaced describe other marks.
	if (loaded?.caseId === c.id) await forgetLoaded({ clearTab: true });
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

/** An object URL for a case's image, added to `urls` (one list per rendering). */
async function imageUrl(
	caseId: string,
	path: string,
	urls: string[],
): Promise<string | undefined> {
	const image = await store.getImage(caseId, path);
	if (image === undefined) return undefined;
	const url = URL.createObjectURL(image.blob);
	urls.push(url);
	return url;
}

/** Counts renderings of the case view, so a slower, older one gives up. */
let caseRender = 0;

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
			caseId: loaded.caseId,
			annotationId: a.id,
			candidate,
		})) as AnnotationMatch | null;
		if (m === null) {
			await forgetLoaded({
				hint: "The case is no longer loaded on that tab. Load it again to see its marks there.",
			});
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

/** Show a case, then `hint` under its buttons. */
async function openCase(id: string, hint?: string): Promise<void> {
	const render = ++caseRender;
	const c = await store.getCase(id);
	if (render !== caseRender) return;
	if (c === undefined) return closeCase();
	openCaseId = id;
	const urls: string[] = [];
	const verdict = h("textarea", {
		id: "verdict",
		placeholder: "What should change, as agreed?",
		maxlength: String(MAX_VERDICT),
		"data-case": id,
	});
	verdict.dataset["saved"] = c.verdict ?? "";
	verdict.value = c.verdict ?? "";
	const saveVerdict = h(
		"button",
		{ type: "button", id: "save-verdict" },
		"Save verdict",
	);
	saveVerdict.addEventListener("click", async () => {
		const text = verdict.value.trim();
		try {
			// One transaction, so marks saved meanwhile are kept.
			await store.updateCase(id, (current) => {
				if (current === undefined)
					throw new Error("The case no longer exists.");
				return {
					value: validateCase({
						...current,
						verdict: text === "" ? null : text,
						updatedAt: new Date().toISOString(),
					}),
				};
			});
			verdict.dataset["saved"] = text;
			verdict.value = text;
			saveVerdict.textContent = "Saved";
		} catch (error) {
			saveVerdict.textContent = `Not saved: ${error instanceof Error ? error.message : String(error)}`;
		}
		setTimeout(() => {
			saveVerdict.textContent = "Save verdict";
		}, 2500);
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
		const url = await imageUrl(c.id, shot.image, urls);
		if (url) shots.append(h("img", { src: url, alt: `Screenshot ${shot.id}` }));
	}
	const list = h("ol", { class: "annotations" });
	for (const a of [...c.annotations].sort((x, y) => x.number - y.number)) {
		const crop = await imageUrl(c.id, a.crop, urls);
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
	if (render !== caseRender) {
		// A newer rendering started while this one read the images.
		for (const url of urls) URL.revokeObjectURL(url);
		return;
	}
	// Keep a verdict being typed when the case is shown again (marks added
	// meanwhile): read it now, after the awaits, with the cursor where it was.
	const previous = caseView.querySelector<HTMLTextAreaElement>("#verdict");
	const typing =
		previous !== null &&
		previous.dataset["case"] === id &&
		previous.value !== previous.dataset["saved"]
			? {
					value: previous.value,
					focused: document.activeElement === previous,
					start: previous.selectionStart,
					end: previous.selectionEnd,
				}
			: undefined;
	if (typing !== undefined) verdict.value = typing.value;
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
	releaseImages();
	objectUrls = urls;
	home.hidden = true;
	caseView.hidden = false;
	if (typing?.focused) {
		verdict.focus();
		verdict.setSelectionRange(typing.start, typing.end);
	}
	if (hint !== undefined) showCaseHint(hint);
}

function closeCase(): void {
	caseRender++; // a rendering still reading images must not come back
	openCaseId = undefined;
	releaseImages();
	caseView.replaceChildren();
	caseView.hidden = true;
	home.hidden = false;
	void renderCases();
}

// --- AI app ----------------------------------------------------------------

/** A tool changed or deleted a case: show it. */
function caseChanged(caseId: string): void {
	if (openCaseId === caseId) void openCase(caseId);
	else void renderCases();
}

function connectTo(relay: string): TabMcp {
	return createConnection(relay, store, {
		onChange: caseChanged,
		blurForms: () => blurForms.checked,
	});
}

/** Shown while disconnected when the saved relay could not be used. */
let relayNote: string | undefined;
let relay = readSetting(RELAY_KEY) ?? DEFAULT_RELAY;
let mcp: TabMcp;
try {
	mcp = connectTo(relay);
} catch (error) {
	// A stored address the library refuses must not stop the panel.
	relayNote = `The saved relay ${relay} cannot be used (${error instanceof Error ? error.message : String(error)}); using ${DEFAULT_RELAY}.`;
	relay = DEFAULT_RELAY;
	mcp = connectTo(relay);
}
relayInput.value = relay;
keepOn.checked = readSetting(KEEP_ON_KEY) === "true";

function renderAi(): void {
	const grants = mcp.grants;
	const reconnecting = mcp.reconnecting;
	aiStatus.textContent =
		mcp.state === "connected"
			? grants.length > 0
				? `Connected: ${grants.map((g) => g.client.name).join(", ")}`
				: "Waiting for an AI app to pair"
			: mcp.state === "connecting"
				? "Connecting…"
				: reconnecting
					? "Connection lost, retrying…"
					: (relayNote ?? "Not connected");
	connectButton.textContent =
		mcp.state === "disconnected" ? "Connect AI app" : "AI connection…";
}

function watch(connection: typeof mcp): void {
	for (const type of [
		"statechange",
		"grantschange",
		"reconnecting",
		"disconnected",
	])
		connection.addEventListener(type, renderAi);
}
watch(mcp);
renderAi();

relayInput.addEventListener("change", () => {
	const value = relayInput.value.trim();
	const refuse = (problem: string) => {
		relayInput.setCustomValidity(problem);
		relayInput.reportValidity();
	};
	const problem = relayProblem(value);
	if (problem !== undefined) return refuse(problem);
	// Build the new connection first: the setting and the old connection
	// change only once it exists.
	let next: TabMcp;
	try {
		next = connectTo(value);
	} catch (error) {
		return refuse(error instanceof Error ? error.message : String(error));
	}
	relayInput.setCustomValidity("");
	writeSetting(RELAY_KEY, value);
	relayNote = undefined;
	mcp.disconnect();
	mcp = next;
	watch(mcp);
	renderAi();
	if (keepOn.checked)
		void mcp.connect({ resume: true }).catch(() => renderAi());
});

connectButton.addEventListener("click", () => {
	void mcp.showConnectDialog().catch((error: unknown) => {
		aiStatus.textContent = `Could not connect: ${error instanceof Error ? error.message : String(error)}`;
	});
});

keepOn.addEventListener("change", () =>
	writeSetting(KEEP_ON_KEY, String(keepOn.checked)),
);

if (keepOn.checked) void mcp.connect({ resume: true }).catch(() => renderAi());

chrome.runtime.onMessage.addListener((message: Broadcast, sender) => {
	if (sender.id !== chrome.runtime.id) return false;
	if (message?.type === "overlay:changed") {
		// The page's own Hide removed the loaded case's outlines.
		if (
			loaded !== undefined &&
			sender.tab?.id === loaded.tabId &&
			message.state.loadedCase !== loaded.caseId
		)
			void forgetLoaded();
		// From a content script; only the tab the panel shows matters.
		if (sender.tab?.id === undefined || sender.tab.id !== shownTabId)
			return false;
		generation++;
		overlay = message.state;
		renderOverlay();
	} else if (message?.type === "cases:changed") {
		if (openCaseId === message.caseId) void openCase(message.caseId);
		else void renderCases();
		void refreshTab();
	}
	return false;
});

chrome.tabs.onActivated.addListener(() => void refreshTab());
chrome.tabs.onUpdated.addListener((id, info) => {
	if (id === loaded?.tabId && info.status === "loading") void forgetLoaded();
	if (info.status === "complete" || info.url !== undefined) void refreshTab();
});
chrome.tabs.onRemoved.addListener((id) => {
	if (id === loaded?.tabId) void forgetLoaded();
});

void refreshTab();
