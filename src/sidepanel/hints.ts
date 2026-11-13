/**
 * Who may write under the open case's buttons (DEC-011, DEC-022). Pure:
 * main.ts asks it before each write.
 *
 * - Leaving the case, opening another, or Hide makes every writer of it
 *   stale (`cancel`).
 * - Among the user's actions the later click wins, whenever each answers:
 *   an action writes unless one clicked after it has written already. An
 *   action that has not written blocks nothing.
 * - A draw the panel starts by itself writes only while no action has
 *   written since it started.
 */
export class CaseHints {
	/** Bumped when the case is left, another opened, or its marks hidden. */
	#epoch = 0;
	/** The order in which actions were clicked. */
	#clicks = 0;
	/** The click of the latest-clicked action that wrote, in this epoch. */
	#newestWriter = 0;
	/** How many times an action wrote, in this epoch. */
	#actionWrites = 0;

	/** No writer made before this writes any more. */
	cancel(): void {
		this.#epoch++;
		this.#newestWriter = 0;
		this.#actionWrites = 0;
	}

	/** An action, clicked now: the returned check says whether it may write now. */
	action(): () => boolean {
		const epoch = this.#epoch;
		const click = ++this.#clicks;
		return () => {
			if (epoch !== this.#epoch || this.#newestWriter > click) return false;
			this.#newestWriter = click;
			this.#actionWrites++;
			return true;
		};
	}

	/** A draw of the panel's own, started now. */
	draw(): () => boolean {
		const epoch = this.#epoch;
		const writes = this.#actionWrites;
		return () => epoch === this.#epoch && writes === this.#actionWrites;
	}
}
