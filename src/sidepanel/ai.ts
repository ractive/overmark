/**
 * The side panel's view of the AI connection, which lives in the service
 * worker (DEC-015). It shows the state the worker sends over the panel's
 * port, in the header (through the panel's state, `s.ai`) and in the "AI app"
 * card and the questions (drawn here), and sends the user's commands back.
 * Closing the panel changes nothing but pairing, which stops.
 *
 * The card is the tab-mcp extension's (its `sidepanel/card.ts`), with
 * Sitegloss's relay and "Keep AI access on" under it.
 * "Blur form fields in screenshots" goes the same way: the worker keeps it,
 * and the panel neither reads nor writes it in storage (DEC-016), as do
 * Always allow and "Allow all changes" for each AI app (DEC-018).
 */

import { askDataConsent, FIREFOX, PANEL } from "../lib/browser.ts";
import {
	type AiState,
	type Answer,
	PANEL_PORT,
	type PanelCommand,
	type QuestionView,
	type WorkerMessage,
} from "../worker/protocol.ts";
import { DEFAULT_RELAY, relayProblem } from "../worker/settings.ts";
import {
	cardView,
	confirms,
	hasNewGrant,
	SWITCH_WAIT_MS,
	type SwitchIntent,
	switchShown,
} from "./card.ts";
import { byId, h } from "./dom.ts";
import { copyText, startSetup } from "./setup.ts";
import type { PanelState } from "./state.ts";
import { panelWindow } from "./window.ts";

/** Firefox: the user said no to its question about the data AI access sends. */
export const NO_CONSENT_ANSWER =
	"AI access sends the pages' marks, comments, screenshots, element details and addresses to your AI app, and Firefox was not allowed to let it. Turn it on again to be asked again.";

declare const SITEGLOSS_TEST_BUILD: boolean | undefined;
declare const SITEGLOSS_FIREFOX: boolean | undefined;

/** How long the panel must be visible and focused before Allow and Always allow count. */
const ALLOW_DELAY_MS = 750;
/** After a first click on New address with apps connected: the second makes it. */
const NEW_ADDRESS_ARMED_MS = 4000;

/** How long the panel waits for the worker's Blur form fields before it starts an overlay. */
const BLUR_KNOWN_MS = 2000;

/** The worker's Blur form fields, as its last state said; `undefined` before one came. */
let blurValue: boolean | undefined;
let blurSettled: () => void = () => {};
/** The worker answered: with a state, or that it failed. */
const blurReady = new Promise<void>((resolve) => {
	blurSettled = resolve;
});

/**
 * "Blur form fields in screenshots", for an overlay the panel starts: the
 * worker's value once its first state came (a moment after the panel
 * opened). Without one in time, or when the worker failed, blur: the safe
 * side. The worker tells open overlays its value when it starts and when a
 * panel attaches, so a guess does not stay.
 */
export function blurFormsNow(): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		blurReady,
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, BLUR_KNOWN_MS);
		}),
	])
		.finally(() => clearTimeout(timer))
		.then(() => blurValue ?? true);
}

/** The panel's header text for the connection's state. */
export function statusText(a: AiState): string {
	if (a.state === "connected")
		return a.grants.length > 0
			? `Connected: ${a.grants.map((g) => g.name || g.host).join(", ")}`
			: "Waiting for an AI app to pair";
	if (a.state === "connecting") return "Connecting…";
	if (a.state === "reconnecting") return "Connection lost, retrying…";
	const problem =
		a.problem &&
		`Not connected: ${a.problem}${a.retrying ? " Trying again…" : ""}`;
	const replaced =
		a.replaced && "Not connected: the address is in use elsewhere.";
	return (
		[a.relayNote, replaced ?? problem].filter(Boolean).join(" ") ||
		"Not connected"
	);
}

/**
 * Whether `statusText(a)` tells of something wrong: the connection failed, was
 * lost or was taken over, or the saved relay cannot be used. Connected or
 * connecting, all is well.
 */
