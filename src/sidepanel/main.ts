/**
 * The side panel: the tab in front, annotating it, and the saved cases.
 */

import { type Case, nextNumbers } from "../lib/case.ts";
import { summarize } from "../lib/element.ts";
import type { Broadcast, OverlayState } from "../lib/messages.ts";
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

const BLUR_KEY = "overmark:blur-forms";

let overlay: OverlayState | undefined;
let tabUrl = "";
let openCaseId: string | undefined;
let objectUrls: string[] = [];

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
						id: "add-marks",
						onclick: () => void startAnnotating(c),
					},
					"Add marks on this tab",
				),
				del,
			),
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
chrome.tabs.onUpdated.addListener((_id, info) => {
	if (info.status === "complete" || info.url !== undefined) void refreshTab();
});

void refreshTab();
