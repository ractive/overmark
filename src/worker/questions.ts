/**
 * The questions of tools that change something (DEC-008; DEC-018: unless
 * the user chose Always allow for the tool, or Allow all changes, for that
 * AI app), now that the connection has no page of its own to ask in
 * (DEC-015). A
 * question shows in every open side panel; unless a side panel is open, on
 * screen, in the focused window of the tab in front, it also goes out as a Chrome
 * notification, with Allow and Always allow. The first answer counts;
 * closing the notification or a click on its body, nobody answering within
 * the time limit, or the AI app cancelling, is Don't allow. Each notification carries
 * its call: a click answers only that call, and a click on a call that is
 * already settled is dropped.
 */

import type { ConfirmRequest } from "@ractive-ch/tab-mcp-client";
import { escapeInvisible } from "@ractive-ch/tab-mcp-client/visible";
import type { Answer, QuestionView } from "./protocol.ts";

/** A question nobody answers in this time is Don't allow. */
export const QUESTION_TIMEOUT_MS = 60_000;
/** An Allow or Always allow this soon after a notification showed does not count. */
export const NOTIFICATION_GUARD_MS = 500;
/** The arguments shown in the panel, and in a notification, are cut to this. */
export const MAX_ARGS = 4000;
export const MAX_ARGS_NOTIFICATION = 150;
/** A tool's title in a notification's title is cut to this. */
export const MAX_NOTIFICATION_TITLE = 60;

/**
 * The buttons of a notification, in order. Don't allow is closing it (or a
 * click on its body): Chrome gives a notification at most two buttons.
 */
export const NOTIFICATION_BUTTONS = ["Allow", "Always allow"] as const;

/** What a question needs from Chrome and from the panels. */
export interface QuestionsHost {
	/** The window of tab `tabId`, `undefined` if it is gone. */
	windowOf(tabId: number): Promise<number | undefined>;
	/** A side panel is open in window `windowId`, and the window is focused. */
	panelInFocus(windowId: number): Promise<boolean>;
	/** Show notification `id`; rejects if it could not be shown. */
	notify(id: string, text: NotificationText): Promise<void>;
	clear(id: string): void;
	/** The list of questions changed: tell the panels, set the badge. */
	changed(): void;
	now(): number;
}

export interface NotificationText {
	title: string;
	message: string;
	contextMessage: string;
}

const cut = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Characters that are invisible, blank or turn the text's direction (U+202E,
 * say) written as `\uXXXX`, so the AI app cannot make the arguments look like
 * something else; line breaks and tabs stay (in JSON only the layout). The
 * library's escaping, the same as its confirmation dialog's and the tab-mcp
 * extension's. The tool gets the text unchanged.
 */
export const visible: (text: string) => string = escapeInvisible;

/** The AI app as a question names it: its declared name beside its verified host. */
export function appName(client: ConfirmRequest["client"]): string {
	return client.name ? `${visible(client.name)} (${client.host})` : client.host;
}

/** A notification's text for a question: the case it is about, else the arguments. */
export function notificationText(
	view: QuestionView,
	summary: string,
): NotificationText {
	const what = cut(view.title ?? view.tool, MAX_NOTIFICATION_TITLE);
	const about = view.lines.length > 0 ? view.lines.join(" ") : summary;
	return {
		title: `Allow ${what}?`,
		message: cut(`${view.app} wants to run ${view.tool}: ${about}`, 300),
		contextMessage: "Overmark · close it to not allow",
	};
}

interface Pending {
	view: QuestionView;
	/** The AI app that asked. */
	grantId: string;
	summary: string;
	windowId: number | undefined;
	/** The notification showing it, if one does, and its creation. */
	notification?: string;
	created?: Promise<void>;
	shownAt: number;
	settle(answer: Answer | "timeout"): void;
}

export class Questions {
	readonly #host: QuestionsHost;
	readonly #timeoutMs: number;
	readonly #pending = new Map<string, Pending>();
	#shown = 0;

	constructor(host: QuestionsHost, timeoutMs = QUESTION_TIMEOUT_MS) {
		this.#host = host;
		this.#timeoutMs = timeoutMs;
	}

