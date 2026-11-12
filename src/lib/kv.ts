/**
 * A small key-value database in IndexedDB, in the extension's origin: the
 * AI settings' (the worker's alone, DEC-016) and the sync's (DEC-021) are
 * each one of these. Content scripts run in the page's origin and reach
 * neither.
 */

/** A key, a value that IndexedDB can clone. */
export interface Kv {
	get(key: string): Promise<unknown>;
	/** Every entry. */
	all(): Promise<Record<string, unknown>>;
	/** Write several entries at once (one transaction): all or none. */
	set(entries: Record<string, unknown>): Promise<void>;
	remove(key: string): Promise<void>;
}

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
export async function openKv(name: string): Promise<Kv> {
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

/** A `Kv` usable at once: each call waits for the database to open. */
export function kvWhenOpen(opening: Promise<Kv>): Kv {
	// Not left unhandled: each call that uses it rejects with the error.
	opening.catch(() => undefined);
	return {
		get: async (key) => (await opening).get(key),
		all: async () => (await opening).all(),
		set: async (entries) => (await opening).set(entries),
		remove: async (key) => (await opening).remove(key),
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
