/**
 * The AI connection's settings, kept in the extension's storage (DEC-015):
 * the relay, "Keep AI access on", "Blur form fields in screenshots", a
 * takeover of the address, and whether AI access is on for this browser
 * session. Until the connection moved into the service worker they were in
 * the side panel's `localStorage`, which the worker cannot read; the panel
 * hands them over once (`migrate`).
 */

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

/** Keys in `chrome.storage.local`. */
export const KEYS = {
	relay: "relay",
	keepOn: "keepAiOn",
	blurForms: "blurForms",
	replaced: "replaced",
	/** The panel's `localStorage` settings were taken over (or there were none). */
	migrated: "migrated",
} as const;

/**
 * In `chrome.storage.session`: AI access is on until the browser closes, or
 * the extension is updated, reloaded or disabled.
 */
export const SESSION_ON = "aiOn";

/** What the settings need of a `chrome.storage` area. */
export interface Area {
	get(keys: string | string[] | null): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(keys: string | string[]): Promise<void>;
}

/**
 * Another tab or program took the address over (`replaced`): kept across
 * worker restarts, so a restart does not take the address back by itself.
 */
export interface Replaced {
	sibling: boolean;
}

export interface Settings {
	/** As stored; `undefined` for none. The connection checks it. */
	relay: string | undefined;
	keepOn: boolean;
	replaced: Replaced | undefined;
	migrated: boolean;
}

export async function loadSettings(area: Area): Promise<Settings> {
	const s = await area.get([
		KEYS.relay,
		KEYS.keepOn,
		KEYS.replaced,
		KEYS.migrated,
	]);
	const replaced = s[KEYS.replaced];
	return {
		relay:
			typeof s[KEYS.relay] === "string" ? (s[KEYS.relay] as string) : undefined,
		keepOn: s[KEYS.keepOn] === true,
		replaced:
			typeof replaced === "object" &&
			replaced !== null &&
			typeof (replaced as Replaced).sibling === "boolean"
				? { sibling: (replaced as Replaced).sibling }
				: undefined,
		migrated: s[KEYS.migrated] === true,
	};
}
