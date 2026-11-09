/**
 * Injected into a page by `store.test.ts`: the worker's real `openKv` and the
 * settings contract, as a global, with a database of its own for each run,
 * and a database deleted under an open `Kv`.
 */

import { openKv } from "../../src/worker/kv.ts";
import { kvContract } from "../kv-contract.ts";

declare global {
	var __overmarkKv: unknown;
}

let runs = 0;

globalThis.__overmarkKv = {
	names: Object.keys(kvContract),
	async run(name: string) {
		runs++;
		await kvContract[name]?.(await openKv(`overmark-settings-test-${runs}`));
	},
	/**
	 * Another context deletes the database under an open `Kv` (Chrome asks
	 * its connection to close): the next calls open it again. Answers what
	 * they read.
	 */
	async reopens() {
		const name = "overmark-settings-reopen";
		const kv = await openKv(name);
		await kv.set({ relay: "https://before.test" });
		await new Promise<void>((resolve, reject) => {
			const deleting = indexedDB.deleteDatabase(name);
			deleting.onsuccess = () => resolve();
			deleting.onerror = () => reject(deleting.error);
			// Without the close on `versionchange` this would wait for ever.
			deleting.onblocked = () => reject(new Error("blocked"));
		});
		const afterDelete = await kv.all();
		await kv.set({ relay: "https://after.test" });
		return { afterDelete, afterWrite: await kv.all() };
	},
};
