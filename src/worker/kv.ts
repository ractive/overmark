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
	/** Write several entries at once (one transaction): all or none. */
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

/**
 * The settings database, opened (and made the first time). Chrome may close
 * the connection (`onclose`: the user cleared the site's data, a disk
 * error), and another context deleting or upgrading the database asks it to
 * close (`onversionchange`): either way the next call opens it again.
 */
export async function openKv(name = DATABASE): Promise<Kv> {
	let current: Promise<IDBDatabase> | undefined;
	const connect = (): Promise<IDBDatabase> => {
		if (current !== undefined) return current;
		const opening = (async () => {
			const open = indexedDB.open(name, 1);
			open.onupgradeneeded = () => open.result.createObjectStore(STORE);
			const db = await done(open);
			const forget = () => {
				if (current === opening) current = undefined;
			};
			db.onclose = forget;
			db.onversionchange = () => {
				db.close();
				forget();
			};
			return db;
		})();
		current = opening;
		opening.catch(() => {
			if (current === opening) current = undefined;
		});
		return opening;
	};
	const store = async (mode: IDBTransactionMode) => {
		let db = await connect();
		try {
			return db.transaction(STORE, mode).objectStore(STORE);
		} catch (error) {
			// Closed under us before its event came: once more, on a new one.
			if ((error as DOMException).name !== "InvalidStateError") throw error;
			current = undefined;
			db = await connect();
			return db.transaction(STORE, mode).objectStore(STORE);
		}
	};
	await connect();
	return {
		get: async (key) => done((await store("readonly")).get(key)),
		async all() {
			const s = await store("readonly");
			const [keys, values] = await Promise.all([
				done(s.getAllKeys()),
				done(s.getAll()),
			]);
			return Object.fromEntries(keys.map((k, i) => [String(k), values[i]]));
		},
		async set(entries) {
			const s = await store("readwrite");
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
		async remove(key) {
			const s = await store("readwrite");
			s.delete(key);
			await finished(s.transaction);
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
 * The keys an unreleased build (overmark#26) kept in `chrome.storage.local`.
 * Only the owner's own build ever wrote them there.
 */
const OLD_KEYS = new Set([
	"relay",
	"keepAiOn",
	"blurForms",
	"replaced",
	"migrated",
]);

/** A key of the settings as `chrome.storage.local` had them. */
export function isOldSettingKey(key: string): boolean {
	return OLD_KEYS.has(key) || key.startsWith(SECRET_PREFIX);
}

/** What the clean-up needs of `chrome.storage.local`. */
export interface OldArea {
	get(keys: null): Promise<Record<string, unknown>>;
	remove(keys: string[]): Promise<void>;
}

/**
 * Remove the settings keys from `chrome.storage.local`, at every start, and
 * never take them over (DEC-016): where Chrome does not keep content scripts
 * out of that area, one could write a relay or a secret there for the worker
 * to pick up. Returns the keys removed.
 */
export async function removeOldSettings(old: OldArea): Promise<string[]> {
	const keys = Object.keys(await old.get(null)).filter(isOldSettingKey);
	if (keys.length > 0) await old.remove(keys);
	return keys;
}
