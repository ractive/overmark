/**
 * What every `Kv` does, and the move of the settings from
 * `chrome.storage.local` on it: worker.test.ts runs this on `memoryKv`,
 * e2e/store.test.ts on `openKv` in a browser's IndexedDB. It bundles for a
 * page, so no `bun:test` here. Each case gets an empty `Kv`.
 */

import { type Kv, MOVED, migrate, type OldArea } from "../src/worker/kv.ts";

function same(actual: unknown, expected: unknown): void {
	const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
	if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

async function rejects(work: Promise<unknown>): Promise<void> {
	let failed = false;
	try {
		await work;
	} catch {
		failed = true;
	}
	if (!failed) throw new Error("expected a failure");
}

const sorted = (o: Record<string, unknown>) =>
	Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/** `chrome.storage.local` as the migration sees it. */
export function oldArea(
	initial: Record<string, unknown>,
	failRemove = false,
): OldArea & { data: Record<string, unknown> } {
	const data = structuredClone(initial);
	return {
		data,
		get: async () => structuredClone(data),
		async remove(keys: string[]) {
			if (failRemove) throw new Error("gone");
			for (const key of keys) delete data[key];
		},
	};
}

const SECRET_KEY = "tab-mcp:secret:https://relay.test:overmark";

/** What overmark#26 kept in `chrome.storage.local`. */
export const OLD = {
	[SECRET_KEY]: "A".repeat(43),
	relay: "https://relay.test",
	keepAiOn: true,
	blurForms: true,
	replaced: { sibling: false },
	migrated: true,
	somethingElse: 1,
};

/** The same, as the worker keeps it now. */
const MOVED_OLD = {
	[SECRET_KEY]: "A".repeat(43),
	relay: "https://relay.test",
	keepAiOn: true,
	blurForms: true,
	replaced: { sibling: false },
	panelHandedOver: true,
};

export const kvContract: Record<string, (kv: Kv) => Promise<void>> = {
	"a missing key is undefined; what is set is read back": async (kv) => {
		same(await kv.get("relay"), undefined);
		same(await kv.all(), {});
		await kv.set({ relay: "https://r.test", replaced: { sibling: true } });
		same(await kv.get("relay"), "https://r.test");
		same(await kv.get("replaced"), { sibling: true });
		same(sorted(await kv.all()), {
			relay: "https://r.test",
			replaced: { sibling: true },
		});
	},

	"set overwrites, remove removes": async (kv) => {
		await kv.set({ keepAiOn: true, blurForms: true });
		await kv.set({ keepAiOn: false });
		await kv.remove("blurForms");
		await kv.remove("never-there");
		same(await kv.all(), { keepAiOn: false });
	},

	"values are copies, not the caller's objects": async (kv) => {
		const replaced = { sibling: true };
		await kv.set({ replaced });
		replaced.sibling = false;
		same(await kv.get("replaced"), { sibling: true });
		const read = (await kv.get("replaced")) as { sibling: boolean };
		read.sibling = false;
		same(await kv.get("replaced"), { sibling: true });
	},

	"a write with a value that cannot be kept writes none of it": async (kv) => {
		await rejects(kv.set({ relay: "https://r.test", bad: () => "no" }));
		same(await kv.all(), {});
		await kv.set({ relay: "https://r.test" });
		same(await kv.all(), { relay: "https://r.test" });
	},

	"the old settings move from chrome.storage.local, then go from there": async (
		kv,
	) => {
		const old = oldArea(OLD);
		const moved = await migrate(old, kv);
		same(moved.sort(), Object.keys(MOVED_OLD).sort());
		// With the marker that it was done; #26's `migrated` is the panel's.
		same(sorted(await kv.all()), sorted({ ...MOVED_OLD, [MOVED]: 1 }));
		same(old.data, { somethingElse: 1 });
		// Again: nothing left to move, nothing changes.
		same(await migrate(old, kv), []);
		same(sorted(await kv.all()), sorted({ ...MOVED_OLD, [MOVED]: 1 }));
	},

	"a first start with nothing to move sets the marker too": async (kv) => {
		same(await migrate(oldArea({ somethingElse: 1 }), kv), []);
		same(await kv.all(), { [MOVED]: 1 });
	},

	"once moved, never again: what is written into chrome.storage.local later is only removed":
		async (kv) => {
			await migrate(oldArea({}), kv);
			// Where Chrome lets content scripts write the old area: a relay of
			// theirs, AI access kept on, a secret, the handover "done".
			const injected = oldArea({
				relay: "https://evil.example",
				keepAiOn: true,
				blurForms: false,
				migrated: true,
				"tab-mcp:secret:https://evil.example:overmark": "B".repeat(43),
				somethingElse: 1,
			});
			same(await migrate(injected, kv), []);
			same(await kv.all(), { [MOVED]: 1 });
			same(injected.data, { somethingElse: 1 });
		},

	"written before removed; a second run keeps what changed since": async (
		kv,
	) => {
		// The move is written, the removal fails (a crash would cut it short).
		await rejects(migrate(oldArea(OLD, true), kv));
		same(await kv.get(SECRET_KEY), "A".repeat(43));
		same(await kv.get(MOVED), 1);
		// The user turned Keep AI access off meanwhile; the old value must not win.
		await kv.set({ keepAiOn: false });
		const again = oldArea(OLD);
		same(await migrate(again, kv), []);
		same(await kv.get("keepAiOn"), false);
		same(again.data, { somethingElse: 1 });
	},

	"a setting the worker has already is kept over the old one": async (kv) => {
		await kv.set({ relay: "https://newer.test" });
		await migrate(oldArea(OLD), kv);
		same(await kv.get("relay"), "https://newer.test");
		same(await kv.get(SECRET_KEY), "A".repeat(43));
	},
};
