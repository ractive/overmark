/**
 * The AI connection's settings and the address secret in IndexedDB, in the
 * extension's own origin and used from the service worker only (DEC-016).
 * Content scripts run in the page's origin and cannot reach it, whatever
 * Chrome's version; `chrome.storage.local` they can read and write by
 * default, and whether `setAccessLevel` closes it to them depends on the
 * Chrome. A database of its own: the cases' ("overmark") stays as it is.
 */

import { SECRET_PREFIX } from "./settings.ts";

/** What the worker keeps: a key, a value that IndexedDB can clone. */
export interface Kv {
	get(key: string): Promise<unknown>;
	/** Every entry. */
	all(): Promise<Record<string, unknown>>;
	/** Write several entries at once (one transaction). */
	set(entries: Record<string, unknown>): Promise<void>;
	remove(key: string): Promise<void>;
}

export const DATABASE = "overmark-settings";
const STORE = "settings";

const done = <T>(request: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});

const finished = (transaction: IDBTransaction) =>
	new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("transaction aborted"));
	});

/** The settings database, opened (and made the first time). */
export async function openKv(name = DATABASE): Promise<Kv> {
	const open = indexedDB.open(name, 1);
	open.onupgradeneeded = () => open.result.createObjectStore(STORE);
	const db = await done(open);
	const store = (mode: IDBTransactionMode) =>
		db.transaction(STORE, mode).objectStore(STORE);
	return {
		get: (key) => done(store("readonly").get(key)),
		async all() {
			const s = store("readonly");
			const [keys, values] = await Promise.all([
				done(s.getAllKeys()),
				done(s.getAll()),
			]);
			return Object.fromEntries(keys.map((k, i) => [String(k), values[i]]));
		},
		async set(entries) {
			const s = store("readwrite");
			const end = finished(s.transaction);
			try {
				for (const [key, value] of Object.entries(entries)) s.put(value, key);
			} catch (error) {
				// A value IndexedDB cannot clone: none of them is written.
				end.catch(() => {});
				s.transaction.abort();
				throw error;
			}
			await end;
		},
		remove(key) {
			const s = store("readwrite");
			s.delete(key);
			return finished(s.transaction);
		},
	};
}

/** A `Kv` in memory, for tests. */
export function memoryKv(initial: Record<string, unknown> = {}): Kv & {
	data: Map<string, unknown>;
} {
	const data = new Map(
		Object.entries(structuredClone(initial) as Record<string, unknown>),
	);
	return {
		data,
		get: async (key) => structuredClone(data.get(key)),
		all: async () => structuredClone(Object.fromEntries(data)),
		async set(entries) {
			// Like a transaction: all or nothing.
			const copy = structuredClone(entries);
			for (const [key, value] of Object.entries(copy)) data.set(key, value);
		},
		async remove(key) {
			data.delete(key);
		},
	};
}

/**
 * The keys overmark#26 kept in `chrome.storage.local`, and what each is
 * called here: its `migrated` (the side panel's `localStorage` was handed
 * over) is `panelHandedOver`, so that it is not mistaken for `MOVED`.
 */
const OLD_KEYS: Record<string, string> = {
	relay: "relay",
	keepAiOn: "keepAiOn",
	blurForms: "blurForms",
	replaced: "replaced",
	migrated: "panelHandedOver",
};

/** A key of the settings as `chrome.storage.local` had them. */
export function isOldSettingKey(key: string): boolean {
	return Object.hasOwn(OLD_KEYS, key) || key.startsWith(SECRET_PREFIX);
}

/** What the migration needs of `chrome.storage.local`. */
export interface OldArea {
	get(keys: null): Promise<Record<string, unknown>>;
	remove(keys: string[]): Promise<void>;
}

/** In `kv` once the settings were moved: from then on nothing is taken from the old area. */
export const MOVED = "movedFromStorage";

/**
 * Move the settings from `chrome.storage.local` into `kv`, once: the moved
 * entries and the `MOVED` marker are written in one transaction, also when
 * there was nothing to move (a first start), then the old keys are removed.
 * After that nothing is ever taken from the old area again: where Chrome does
 * not keep content scripts out of it, one could write a relay or a secret
 * there for the next start to pick up. What setting keys are still found
 * there (a removal a crash cut short, or a content script's) are only
 * removed. A key already in `kv` is kept. Returns the keys moved, as named
 * in `kv`.
 */
export async function migrate(old: OldArea, kv: Kv): Promise<string[]> {
	const moved = (await kv.get(MOVED)) !== undefined;
	const stored = await old.get(null);
	const keys = Object.keys(stored).filter(isOldSettingKey);
	if (moved) {
		if (keys.length > 0) await old.remove(keys);
		return [];
	}
	const present = await kv.all();
	const missing: Record<string, unknown> = {};
	for (const key of keys) {
		const name = OLD_KEYS[key] ?? key;
		if (!(name in present)) missing[name] = stored[key];
	}
	await kv.set({ ...missing, [MOVED]: 1 });
	if (keys.length > 0) await old.remove(keys);
	return Object.keys(missing);
}
