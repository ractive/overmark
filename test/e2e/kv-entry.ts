/**
 * Injected into a page by `store.test.ts`: the worker's real `openKv` and the
 * settings contract, as a global, with a database of its own for each run.
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
};
