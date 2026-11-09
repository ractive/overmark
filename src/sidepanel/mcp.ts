/**
 * The side panel's connection to an AI app: `TabMcp` (DEC-004) with
 * Overmark's tools, over a relay the user sets.
 */

import { type DisconnectDetail, TabMcp } from "@ractive-ch/tab-mcp-client";
import { cropImages, scaleImage, toWebp } from "../lib/images.ts";
import type {
	TabCapture,
	WorkerRequest,
	WorkerResponse,
} from "../lib/messages.ts";
import type { CaseStore } from "../lib/store.ts";
import { NoAccessError, sendToTab } from "../lib/tabs.ts";
import { Latest } from "./state.ts";
import {
	confirmRequestFor,
	createTools,
	INSTRUCTIONS,
	type TabBridge,
} from "./tools.ts";

/** The hosted relay, which allows the development build's ID. */
export const DEFAULT_RELAY = "https://tab-mcp.ractive.ch";

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

/** An access problem gets a hint for the AI app; other errors stay as they are. */
function captureError(message: string): Error {
	return /permission|cannot access|activeTab|all_urls/i.test(message)
		? new Error(
				`Overmark may not take a screenshot of this tab (${message}). The user can click the Overmark icon on the tab, or turn on "Allow on all sites" in the side panel.`,
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
	async send(tabId, request) {
		try {
			return await sendToTab(tabId, request);
		} catch (error) {
			throw error instanceof NoAccessError
				? captureError(error.message)
				: error;
		}
	},
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

/** The waits between tries to connect, in ms; the last one repeats. */
const KEEP_ON_DELAYS_MS = [5000, 10_000, 20_000, 40_000, 60_000];

/** The part of `TabMcp` that `KeepOn` uses. */
export type KeptConnection = EventTarget &
	Pick<TabMcp, "state" | "reconnecting" | "connect">;

/**
 * "Keep AI access on": the library reconnects by itself only after a broken
 * connection. While `wanted` says so, this also connects after an idle or
 * expired session, and goes on trying after a connect that failed. It leaves
 * alone what the user or another tab ended (`disconnect()`, `replaced`).
 */
export class KeepOn {
	/** Why the last try failed; `undefined` once connected or stopped. */
	problem: string | undefined;
	readonly #wanted: () => boolean;
	readonly #changed: () => void;
	readonly #delaysMs: readonly number[];
	readonly #tries = new Latest();
	#connection: KeptConnection | undefined;
	#listening = new AbortController();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#failures = 0;

	/** `changed` is called when `problem` or `retrying` changed. */
	constructor(
		wanted: () => boolean,
		changed: () => void,
		delaysMs: readonly number[] = KEEP_ON_DELAYS_MS,
	) {
		this.#wanted = wanted;
		this.#changed = changed;
		this.#delaysMs = delaysMs;
	}

	/** A next try is waiting for its time. */
	get retrying(): boolean {
		return this.#timer !== undefined;
	}

	/** Look after `connection` instead of the one before. */
	watch(connection: KeptConnection): void {
		this.#listening.abort();
		this.#listening = new AbortController();
		this.stop();
		this.#connection = connection;
		const { signal } = this.#listening;
		connection.addEventListener(
			"disconnected",
			(event) => {
				const { reason } = (event as CustomEvent<DisconnectDetail>).detail;
				if (reason === "idle" || reason === "expired") this.connect();
			},
			{ signal },
		);
		connection.addEventListener("connected", () => this.stop(), { signal });
		// The library gave up reconnecting: the relay refused an attempt.
		connection.addEventListener(
			"error",
			(event) => {
				if (connection.state === "disconnected")
					this.failed((event as CustomEvent<{ error: Error }>).detail.error);
			},
			{ signal },
		);
	}

	/** Connect if wanted and nothing is on its way. */
	connect(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		const connection = this.#connection;
		if (
			connection === undefined ||
			!this.#wanted() ||
			connection.state !== "disconnected" ||
			connection.reconnecting !== undefined
		)
			return;
		const attempt = this.#tries.start();
		connection.connect({ resume: true }).catch((error: unknown) => {
			if (attempt.current()) this.failed(error);
		});
	}

	/** A connect failed: say why and, if wanted, try again later. */
	failed(error: unknown): void {
		this.problem = error instanceof Error ? error.message : String(error);
		const replaced = (error as { reason?: string }).reason === "replaced";
		if (this.#wanted() && !replaced) {
			const delay = this.#delaysMs[this.#failures] ?? this.#delaysMs.at(-1);
			this.#failures++;
			clearTimeout(this.#timer);
			this.#timer = setTimeout(() => this.connect(), delay);
		}
		this.#changed();
	}

	/** Forget the tries so far; one still running no longer counts. */
	stop(): void {
		this.#tries.cancel();
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#failures = 0;
		this.problem = undefined;
		this.#changed();
	}
}
