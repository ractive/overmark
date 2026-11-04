/**
 * The service worker: a click on the icon (or Alt+Shift+O) opens the side
 * panel and injects the content script into that tab. The click is what
 * grants `activeTab` for the tab.
 */

import { inject } from "./lib/tabs.ts";

chrome.action.onClicked.addListener((tab) => {
	if (tab.id === undefined) return;
	// `sidePanel.open` needs the click's user gesture: call it before any await.
	void chrome.sidePanel
		.open({ windowId: tab.windowId })
		.catch((error: unknown) => console.warn("Overmark: side panel", error));
	void inject(tab.id).catch((error: unknown) =>
		console.warn("Overmark: cannot run on this tab", error),
	);
});
