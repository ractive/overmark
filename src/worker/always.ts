/**
 * "Always allow" and "Allow all changes" (DEC-018, DEC-043): per AI app (its
 * grant), the tools the user answered a question with Always allow, or every
 * tool that changes something. The tab-mcp client library keeps them
 * (`allowedTools` of `@ractive-ch/tab-mcp-client/allowed`, its DEC-200) in
 * the storage Sitegloss passes it, beside the address secret
 * (`tab-mcp:secret:<relay origin>:sitegloss#allowed`, in the worker's
 * IndexedDB through `CachedSecretStorage`), and honours them before
 * Sitegloss's `onConfirm` is asked. They end with the app's grant, as the
 * relay reports it (Disconnect, Disconnect all apps, an expired grant), and
 * a tool allowed one by one asks again once its title or description
 * changed. This is the only store of them: Sitegloss keeps none of its own.
 */

import type { TabMcp } from "@ractive-ch/tab-mcp-client";
import {
	type AllowedTools,
	allowedTools,
} from "@ractive-ch/tab-mcp-client/allowed";
import type { Kv } from "./kv.ts";

/**
 * The key of Sitegloss's own store before DEC-043, in the settings database.
 * Removed at every worker start: its grants ended with client 0.17's new
 * addresses, so there is nothing in it to take over.
 */
export const OLD_ALWAYS_KEY = "alwaysAllowed";

/** Remove the store from before (DEC-043). */
export async function removeOldStore(kv: Kv): Promise<void> {
	await kv.remove(OLD_ALWAYS_KEY);
}

/** What runs without asking for one AI app. */
export interface AlwaysEntry {
	/** "Allow all changes": the library's "everything". */
	all: boolean;
	/** The tools always allowed one by one, by name, in the order allowed. */
	tools: string[];
}

/** The library's allowances of one `TabMcp`, in Sitegloss's words. */
export class AlwaysAllowed {
	readonly #allowed: AllowedTools;

	constructor(allowed: AllowedTools) {
		this.#allowed = allowed;
	}

	/** The allowances of `mcp`: one per `TabMcp`, the library's own object. */
	static of(mcp: TabMcp): AlwaysAllowed {
		return new AlwaysAllowed(allowedTools(mcp));
	}

	/** Whether `tool` runs without asking for `grantId` now (a connected app only). */
	has(grantId: string, tool: string): boolean {
		return this.#allowed.has(grantId, tool);
	}

	/** What is allowed for `grantId`. */
	entry(grantId: string): AlwaysEntry {
		return {
			all: this.#allowed.everything(grantId),
			tools: this.#allowed.list(grantId),
		};
	}

	/** Always allow `tool` for `grantId`: nothing for an app not connected. */
	addTool(grantId: string, tool: string): void {
		this.#allowed.allow(grantId, tool);
	}

	/**
	 * Ask again for `tool` for `grantId`. With Allow all changes on, that goes
	 * off too (the library's rule: asking again errs towards asking).
	 */
	removeTool(grantId: string, tool: string): void {
		this.#allowed.ask(grantId, tool);
	}

	/** Allow all changes for `grantId`, on (a connected app only) or off. */
	setAll(grantId: string, on: boolean): void {
		this.#allowed.setEverything(grantId, on);
	}

	/** Everything of `grantId` asks again. */
	forget(grantId: string): void {
		this.#allowed.forget(grantId);
	}

	/** Called on every change of the allowances or of the tools; returns what stops it. */
	onChange(listener: () => void): () => void {
		return this.#allowed.onChange(listener);
	}
}
