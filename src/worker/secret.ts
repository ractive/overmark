/**
 * The address secret's storage in the service worker, which has no
 * `localStorage` (DEC-015): the library reads and writes it synchronously,
 * so the entries are loaded from `chrome.storage.local` before the
 * connection is made, read from memory and written through.
 */

import type { SecretStorage } from "@ractive-ch/tab-mcp-client";

/** The library's keys start so (`tab-mcp:secret:<relay origin>:<name>`). */
export const SECRET_PREFIX = "tab-mcp:secret:";

/** 32 random bytes in base64url without padding, as the library makes them. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** What it needs of `chrome.storage.local`. */
export interface SecretArea {
	get(keys: null): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
}

export class CachedSecretStorage implements SecretStorage {
	readonly #area: SecretArea;
	readonly #cache: Map<string, string>;
	/** The last write, for tests and for a clean shutdown. */
	written: Promise<void> = Promise.resolve();

	private constructor(area: SecretArea, cache: Map<string, string>) {
		this.#area = area;
		this.#cache = cache;
	}

	/** The secrets kept in `area`, loaded. */
	static async load(area: SecretArea): Promise<CachedSecretStorage> {
		const all = await area.get(null);
		const cache = new Map<string, string>();
		for (const [key, value] of Object.entries(all))
			if (key.startsWith(SECRET_PREFIX) && typeof value === "string")
				cache.set(key, value);
		return new CachedSecretStorage(area, cache);
	}

	/**
	 * Secrets in memory only, written nowhere: for a browser that would let
	 * content scripts read the extension's storage.
	 */
	static memory(): CachedSecretStorage {
		return new CachedSecretStorage(
			{ get: async () => ({}), set: async () => {} },
			new Map(),
		);
	}

	getItem(key: string): string | null {
		return this.#cache.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.#cache.set(key, value);
		// Writes go out in order; one that fails leaves the secret in memory
		// for this worker's life (the address changes after a restart).
		this.written = this.written
			.then(() => this.#area.set({ [key]: value }))
			.catch((error: unknown) =>
				console.warn("Overmark: keeping the address secret", error),
			);
	}

	/**
	 * Take over a secret the side panel kept in its `localStorage`, so the
	 * address stays the same: only a key of the library's, only a value that
	 * is a secret, and never over one the worker has already. Returns whether
	 * it was taken.
	 */
	adopt(key: string, value: unknown): boolean {
		if (
			!key.startsWith(SECRET_PREFIX) ||
			typeof value !== "string" ||
			!SECRET.test(value) ||
			this.#cache.has(key)
		)
			return false;
		this.setItem(key, value);
		return true;
	}
}
