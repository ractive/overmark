/**
 * Injected into a page by `store.test.ts`: the real `IdbStore` and the store
 * contract, as a global, with a fresh database for each run.
 */

import { IdbStore } from "../../src/lib/store.ts";
import { storeContract } from "../store-contract.ts";

declare global {
	var __overmarkStore: unknown;
}

/** An `IdbStore` on an empty database. */
async function emptyStore(): Promise<IdbStore> {
	const store = new IdbStore();
	await store.listCases(); // creates the database
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const open = indexedDB.open("overmark");
		open.onsuccess = () => resolve(open.result);
		open.onerror = () => reject(open.error);
	});
	const tx = db.transaction(["cases", "images"], "readwrite");
	tx.objectStore("cases").clear();
	tx.objectStore("images").clear();
	await new Promise((resolve) => {
		tx.oncomplete = resolve;
	});
	db.close();
	return store;
}

/** Everything that reads image records from `IDBObjectStore`, while `work` runs. */
async function recordReads(work: () => Promise<unknown>): Promise<string[]> {
	const proto = IDBObjectStore.prototype;
	const original = {
		get: proto.get,
		getAll: proto.getAll,
		openCursor: proto.openCursor,
	};
	const reads: string[] = [];
	proto.get = function (key) {
		reads.push(`get ${String(key)}`);
		return original.get.call(this, key);
	};
	proto.getAll = function (...args) {
		reads.push("getAll");
		return original.getAll.apply(this, args);
	};
	proto.openCursor = function (...args) {
		reads.push("openCursor");
		return original.openCursor.apply(this, args);
	};
	try {
		await work();
	} finally {
		Object.assign(proto, original);
	}
	return reads;
}

globalThis.__overmarkStore = {
	names: Object.keys(storeContract),
	async run(name: string) {
		await storeContract[name]?.(await emptyStore());
	},
	/** Sweep a store of finished images and pending ones; answers what it read. */
	async sweepReads() {
		const store = await emptyStore();
		const image = (storedAt?: number) => ({
			blob: new Blob(["x"]),
			width: 1,
			height: 1,
			...(storedAt === undefined ? {} : { storedAt }),
		});
		await store.putImage("c_1", "shots/s1.webp", image());
		await store.putImage("c_1", "crops/a1.webp", image());
		await store.putImage("c_1", "pending/p_old.webp", image(1000));
		await store.putImage("c_2", "pending/p_new.webp", image(9000));
		let swept = 0;
		const reads = await recordReads(async () => {
			swept = await store.sweepPending(5000);
		});
		return { swept, reads: reads.sort() };
	},
};
