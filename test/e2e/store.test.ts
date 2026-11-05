/**
 * The store contract (`test/store-contract.ts`) on the `IdbStore` that ships,
 * in real IndexedDB: the same cases `MemoryStore` passes in `store.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { storeContract } from "../store-contract.ts";
import type { Page } from "./browser.ts";
import { browserBinary, type Harness, startHarness } from "./harness.ts";

describe.skipIf(browserBinary === undefined)("IdbStore", () => {
	let h: Harness;
	let page: Page;

	beforeAll(async () => {
		h = await startHarness(browserBinary as string);
		const bundle = await Bun.build({
			entrypoints: [join(import.meta.dir, "store-entry.ts")],
			target: "browser",
			format: "iife",
		});
		if (!bundle.success) throw new AggregateError(bundle.logs, "store bundle");
		({ page } = await h.open("v1"));
		await page.eval(await (bundle.outputs[0] as Blob).text());
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
