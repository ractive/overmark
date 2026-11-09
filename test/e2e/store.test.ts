/**
 * The store contract (`test/store-contract.ts`) on the `IdbStore` that ships,
 * in real IndexedDB: the same cases `MemoryStore` passes in `store.test.ts`.
 * And the settings contract (`test/kv-contract.ts`) on the worker's `openKv`:
 * the same cases `memoryKv` passes in `worker.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { kvContract } from "../kv-contract.ts";
import { storeContract } from "../store-contract.ts";
import type { Page } from "./browser.ts";
import { browserBinary, type Harness, startHarness } from "./harness.ts";

describe.skipIf(browserBinary === undefined)("IdbStore and openKv", () => {
	let h: Harness;
	let page: Page;

	beforeAll(async () => {
		h = await startHarness(browserBinary as string);
		({ page } = await h.open("v1"));
		for (const entry of ["store-entry.ts", "kv-entry.ts"]) {
			const bundle = await Bun.build({
				entrypoints: [join(import.meta.dir, entry)],
				target: "browser",
				format: "iife",
			});
			if (!bundle.success) throw new AggregateError(bundle.logs, entry);
			await page.eval(await (bundle.outputs[0] as Blob).text());
		}
	}, 60_000);

	afterAll(async () => {
		await h?.stop();
	});

	test("the page runs every case of the contract", async () => {
		expect(await page.eval<string[]>("__overmarkStore.names")).toEqual(
			Object.keys(storeContract),
		);
	});

	for (const name of Object.keys(storeContract))
		test(name, async () => {
			await page.eval(`__overmarkStore.run(${JSON.stringify(name)})`);
		});

	test("the page runs every case of the settings contract", async () => {
		expect(await page.eval<string[]>("__overmarkKv.names")).toEqual(
			Object.keys(kvContract),
		);
	});

	for (const name of Object.keys(kvContract))
		test(`settings: ${name}`, async () => {
			await page.eval(`__overmarkKv.run(${JSON.stringify(name)})`);
		});

	test("sweepPending reads the pending records only, and no image of a finished case", async () => {
		expect(
			await page.eval<{ swept: number; reads: string[] }>(
				"__overmarkStore.sweepReads()",
			),
		).toEqual({
			swept: 1,
			reads: ["get c_1/pending/p_old.webp", "get c_2/pending/p_new.webp"],
		});
	});
});
