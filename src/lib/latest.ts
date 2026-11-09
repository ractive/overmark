/**
 * `Latest`: of overlapping pieces of asynchronous work for the same thing,
 * only the newest may write its result (DEC-011). Used by the side panel and
 * by the service worker's "Keep AI access on".
 */

/** Only the newest of overlapping pieces of work may write its result. */
export class Latest {
	#n = 0;

	/** Start a piece of work; `current()` says whether it is still the newest. */
	start(): { current: () => boolean } {
		const mine = ++this.#n;
		return { current: () => mine === this.#n };
	}

	/** Make every running piece of work stale. */
	cancel(): void {
		this.#n++;
	}
}
