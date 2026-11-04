/**
 * The side panel's connection to an AI app: `TabMcp` (DEC-004) with
 * Overmark's tools, over a relay the user sets.
 */

import { TabMcp } from "@ractive-ch/tab-mcp-client";
import { cropImages, scaleImage, toWebp } from "../lib/images.ts";
import type { CaseStore } from "../lib/store.ts";
import { sendToTab } from "../lib/tabs.ts";
import { createTools, INSTRUCTIONS, type TabBridge } from "./tools.ts";

export const DEFAULT_RELAY = "http://localhost:8080";

/** The tab in front of this side panel's window. */
export const chromeTab: TabBridge = {
	async current() {
		const win = await chrome.windows.getCurrent();
		const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
		if (tab?.id === undefined || tab.windowId === undefined)
			throw new Error("No tab is in front.");
		return {
			id: tab.id,
			windowId: tab.windowId,
			url: tab.url ?? "",
			title: tab.title ?? "",
		};
	},
	send: (tabId, request) => sendToTab(tabId, request),
	async capture(windowId) {
		try {
			const url = await chrome.tabs.captureVisibleTab(windowId, {
				format: "png",
			});
			return await (await fetch(url)).blob();
		} catch (error) {
			throw new Error(
				`Overmark may not take a screenshot of this tab (${error instanceof Error ? error.message : String(error)}). The user can click the Overmark icon on the tab, or allow Overmark on all sites.`,
			);
		}
	},
};

/** Is `value` a relay address the library accepts? */
export function validRelay(value: string): boolean {
	try {
		const url = new URL(value);
		return ["http:", "https:", "ws:", "wss:"].includes(url.protocol);
	} catch {
		return false;
	}
}

export function createConnection(
	relay: string,
	store: CaseStore,
	onChange: (caseId: string) => void,
): TabMcp {
	const mcp = new TabMcp({
		relay,
		server: {
			name: "overmark",
			title: "Overmark",
			version: chrome.runtime.getManifest().version,
			instructions: INSTRUCTIONS,
			icons: [],
		},
		appName: "Overmark",
		// "Always allow" for adding marks and verdicts in a long session (per tool and app).
		alwaysAllow: true,
	});
	const tools = createTools({
		store,
		tab: chromeTab,
		images: { toWebp, scale: scaleImage, crop: cropImages },
		onChange,
	});
	for (const tool of tools) void mcp.registerTool(tool);
	return mcp;
}
