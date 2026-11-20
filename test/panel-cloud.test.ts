/**
 * The panel's side of the sync with a team (`src/sidepanel/cloud.ts`): what
 * it asks the worker on its own.
 */
import { expect, test } from "bun:test";
import { memoryKv } from "../src/lib/kv.ts";
import type { CloudRequest } from "../src/lib/messages.ts";
import { SHOWN_CHECK_MS, startCloud } from "../src/sidepanel/cloud.ts";

test("shown or focused: the account is looked at again, at most once a minute from here (DEC-045)", async () => {
	const asked: CloudRequest[] = [];
	const real = Date.now;
	let now = Date.parse("2026-11-20T14:00:00.000Z");
	Date.now = () => now;
	try {
		const cloud = startCloud(
			() => undefined,
			memoryKv(),
			async (request) => {
				asked.push(request);
				return { ok: true };
			},
		);
		cloud.shown();
		// Focus and visibility come together; a second look within the minute asks nothing.
		cloud.shown();
		now += SHOWN_CHECK_MS - 1;
		cloud.shown();
		now += 1;
		cloud.shown();
		await Bun.sleep(0);
		expect(asked.filter((r) => r.type === "cloud:check")).toHaveLength(2);
	} finally {
		Date.now = real;
	}
});
