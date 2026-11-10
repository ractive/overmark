/**
 * "Always allow" (DEC-018): per AI app (its grant) either the tools the user
 * answered a question with Always allow, or "Allow all changes", which lets
 * every tool that changes something run without asking. Kept in the
 * worker's settings database (`kv.ts`, DEC-016), so it survives the panel,
 * the worker and the browser closing; an app's entry goes when its grant
 * goes (Disconnect, New address, the relay dropping it), which `keepGrants`
 * does with each list of grants the relay sends.
 */

import type { Kv } from "./kv.ts";

/** The key in the settings database: one value, by grant. */
export const ALWAYS_KEY = "alwaysAllowed";

/** What is kept for one AI app. */
export interface AlwaysEntry {
	/** "Allow all changes". */
	all: boolean;
	/** The tools always allowed, by name, in the order they were added. */
	tools: string[];
}

/** By grant id. */
export type AlwaysData = Map<string, AlwaysEntry>;

/** The stored value, checked: anything malformed is dropped (asks again). */
export function alwaysOf(value: unknown): AlwaysData {
	const out: AlwaysData = new Map();
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return out;
	for (const [grantId, raw] of Object.entries(value)) {
		if (typeof raw !== "object" || raw === null) continue;
		const { all, tools } = raw as Record<string, unknown>;
		const names = Array.isArray(tools)
			? [
					...new Set(
						tools.filter((t): t is string => typeof t === "string" && t !== ""),
					),
				]
			: [];
		if (all === true || names.length > 0)
			out.set(grantId, { all: all === true, tools: names });
	}
	return out;
}

/** As stored: a plain object (own properties only, whatever the ids). */
const stored = (data: AlwaysData) => Object.fromEntries(data);

export class AlwaysAllowed {
	readonly #kv: Kv;
	#data: AlwaysData;
	/** Changes, one after the other: each starts from the one before. */
	#queue: Promise<void> = Promise.resolve();

	private constructor(kv: Kv, data: AlwaysData) {
		this.#kv = kv;
		this.#data = data;
	}

	static async load(kv: Kv): Promise<AlwaysAllowed> {
		return new AlwaysAllowed(kv, alwaysOf(await kv.get(ALWAYS_KEY)));
	}

	/** Whether `tool` runs without asking for grant `grantId`. */
	has(grantId: string, tool: string): boolean {
		const entry = this.#data.get(grantId);
		return entry !== undefined && (entry.all || entry.tools.includes(tool));
	}

	/** What is kept for `grantId`. */
	entry(grantId: string): AlwaysEntry {
		const entry = this.#data.get(grantId);
		return { all: entry?.all ?? false, tools: [...(entry?.tools ?? [])] };
	}

	/** Always allow `tool` for `grantId`. */
	addTool(grantId: string, tool: string): Promise<void> {
		return this.#change((data) => {
			const entry = data.get(grantId) ?? { all: false, tools: [] };
			if (!entry.tools.includes(tool)) entry.tools.push(tool);
			data.set(grantId, entry);
		});
	}

	/** Ask again for `tool` for `grantId`. */
	removeTool(grantId: string, tool: string): Promise<void> {
		return this.#change((data) => {
			const entry = data.get(grantId);
			if (entry !== undefined)
				entry.tools = entry.tools.filter((t) => t !== tool);
		});
	}

	/** "Allow all changes" for `grantId`, on or off. */
	setAll(grantId: string, on: boolean): Promise<void> {
		return this.#change((data) => {
			data.set(grantId, { all: on, tools: data.get(grantId)?.tools ?? [] });
		});
	}

	/** Forget every app not in `grantIds`: the relay's list of grants. */
	keepGrants(grantIds: Iterable<string>): Promise<void> {
		const keep = new Set(grantIds);
		return this.#change((data) => {
			for (const grantId of [...data.keys()])
				if (!keep.has(grantId)) data.delete(grantId);
		});
	}

	/**
	 * Change a copy, write it, and only then use it: a write that fails
	 * changes nothing, so what asks and what is stored agree.
	 */
	#change(change: (data: AlwaysData) => void): Promise<void> {
		const run = this.#queue.then(async () => {
			const next = structuredClone(this.#data);
			change(next);
			// Dropped: apps with nothing left.
			const kept = alwaysOf(stored(next));
			if (JSON.stringify(stored(kept)) === JSON.stringify(stored(this.#data)))
				return;
			if (kept.size === 0) await this.#kv.remove(ALWAYS_KEY);
			else await this.#kv.set({ [ALWAYS_KEY]: stored(kept) });
			this.#data = kept;
		});
		this.#queue = run.catch(() => {});
		return run;
	}
}
