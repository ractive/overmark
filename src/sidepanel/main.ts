/**
 * The side panel: the tab in front and the overlay's switch.
 */

import type { OverlayState } from "../lib/messages.ts";
import { NoAccessError, sendToTab } from "../lib/tabs.ts";

function element<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (found === null) throw new Error(`#${id} missing`);
	return found as T;
}

const pageText = element<HTMLParagraphElement>("page");
const hint = element<HTMLParagraphElement>("hint");
const annotate = element<HTMLButtonElement>("annotate");

let overlayVisible = false;

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
	const win = await chrome.windows.getCurrent();
	const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
	return tab;
}

function showHint(text: string | undefined): void {
	hint.hidden = text === undefined;
	hint.textContent = text ?? "";
}

function render(state: OverlayState | undefined): void {
	overlayVisible = state?.visible ?? false;
	annotate.textContent = overlayVisible
		? "Stop annotating"
		: "Annotate this page";
}

async function refresh(): Promise<void> {
	const tab = await activeTab();
	pageText.textContent = tab?.url ?? tab?.title ?? "This page";
	showHint(undefined);
	if (tab?.id === undefined) return render(undefined);
	try {
		render(
			(await chrome.tabs.sendMessage(tab.id, {
				type: "overlay:state",
			})) as OverlayState,
		);
	} catch {
		render(undefined); // not injected yet
	}
}

annotate.addEventListener("click", async () => {
	const tab = await activeTab();
	if (tab?.id === undefined) return;
	try {
		render(
			await sendToTab(tab.id, {
				type: overlayVisible ? "overlay:hide" : "overlay:show",
			}),
		);
		showHint(undefined);
	} catch (error) {
		showHint(
			error instanceof NoAccessError
				? "Overmark may not run on this tab yet. Click the Overmark icon in the toolbar (or press Alt+Shift+O) while this tab is in front."
				: `Could not reach the page: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
});

chrome.tabs.onActivated.addListener(() => void refresh());
chrome.tabs.onUpdated.addListener((_id, info) => {
	if (info.status === "complete" || info.url !== undefined) void refresh();
});

void refresh();
