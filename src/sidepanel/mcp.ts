/**
 * The side panel's connection to an AI app: `TabMcp` (DEC-004) with
 * Overmark's tools, over a relay the user sets.
 */

import { TabMcp } from "@ractive-ch/tab-mcp-client";
import { cropImages, scaleImage, toWebp } from "../lib/images.ts";
import type {
	TabCapture,
	WorkerRequest,
	WorkerResponse,
} from "../lib/messages.ts";
import type { CaseStore } from "../lib/store.ts";
import { sendToTab } from "../lib/tabs.ts";
import {
	confirmRequestFor,
	createTools,
	INSTRUCTIONS,
	type TabBridge,
} from "./tools.ts";

export const DEFAULT_RELAY = "http://localhost:8080";

/** Hosts the library accepts over plain http: and ws:. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Why `value` is no relay address the library accepts, or `undefined`. */
export function relayProblem(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "Not an address.";
	}
	if (url.protocol === "https:" || url.protocol === "wss:") return undefined;
	if (url.protocol !== "http:" && url.protocol !== "ws:")
		return "Use an https: (or wss:) address.";
	return LOOPBACK.has(url.hostname)
		? undefined
		: "Plain http: works only for localhost; use https: for other hosts.";
}

/** Is `value` a relay address the library accepts? */
export function validRelay(value: string): boolean {
	return relayProblem(value) === undefined;
}

/** An access problem gets a hint for the AI app; other errors stay as they are. */
function captureError(message: string): Error {
	return /permission|cannot access|activeTab|all_urls/i.test(message)
		? new Error(
				`Overmark may not take a screenshot of this tab (${message}). The user can click the Overmark icon on the tab, or allow Overmark on all sites.`,
			)
		: new Error(message);
}

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
	async capture(tab) {
		// Through the worker: its queue keeps to Chrome's two captures a second,
		// and it checks that the tab is in front before and after.
		const request: WorkerRequest = {
			type: "capture:tab",
			tabId: tab.id,
			windowId: tab.windowId,
		};
		const response = (await chrome.runtime.sendMessage(request)) as
			| WorkerResponse<TabCapture>
			| undefined;
		if (response === undefined) throw new Error("Overmark did not answer.");
		if (!response.ok) throw captureError(response.error);
		return await (await fetch(response.dataUrl)).blob();
	},
};

export interface ConnectionOptions {
	/** A tool changed or deleted a case. */
	onChange: (caseId: string) => void;
	/** The side panel's "Blur form fields in screenshots". */
	blurForms: () => boolean;
}

/**
 * A connection to `relay`. Throws a `TypeError` for an address the library
 * refuses (`relayProblem` says why beforehand).
 */
export function createConnection(
	relay: string,
	store: CaseStore,
	options: ConnectionOptions,
): TabMcp {
	// No "Always allow" (DEC-008): the library offers it for every tool that
	// asks first or for none, and delete_case must ask every time.
	const mcp: TabMcp = new TabMcp({
		relay,
		server: {
			name: "overmark",
			title: "Overmark",
			version: chrome.runtime.getManifest().version,
			instructions: INSTRUCTIONS,
			icons: [],
		},
		appName: "Overmark",
		onConfirm: async (request) =>
			mcp.confirmInPage(await confirmRequestFor(store, chromeTab, request)),
	});
	const tools = createTools({
		store,
		tab: chromeTab,
		images: { toWebp, scale: scaleImage, crop: cropImages },
		onChange: options.onChange,
		blurForms: options.blurForms,
		maxMessageBytes: () => mcp.session?.limits.maxMessageBytes,
	});
	for (const tool of tools) void mcp.registerTool(tool);
	return mcp;
}
