/**
 * The rules of filling in the code on the relay's pairing page (DEC-044 and
 * its review): when a page gets the question, what withdraws it, and what a
 * yes fills in. The connection gives it the browser and the library
 * (`FillHost`); the functions that run in the page are `pair-fill.ts`.
 *
 * - Nothing happens unless the user turned it on and AI access is connected
 *   (`ready`), and the page is the relay's, exactly, in a site Sitegloss may
 *   see. Each page load asks; nothing is ever filled in without a yes, also
 *   not on the relay's answer to a wrong code (the same form again): that is
 *   a page load, and it asks again.
 * - One question at a time. A page in another tab while one waits is not
 *   asked about and not dropped unseen: the panel says so (`problem`). The
 *   same tab loading a pairing page again replaces its question (the page it
 *   was about is gone), with a new id, so the panel's wait before a yes
 *   counts starts again.
 * - A yes fills in only the page it was given for: the same tab, the relay's
 *   origin and path, the same app, AI app and request id (the form's hidden
 *   `request_id`), checked again in the page itself after the code came.
 *   Withdrawing (AI access off, the setting off, another relay) or the tab
 *   leaving the page while the code is on its way fills in nothing.
 * - Pairing is held on (codes come only while it is) from the yes until
 *   `holdMs` after the fill, for the relay to check the code; at once when
 *   nothing was filled in.
 */

import { isCode, isPairingPage, type PairingForm } from "./pair-fill.ts";
import { type FillView, fillAppLabel } from "./protocol.ts";

/** How long the question waits for an answer: a code's own life. */
export const FILL_ASK_MS = 120_000;
/** How long pairing stays on after a fill, for the relay to check the code. */
export const FILL_HOLD_MS = 30_000;
/** How long the panel says why a fill-in did not happen. */
export const FILL_PROBLEM_MS = 20_000;

/** What the filler needs of the browser, the library and the panel. */
export interface FillHost {
	/** The app whose forms are answered (`APP_ID`). */
	app: string;
	/** The origins whose pairing page is filled in now; none: no relay of them. */
	origins(): readonly string[];
	/** Turned on by the user, and AI access connected. */
	ready(): boolean;
	/** Sitegloss may see `origin`'s pages. */
	hasSite(origin: string): Promise<boolean>;
	/** The address the tab shows now; `undefined` once it is gone. */
	tabUrl(tabId: number): Promise<string | undefined>;
	/** `readPairingForm(origin)` in the tab's top frame. */
	read(tabId: number, origin: string): Promise<PairingForm | null | undefined>;
	/** `fillPairingForm(code, form, origin)` in the tab's top frame. */
	fill(
		tabId: number,
		code: string,
		form: PairingForm,
		origin: string,
	): Promise<boolean>;
	/** The code to fill in, once pairing is held on (`hold(true)`). */
	code(): Promise<string | undefined>;
	/** Hold pairing on for a fill, or let it go. */
	hold(on: boolean): void;
	/** Tell the user with no panel on screen; `undefined`: the question went. */
	notify(view: FillView | undefined): void;
	changed(): void;
	/** Escapes invisible and direction characters: the names come from a page. */
	visible(text: string): string;
}

interface Question {
	view: FillView;
	tabId: number;
	origin: string;
	form: PairingForm;
	timer: ReturnType<typeof setTimeout>;
}

/** A yes on its way to the page: withdrawn before the fill, it fills in nothing. */
interface Filling {
	tabId: number;
	withdrawn: boolean;
	/** The fill was started: the page's own post may be on its way. */
	started: boolean;
}

export class CodeFiller {
	readonly #host: FillHost;
	readonly #holdMs: number;
	readonly #askMs: number;
	#question: Question | undefined;
	#filling: Filling | undefined;
	#problem: { text: string; timer: ReturnType<typeof setTimeout> } | undefined;
	#holding = false;
	#release: ReturnType<typeof setTimeout> | undefined;

	constructor(
		host: FillHost,
		options: { holdMs?: number; askMs?: number } = {},
	) {
		this.#host = host;
		this.#holdMs = options.holdMs ?? FILL_HOLD_MS;
		this.#askMs = options.askMs ?? FILL_ASK_MS;
	}

	/** The question that waits, for the panel. */
	get question(): FillView | undefined {
		return this.#question?.view;
	}

	/** Why the last fill-in did not happen, or why a page was not asked about. */
	get problem(): string | undefined {
		return this.#problem?.text;
	}

	/** A question waits, or a yes is on its way (Firefox's event page stays). */
	get busy(): boolean {
		return this.#question !== undefined || this.#filling !== undefined;
	}