	/** The questions waiting, oldest first. */
	get list(): QuestionView[] {
		return [...this.#pending.values()].map((p) => p.view);
	}

	/**
	 * Ask whether `request` may run; `lines` say what it is about, `tabId` is
	 * the tab in front (where the user looks). Resolves with the first
	 * answer, `"timeout"` when nobody answered in time, `"deny"` when the AI
	 * app cancelled.
	 */
	ask(
		request: ConfirmRequest,
		lines: string[],
		tabId: number | undefined,
	): Promise<Answer | "timeout"> {
		const id = crypto.randomUUID();
		const json = visible(JSON.stringify(request.arguments, null, 2) ?? "{}");
		const view: QuestionView = {
			id,
			app: appName(request.client),
			tool: request.tool.name,
			...(request.tool.title ? { title: visible(request.tool.title) } : {}),
			lines: lines.map(visible),
			args: cut(json, MAX_ARGS),
		};
		const summary = cut(
			visible(JSON.stringify(request.arguments) ?? "{}"),
			MAX_ARGS_NOTIFICATION,
		);
		return new Promise((resolve) => {
			if (request.signal.aborted) {
				resolve("deny");
				return;
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cancelled = () => pending.settle("deny");
			const pending: Pending = {
				view,
				grantId: request.client.grantId,
				summary,
				windowId: undefined,
				shownAt: 0,
				settle: (answer) => {
					if (this.#pending.get(id) !== pending) return;
					this.#pending.delete(id);
					clearTimeout(timer);
					request.signal.removeEventListener("abort", cancelled);
					if (pending.notification !== undefined)
						this.#clear(pending.notification, pending.created);
					this.#host.changed();
					resolve(answer);
				},
			};
			this.#pending.set(id, pending);
			timer = setTimeout(() => pending.settle("timeout"), this.#timeoutMs);
			request.signal.addEventListener("abort", cancelled, { once: true });
			this.#host.changed();
			void this.#route(pending, tabId);
		});
	}

	/** In the panel of the tab's focused window, or else in a notification too. */
	async #route(pending: Pending, tabId: number | undefined): Promise<void> {
		try {
			pending.windowId =
				tabId === undefined ? undefined : await this.#host.windowOf(tabId);
			if (
				pending.windowId !== undefined &&
				(await this.#host.panelInFocus(pending.windowId))
			)
				return;
		} catch {
			// Not known where: a notification.
		}
		this.#notify(pending);
	}

	#notify(pending: Pending): void {
		if (this.#pending.get(pending.view.id) !== pending) return;
		const id = `${pending.view.id}:${++this.#shown}`;
		pending.notification = id;
		pending.shownAt = this.#host.now();
		pending.created = this.#host
			.notify(id, notificationText(pending.view, pending.summary))
			.catch((error: unknown) =>
				// Notifications off for Chrome: the badge and the panel remain.
				console.warn("Overmark: notification", error),
			);
	}

	/**
	 * Clear notification `id` once Chrome has made it: cleared before, it
	 * would come afterwards and stay, asking for a call that is settled.
	 */
	#clear(id: string, created: Promise<void> | undefined): void {
		void (created ?? Promise.resolve()).then(() => this.#host.clear(id));
	}

	/** An answer from a side panel. */
	/**
	 * Allow every waiting question that `covered` now lets through (an
	 * Always allow or Allow all changes given meanwhile for its AI app and
	 * tool): it would otherwise still wait, and time out as a no.
	 */
	allowCovered(covered: (grantId: string, tool: string) => boolean): void {
		for (const pending of [...this.#pending.values()])
			if (covered(pending.grantId, pending.view.tool)) pending.settle("allow");
	}

	answer(id: string, answer: Answer): void {
		this.#pending.get(id)?.settle(answer);
	}

	#byNotification(id: string): Pending | undefined {
		for (const pending of this.#pending.values())
			if (pending.notification === id) return pending;
		return undefined;
	}

	/** A button of notification `id`: 0 Allow, 1 Always allow. */
	notificationButton(id: string, index: number): void {
		const pending = this.#byNotification(id);
		if (pending === undefined) return; // settled, or an older notification
		const answer: Answer | undefined =
			index === 0 ? "allow" : index === 1 ? "always" : undefined;
		if (answer === undefined) return;
		if (this.#host.now() - pending.shownAt < NOTIFICATION_GUARD_MS) {
			// Too soon to be read: show it again rather than take it.
			const created = pending.created;
			this.#notify(pending);
			this.#clear(id, created);
			return;
		}
		pending.settle(answer);
	}

	/** A click on the notification's body, or its closing: Don't allow. */
	notificationDismissed(id: string): void {
		this.#byNotification(id)?.settle("deny");
	}

	/**
	 * The side panel of window `windowId` closed, or another extension's
	 * panel covered it: its questions that showed only there go out as
	 * notifications.
	 */
	panelClosed(windowId: number): void {
		for (const pending of this.#pending.values())
			if (pending.windowId === windowId && pending.notification === undefined)
				this.#notify(pending);
	}
}
