/**
 * The side panel: the tab in front, annotating it, and the saved cases.
 */

import { type Annotation, type Case, nextNumbers } from "../lib/case.ts";
import { summarize } from "../lib/element.ts";
import { exportCase, exportFileName, importCase } from "../lib/export.ts";
import type {
	AnnotationMatch,
	Broadcast,
	LoadResult,
	OverlayState,
} from "../lib/messages.ts";
import { IdbStore } from "../lib/store.ts";
import { NoAccessError, sendToTab } from "../lib/tabs.ts";
import { byId, formatDate, h, samePath, shortUrl } from "./dom.ts";
import { createConnection, DEFAULT_RELAY, validRelay } from "./mcp.ts";

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
	renderOverlay();
	await renderCases();
}

importButton.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
	const file = importFile.files?.[0];
	importFile.value = "";
	if (file === undefined) return;
	try {
		const c = await importCase(store, new Uint8Array(await file.arrayBuffer()));
		await openCase(c.id);
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
	switch (m.status) {
		case "found":
			return `Found here (${percent(m.score)})`;
		case "probable":
			return `Probably here (${percent(m.score)})`;
		case "ambiguous":
			return `Unsure: candidate ${m.current + 1} of ${m.candidates.length}`;
		case "lost":
			return "Not found on this page";
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
		if (m === null) return;
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
		const result = await sendToTab<LoadResult>(tab.id, {
			type: "case:load",
			case: c,
		});
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

// --- AI app ----------------------------------------------------------------

/** A tool changed or deleted a case: show it. */
function caseChanged(caseId: string): void {
	if (openCaseId === caseId) void openCase(caseId);
	else void renderCases();
}

let mcp = createConnection(
	readSetting(RELAY_KEY) ?? DEFAULT_RELAY,
	store,
	caseChanged,
);
relayInput.value = readSetting(RELAY_KEY) ?? DEFAULT_RELAY;
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
					: "Not connected";
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
	if (!validRelay(value)) {
		relayInput.setCustomValidity("An http(s) or ws(s) address");
		relayInput.reportValidity();
		return;
	}
	relayInput.setCustomValidity("");
	writeSetting(RELAY_KEY, value);
	mcp.disconnect();
	mcp = createConnection(value, store, caseChanged);
	watch(mcp);
	renderAi();
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
	if (sender.id !== chrome.runtime.id || message?.type !== "cases:changed")
		return false;
	if (openCaseId === message.caseId) void openCase(message.caseId);
	else void renderCases();
	void refreshTab();
	return false;
});

chrome.tabs.onActivated.addListener(() => void refreshTab());
chrome.tabs.onUpdated.addListener((_id, info) => {
	if (info.status === "complete" || info.url !== undefined) void refreshTab();
});

void refreshTab();