export function problemOf(a: AiState): "connection" | undefined {
	if (a.state === "connected" || a.state === "connecting") return undefined;
	return a.state === "reconnecting" ||
		a.problem !== undefined ||
		a.replaced !== undefined ||
		a.relayNote !== undefined
		? "connection"
		: undefined;
}

/**
 * Start the panel's side of the connection; `update` changes the panel's
 * state, `showSettings` opens the Settings view, where the card is (an open
 * case stays open underneath, DEC-023).
 */
export async function startAi(
	update: (change: (s: PanelState) => void) => void,
	showSettings: () => void,
): Promise<void> {
	const relayInput = byId<HTMLInputElement>("relay");
	const keepOn = byId<HTMLInputElement>("keep-on");
	const blurForms = byId<HTMLInputElement>("blur-forms");
	const aiSwitch = byId<HTMLInputElement>("ai-switch");
	const buttons = [
		byId<HTMLButtonElement>("ai-button"),
		byId<HTMLButtonElement>("connect"),
		byId<HTMLButtonElement>("stop-ai"),
	];

	// The panel's page opened in a tab by its address is no side panel: the
	// worker does not talk to it (DEC-015). But in Firefox's test build, as
	// automation cannot reach the sidebar (the defines themselves, not
	// `browser.ts`'s constants, so other builds drop the code).
	if (
		!(
			typeof SITEGLOSS_TEST_BUILD !== "undefined" &&
			SITEGLOSS_TEST_BUILD &&
			typeof SITEGLOSS_FIREFOX !== "undefined" &&
			SITEGLOSS_FIREFOX
		) &&
		(await chrome.tabs.getCurrent()) !== undefined
	) {
		update(
			(s) =>
				(s.ai = {
					...s.ai,
					status: `Open the ${PANEL} from the Sitegloss icon for AI access`,
					problem: "tab",
				}),
		);
		for (const b of buttons) b.disabled = true;
		keepOn.disabled = true;
		relayInput.disabled = true;
		blurForms.disabled = true;
		aiSwitch.disabled = true;
		blurSettled();
		return;
	}

	const setup = startSetup();
	const windowId = await panelWindow();
	let port: chrome.runtime.Port | undefined;
	let current: AiState | undefined;
	/** What the worker was told: pairing on (codes come only then). */
	let pairing = false;
	/** The user asked to add another AI app (with apps paired already). */
	let addingApp = false;
	/** The apps paired when "+ Add another AI app" was clicked. */
	let knownGrants: ReadonlySet<string> = new Set();
	/** Disconnect asks first: the apps whose button was clicked once. */
	const disconnectArmed = new Map<
		string,
		{ at: number; timer: ReturnType<typeof setTimeout> }
	>();
	/** The user's flip of the AI access switch, while the worker acts on it. */
	let switchIntent: SwitchIntent | undefined;
	let newAddressArmedAt: number | undefined;

	function send(command: PanelCommand): void {
		try {
			port?.postMessage(command);
		} catch {
			// The worker went away; the port reconnects and the view follows.
		}
	}

	/**
	 * The port to the worker. Chrome ends it when the worker stops (an update,
	 * a reload): connect again, which starts the worker.
	 */
	function connectPort(): void {
		let opened: chrome.runtime.Port;
		try {
			opened = chrome.runtime.connect({ name: PANEL_PORT });
		} catch {
			// The extension was updated or reloaded: this panel belongs to the
			// version before and can reach nothing any more.
			port = undefined;
			update(
				(s) =>
					(s.ai = {
						...s.ai,
						status: "Sitegloss was updated: close and open this panel again.",
						// Nothing it showed before holds: it can reach nothing.
						problem: "updated",
						connected: false,
						apps: 0,
						active: false,
					}),
			);
			return;
		}
		port = opened;
		opened.onMessage.addListener((news: WorkerMessage) => {
			if (news?.type === "state") show(news.state);
			else if (news?.type === "failed") failed(news.problem);
		});
		opened.onDisconnect.addListener(() => {
			if (port === opened) port = undefined;
			setTimeout(connectPort, 250);
		});
		if (windowId !== undefined) send({ type: "hello", windowId });
		sendVisible();
		if (pairing) send({ type: "pair", on: true });
	}

	/** The worker's connection could not start: nothing here can work. */
	function failed(problem: string): void {
		document.documentElement.dataset["aiState"] = "failed";
		blurValue = undefined;
		blurSettled();
		for (const b of buttons) b.disabled = true;
		keepOn.disabled = true;
		relayInput.disabled = true;
		blurForms.disabled = true;
		aiSwitch.disabled = true;
		update(
			(s) =>
				(s.ai = {
					...s.ai,
					status: `AI access is not available: ${problem}`,
					problem: "unavailable",
					connected: false,
					apps: 0,
					active: false,
				}),
		);
	}

	function show(a: AiState): void {
		current = a;
		// The library's state, as the worker last said it.
		document.documentElement.dataset["aiState"] = a.state;
		const connected = a.state === "connected";
		update((s) => {
			s.ai = {
				...s.ai,
				status: statusText(a),
				problem: problemOf(a),
				connected,
				apps: connected ? a.grants.length : 0,
				active: a.state !== "disconnected" || a.retrying,
				keepOn: a.keepOn,
				lastCall: a.lastCall,
			};
		});
		// A worker that failed before may have started since.
		for (const control of [...buttons, keepOn, relayInput, blurForms, aiSwitch])
			control.disabled = false;
		blurForms.checked = a.blurForms;
		blurValue = a.blurForms;
		blurSettled();
		if (document.activeElement !== relayInput) {
			relayInput.value = a.relay;
			relayInput.setCustomValidity("");
		}
		showCard(a);
		showQuestions(a.questions);
	}

	// --- Commands ---

	/**
	 * Send `command`, which turns AI access on: in Firefox once the user has
	 * allowed that the AI app gets the pages' content and addresses (its
	 * data collection consent). Firefox asks only in the click: call this in
	 * it, before any await. A no leaves AI access off, and says why.
	 */
	function turnOn(command: PanelCommand, refused: () => void = () => {}): void {
		if (!FIREFOX) {
			send(command);
			return;
		}
		askDataConsent().then(
			(yes) => {
				if (yes) send(command);
				else {
					refused();
					update(
						(s) =>
							(s.ai = {
								...s.ai,
								status: `Not connected: ${NO_CONSENT_ANSWER}`,
							}),
					);
				}
			},
			(error: unknown) => {
				refused();
				update(
					(s) =>
						(s.ai = {
							...s.ai,
							status: `Not connected: Firefox could not ask for the consent (${error instanceof Error ? error.message : String(error)}).`,
						}),
				);
			},
		);
	}

	/** The top bar's pill: to the card in Settings, turning AI access on if it is off. */
	byId<HTMLButtonElement>("ai-button").addEventListener("click", () => {
		if (current !== undefined && cardView(current, false).turnOn)
			turnOn({ type: "connect" });
		showSettings();
		// After the render that shows the Settings view.
		setTimeout(() => byId("ai-card").scrollIntoView({ block: "nearest" }));
	});

	byId<HTMLButtonElement>("connect").addEventListener("click", () =>
		turnOn({ type: "connect" }),
	);

	byId<HTMLButtonElement>("stop-ai").addEventListener("click", () =>
		send({ type: "stop" }),
	);

	aiSwitch.addEventListener("change", () => {
		const intent = { on: aiSwitch.checked, until: Date.now() + SWITCH_WAIT_MS };
		switchIntent = intent;
		addingApp = false;
		if (aiSwitch.checked)
			turnOn({ type: "connect" }, () => {
				switchIntent = undefined;
				if (current) showCard(current);
				else aiSwitch.checked = false;
			});
		else send({ type: "stop" });
		// No state that matches the flip: the switch shows the state again.
		setTimeout(() => {
			if (switchIntent === intent && current) showCard(current);
		}, SWITCH_WAIT_MS);
	});

	function addApp(on: boolean): void {
		addingApp = on;
		// The apps already paired: one more connecting ends adding it.
		knownGrants = new Set(current?.grants.map((g) => g.grantId));
		if (current) showCard(current);
	}

	byId<HTMLButtonElement>("add-app").addEventListener("click", () =>
		addApp(true),
	);
	byId<HTMLButtonElement>("pair-done").addEventListener("click", () =>
		addApp(false),
	);

	keepOn.addEventListener("change", () => {
		if (keepOn.checked)
			turnOn({ type: "keep-on", on: true }, () => {
				keepOn.checked = current?.keepOn ?? false;
			});
		else send({ type: "keep-on", on: false });
	});

	// The worker keeps it and tells the overlays already open.
	blurForms.addEventListener("change", () =>
		send({ type: "blur-forms", on: blurForms.checked }),
	);

	relayInput.addEventListener("change", () => {
		const value = relayInput.value.trim();
		const problem = relayProblem(value);
		if (problem !== undefined) {
			relayInput.setCustomValidity(problem);
			relayInput.reportValidity();
			return;
		}
		relayInput.setCustomValidity("");
		addApp(false);
		send({ type: "set-relay", relay: value });
	});

	/** A Copy in the pairing box; a refused clipboard selects what it shows. */
	function copy(
		button: HTMLButtonElement,
		text: string | undefined,
		noun: string,
		shown: HTMLElement,
	): void {
		if (text !== undefined) copyText(button, text, noun, shown, setup.announce);
	}

	const copyAddress = byId<HTMLButtonElement>("pair-copy");
	copyAddress.addEventListener("click", () =>
		copy(copyAddress, current?.address, "address", byId("pair-address")),
	);
	const copyCode = byId<HTMLButtonElement>("pair-copy-code");
	copyCode.addEventListener("click", () =>
		copy(copyCode, current?.code, "code", byId("pair-code")),
	);

	byId<HTMLButtonElement>("pair-take-back").addEventListener("click", () =>
		turnOn({ type: "connect" }),
	);

	// Under the code, and in the takeover notice: there AI access is off and
	// the code is hidden, and a new address is what drops the apps paired
	// with the address taken over.
	const newAddressButtons = [
		"pair-new-address",
		"pair-replaced-new-address",
	].map((id) => byId<HTMLButtonElement>(id));
	const newAddressText = (text: string) => {
		for (const b of newAddressButtons) b.textContent = text;
	};
	for (const button of newAddressButtons)
		button.addEventListener("click", () => {
			const armed =
				newAddressArmedAt !== undefined &&
				Date.now() - newAddressArmedAt < NEW_ADDRESS_ARMED_MS;
			// With apps connected it asks first: they all have to pair again.
			if ((current?.grants.length ?? 0) > 0 && !armed) {
				newAddressArmedAt = Date.now();
				newAddressText("Really? Every app must pair again");
				setTimeout(() => {
					newAddressArmedAt = undefined;
					newAddressText("New address");
				}, NEW_ADDRESS_ARMED_MS);
				return;
			}
			newAddressArmedAt = undefined;
			newAddressText("New address");
			send({ type: "new-address" });
		});

	// --- The card ---

	/** Tell the worker whether to pair (codes come only then). */
	function syncPairing(on: boolean): void {
		if (on === pairing) return;
		pairing = on;
		send({ type: "pair", on });
	}

	function disconnectButton(grant: AiState["grants"][number]): HTMLElement {
		const armed = disconnectArmed.has(grant.grantId);
		return h(
			"button",
			{
				type: "button",
				"data-focus": "disconnect",
				"data-armed": armed ? "" : false,
				title: armed
					? "Click again to disconnect this app"
					: "Remove this app (click twice): it can no longer reach Sitegloss, and must be added and paired again to come back",
				onclick: () => {
					const first = disconnectArmed.get(grant.grantId);
					if (first === undefined) {
						// Asks first: the app has to be added and paired again after.
						disconnectArmed.set(grant.grantId, {
							at: Date.now(),
							timer: setTimeout(() => {
								disconnectArmed.delete(grant.grantId);
								if (current) showCard(current);
							}, NEW_ADDRESS_ARMED_MS),
						});
					} else {
						// The second click of a double click confirms nothing.
						if (!confirms(first.at, Date.now())) return;
						clearTimeout(first.timer);
						disconnectArmed.delete(grant.grantId);
						send({ type: "revoke", grantId: grant.grantId });
					}
					if (current) showCard(current);
				},
			},
			armed ? "Disconnect? Click again" : "Disconnect",
		);
	}

	/**
	 * What the card lets the user change for an AI app: "Allow all changes",
	 * and the tools always allowed, each with "Ask again".
	 */
	function grantAllows(grant: AiState["grants"][number]): HTMLElement[] {
		const app = grant.name || grant.host;
		const parts: HTMLElement[] = [
			h(
				"label",
				{
					class: "switch small",
					title: `On: every change ${app} asks for runs without asking you, until you disconnect it`,
				},
				h("input", {
					type: "checkbox",
					role: "switch",
					"data-focus": "allow-all",
					"aria-checked": String(grant.allowAll),
					checked: grant.allowAll,
					onchange: (event: Event) =>
						send({
							type: "allow-all",
							grantId: grant.grantId,
							on: (event.currentTarget as HTMLInputElement).checked,
						}),
				}),
				h("span", {}, "Allow all changes"),
			),
		];
		if (grant.allowAll)
			parts.push(
				h(
					"p",
					{ class: "meta" },
					`Every change ${app} asks for runs without asking you, deleting a case too, until you disconnect it.`,
				),
			);
		if (grant.always.length > 0)
			parts.push(
				h(
					"ul",
					{ class: "always", "aria-label": `Always allowed for ${app}` },
					...grant.always.map(({ tool, title }) =>
						h(
							"li",
							{ "data-tool": tool },
							h("span", { class: "meta" }, `Always allowed: ${title}`),
							h(
								"button",
								{
									type: "button",
									class: "link",
									"data-focus": `ask-again:${tool}`,
									"aria-label": `Ask again before ${title}`,
									title: `Ask you again each time ${app} wants to run ${title}`,
									onclick: () =>
										send({ type: "ask-again", grantId: grant.grantId, tool }),
								},
								"Ask again",
							),
						),
					),
				),
			);
		return parts;
	}

	function showCard(a: AiState): void {
		// Adding another app ends with the connection.
		if (a.state !== "connected") addingApp = false;
		// And with the app being added connecting: the box has done its job.
		if (addingApp && hasNewGrant(knownGrants, a)) addingApp = false;
		const view = cardView(a, addingApp);
		byId("ai-state").dataset["state"] = view.status;
		byId("ai-state-text").textContent = view.stateText;
		// Also while connecting or retrying, so the user can stop it.
		const shown = switchShown(view.switchOn, switchIntent, Date.now());
		switchIntent = shown.intent;
		aiSwitch.checked = shown.checked;
		aiSwitch.setAttribute("aria-checked", String(shown.checked));
		byId("connect").hidden = !view.turnOn;
		byId("pair-replaced").hidden = a.replaced === undefined;
		byId("pair-replaced-text").textContent = a.replaced?.sibling
			? "Sitegloss's address is in use elsewhere in this browser."
			: "Another tab or program took over this address, and the AI apps paired with it may now talk to it. Make a new address to disconnect them.";
		const problem = [
			a.relayNote,
			a.state === "disconnected" ? a.problem : undefined,
			// A Disconnect that did not work, named by its app.
			...a.grants.map((g) => g.problem),
		]
			.filter(Boolean)
			.join(" ");
		byId("pair-problem").hidden = problem === "";
		byId("pair-problem").textContent = problem;
		for (const id of disconnectArmed.keys())
			if (!a.grants.some((g) => g.grantId === id)) {
				clearTimeout(disconnectArmed.get(id)?.timer);
				disconnectArmed.delete(id);
			}
		// Redrawn on every state: the control that had the keyboard's focus
		// keeps it, so Enter can confirm a Disconnect.
		const active = document.activeElement as HTMLElement | null;
		const focused = active?.closest<HTMLElement>("#pair-grants li[data-grant]")
			?.dataset["grant"];
		const focusedControl = active?.dataset["focus"];
		byId("pair-grants").replaceChildren(
			...a.grants.map((grant) =>
				h(
					"li",
					{ "data-grant": grant.grantId },
					h(
						"div",
						{ class: "grant-head" },
						h(
							"span",
							{},
							grant.name || grant.host,
							grant.name
								? h("span", { class: "meta" }, ` ${grant.host}`)
								: null,
						),
						disconnectButton(grant),
					),
					...grantAllows(grant),
				),
			),
		);
		if (focused !== undefined) {
			const item = byId("pair-grants").querySelector(
				`li[data-grant="${CSS.escape(focused)}"]`,
			);
			// The same control, or, when it went (an "Ask again" takes its own
			// tool away), the nearest one still there in the same app.
			const at = (selector: string) =>
				item?.querySelector<HTMLElement>(selector) ?? null;
			(
				at(`[data-focus="${CSS.escape(focusedControl ?? "disconnect")}"]`) ??
				(focusedControl?.startsWith("ask-again:")
					? (at('[data-focus^="ask-again:"]') ?? at('[data-focus="allow-all"]'))
					: null) ??
				at('[data-focus="disconnect"]')
			)?.focus();
		}
		syncPairing(view.pairing);
		byId("pairing").hidden = !view.pairing;
		byId("add-app").hidden = !view.addApp;
		byId("pair-done").hidden = !view.done;
		// The address only while pairing: it is what an AI app is added with.
		byId("pair-address").textContent = view.address;
		setup.show(view.address);
		const code = a.code;
		byId("pair-code").textContent =
			code === undefined ? "––– –––" : `${code.slice(0, 3)} ${code.slice(3)}`;
		byId<HTMLButtonElement>("pair-copy-code").disabled = code === undefined;
	}

	// --- Questions ---

	/**
	 * Arguments the box cannot show at once say how long they are, so that
	 * nobody takes the start for all: decided by the box's overflow once it
	 * is laid out, and again whenever its size changes.
	 */
	function scrollNote(pre: Element): void {
		const note = pre.parentElement?.querySelector("[data-scroll-note]");
		if (note === null || note === undefined) return;
		note.textContent =
			pre.scrollHeight > pre.clientHeight
				? ` (${(pre.textContent ?? "").length.toLocaleString("en-US")} characters: scroll to read all of them)`
				: "";
	}
	const overflow = new ResizeObserver((entries) => {
		for (const { target } of entries) scrollNote(target);
	});

	/** Since when the panel has been visible and focused, if it is. */
	let focusedSince: number | undefined;
	const cards = new Map<string, { card: HTMLElement; shownAt: number }>();
	const list = byId("questions");

	function question(q: QuestionView): HTMLElement {
		const titles: Record<Answer, string> = {
			deny: "Refuse this call; nothing changes",
			allow: "Run this call once; the app asks again next time",
			always: `Run this call, and from now on ${q.title ?? q.tool} for ${q.app} without asking, until you disconnect it`,
		};
		const answer = (text: string, value: Answer, primary = false) =>
			h(
				"button",
				{
					type: "button",
					"data-answer": value,
					title: titles[value],
					// Not amber: that is the view's one action that starts drawing.
					class: primary ? "strong" : false,
					// Allow and Always allow only once the panel has been in front a
					// while: the click that brings it forward cannot approve.
					disabled: value !== "deny",
					onclick: (event: Event) => {
						if (!(event.currentTarget as HTMLButtonElement).disabled)
							send({ type: "answer", id: q.id, answer: value });
					},
				},
				text,
			);
		return h(
			"section",
			{ class: "question", "data-question": q.id },
			h(
				"p",
				{},
				h("strong", {}, `${q.app} wants to run ${q.title ?? q.tool}.`),
			),
			...q.lines.map((line) => h("p", {}, line)),
			h(
				"p",
				{ class: "meta" },
				`Tool ${q.tool}, with these arguments`,
				h("span", { "data-scroll-note": "" }),
				":",
			),
			// All of them, scrolling: what is allowed is what was shown (CR-03).
			h("pre", {}, q.args),
			h(
				"div",
				{ class: "row" },
				answer("Don't allow", "deny"),
				answer("Allow", "allow", true),
				answer("Always allow", "always"),
			),
			// Firefox leaves the focus in the page when its sidebar opens, and
			// Allow counts only in a panel that has it.
			...(FIREFOX
				? [
						h(
							"p",
							{ class: "meta", "data-focus-hint": "", hidden: true },
							`Click into the ${PANEL} to answer: Allow counts once it has the focus.`,
						),
					]
				: []),
			h(
				"p",
				{ class: "meta" },
				`Always allow: ${q.title ?? q.tool} runs without asking for ${q.app}, until you disconnect it.`,
			),
		);
	}

	function showQuestions(questions: QuestionView[]): void {
		const ids = new Set(questions.map((q) => q.id));
		let removed = false;
		for (const [id, { card }] of cards)
			if (!ids.has(id)) {
				const pre = card.querySelector("pre");
				if (pre !== null) overflow.unobserve(pre);
				card.remove();
				cards.delete(id);
				removed = true;
			}
		// What moved up under the pointer waits again, as if just shown.
		if (removed) for (const entry of cards.values()) entry.shownAt = Date.now();
		for (const q of questions)
			if (!cards.has(q.id)) {
				const card = question(q);
				list.append(card);
				const pre = card.querySelector("pre");
				if (pre !== null) {
					scrollNote(pre);
					overflow.observe(pre);
				}
				cards.set(q.id, { card, shownAt: Date.now() });
			}
		arm();
	}

	/**
	 * Allow and Always allow count once the panel has been visible and focused for
	 * ALLOW_DELAY_MS with the question shown; leaving it starts the wait again.
	 */
	function arm(): void {
		const now = Date.now();
		if (document.visibilityState === "visible" && document.hasFocus())
			focusedSince ??= now;
		else focusedSince = undefined;
		for (const { card, shownAt } of cards.values()) {
			const ready =
				focusedSince !== undefined &&
				now - Math.max(shownAt, focusedSince) >= ALLOW_DELAY_MS;
			for (const b of card.querySelectorAll<HTMLButtonElement>(
				'button[data-answer="allow"], button[data-answer="always"]',
			))
				b.disabled = !ready;
			const hint = card.querySelector<HTMLElement>("[data-focus-hint]");
			if (hint !== null) hint.hidden = focusedSince !== undefined;
		}
	}

	setInterval(() => {
		if (cards.size > 0) arm();
	}, 100);
	for (const type of ["focus", "blur", "visibilitychange"])
		window.addEventListener(type, arm);

	/** Tell the worker whether the panel is on screen (not covered by another's). */
	function sendVisible(): void {
		send({ type: "visible", visible: document.visibilityState === "visible" });
	}
	document.addEventListener("visibilitychange", sendVisible);

	update((s) => (s.ai = { ...s.ai, status: "Not connected" }));
	relayInput.value = DEFAULT_RELAY;
	connectPort();
}