	/**
	 * A tab finished loading `url`. On the relay's pairing page, turned on,
	 * with AI access connected and the user's leave to see that site, its form
	 * is read; one for this app gets the question. Anything else: nothing
	 * happens, and the user types the code as before.
	 */
	async page(tabId: number, url: string | undefined): Promise<void> {
		const host = this.#host;
		if (!isPairingPage(url, host.origins()) || !host.ready()) return;
		const origin = new URL(url as string).origin;
		if (!(await host.hasSite(origin).catch(() => false))) return;
		const form = await host.read(tabId, origin).catch(() => undefined);
		if (form?.app !== host.app) return;
		// The page may have moved on while it was read, or the user turned it
		// off, or AI access went.
		if ((await host.tabUrl(tabId).catch(() => undefined)) !== url) return;
		if (!host.ready() || !host.origins().includes(origin)) return;
		const view = {
			id: crypto.randomUUID(),
			name: host.visible(form.clientName),
			host: host.visible(form.clientHost),
		};
		const waiting = this.#question;
		if (
			(waiting !== undefined && waiting.tabId !== tabId) ||
			(this.#filling !== undefined && this.#filling.tabId !== tabId)
		) {
			this.#setProblem(
				`${fillAppLabel(view)} also opened the relay's page. Sitegloss asks about one at a time: answer the question above first, then reload that page; or type the code there.`,
				this.#askMs,
			);
			return;
		}
		this.#end();
		this.#question = {
			view,
			tabId,
			origin,
			form,
			timer: setTimeout(() => {
				if (this.#question?.view.id === view.id) {
					this.#end();
					host.changed();
				}
			}, this.#askMs),
		};
		host.notify(view);
		host.changed();
	}

	/** The tab went (`url` none), or loaded `url`: off the pairing page, its question goes. */
	tabLeft(tabId: number, url?: string): void {
		const off =
			url === undefined ||
			!isPairingPage(url, this.#question ? [this.#question.origin] : []);
		// Not once the fill started: Connect's own post leaves the page, and
		// pairing must stay on for the relay to check the code.
		if (this.#filling?.tabId === tabId && off && !this.#filling.started)
			this.#filling.withdrawn = true;
		if (this.#question?.tabId !== tabId || !off) return;
		this.#end();
		this.#host.changed();
	}

	/**
	 * Turned off, AI access off, another relay: the question goes at once, a
	 * yes on its way fills in nothing, and pairing is no longer held on.
	 */
	withdraw(): void {
		if (this.#filling !== undefined) this.#filling.withdrawn = true;
		this.#end();
		this.#setProblem(undefined);
		this.#letGo();
		this.#host.changed();
	}

	/**
	 * The user's answer to question `id`. A yes types the code into that
	 * page's form and clicks Connect, if the tab still shows the same request.
	 */
	async answer(id: string, yes: boolean): Promise<void> {
		const host = this.#host;
		const q = this.#question;
		if (q === undefined || q.view.id !== id) return;
		this.#end();
		host.changed();
		if (!yes) return;
		const filling: Filling = {
			tabId: q.tabId,
			withdrawn: false,
			started: false,
		};
		this.#filling = filling;
		const failed = () =>
			this.#setProblem(
				`Sitegloss could not fill in the code for the AI app at ${q.view.host}. Type the code from the AI app card on the relay's page.`,
			);
		const still = async () =>
			!filling.withdrawn &&
			host.ready() &&
			host.origins().includes(q.origin) &&
			isPairingPage(await host.tabUrl(q.tabId).catch(() => undefined), [
				q.origin,
			]);
		clearTimeout(this.#release);
		this.#holding = true;
		host.hold(true);
		/** The code went into the page. */
		let placed = false;
		try {
			if (!(await still())) return filling.withdrawn ? undefined : failed();
			const code = await host.code();
			if (filling.withdrawn) return;
			if (!isCode(code) || !(await still())) return failed();
			filling.started = true;
			const filled = await host
				.fill(q.tabId, code, q.form, q.origin)
				.catch(() => false);
			if (!filled) return failed();
			placed = true;
			this.#setProblem(undefined);
		} finally {
			if (this.#filling === filling) this.#filling = undefined;
			// Held on only for a code that went into the page.
			if (filling.withdrawn || !placed) this.#letGo();
			else this.#release = setTimeout(() => this.#letGo(), this.#holdMs);
			host.changed();
		}
	}

	#end(): void {
		if (this.#question === undefined) return;
		clearTimeout(this.#question.timer);
		this.#question = undefined;
		this.#host.notify(undefined);
	}

	#letGo(): void {
		clearTimeout(this.#release);
		this.#release = undefined;
		if (!this.#holding || this.#filling !== undefined) return;
		this.#holding = false;
		this.#host.hold(false);
	}

	#setProblem(text: string | undefined, ms = FILL_PROBLEM_MS): void {
		clearTimeout(this.#problem?.timer);
		this.#problem =
			text === undefined
				? undefined
				: {
						text,
						timer: setTimeout(() => {
							this.#problem = undefined;
							this.#host.changed();
						}, ms),
					};
		this.#host.changed();
	}
}
