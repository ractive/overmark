/**
 * The side panel's view of the AI connection, which lives in the service
 * worker (DEC-015). It shows the state the worker sends over the panel's
 * port, in the header (through the panel's state, `s.ai`) and in the "AI app"
 * card and the questions (drawn here), and sends the user's commands back.
 * Closing the panel changes nothing but pairing, which stops.
 *
 * The card is the tab-mcp extension's (its `sidepanel/card.ts`), with
 * Overmark's relay and "Keep AI access on" under it.
 * "Blur form fields in screenshots" goes the same way: the worker keeps it,
 * and the panel neither reads nor writes it in storage (DEC-016).
 */

import {
	type AiState,
	type Answer,
	PANEL_PORT,
	type PanelCommand,
	type QuestionView,
	type WorkerMessage,
} from "../worker/protocol.ts";
import {
	DEFAULT_RELAY,
	relayProblem,
	SECRET_PREFIX,
} from "../worker/settings.ts";
import {
	cardView,
	confirms,
	SWITCH_WAIT_MS,
	type SwitchIntent,
	switchShown,
} from "./card.ts";
import { byId, h } from "./dom.ts";
import type { PanelState } from "./state.ts";

/** How long the panel must be visible and focused before Allow counts. */
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

/** What the panel kept in `localStorage` before the connection moved. */
const OLD_KEYS = {
	relay: "overmark:relay",
	keepOn: "overmark:keep-ai-on",
	blurForms: "overmark:blur-forms",
} as const;

/** The panel's header text for the connection's state. */
export function statusText(a: AiState): string {
	if (a.state === "connected")
		return a.grants.length > 0
			? `Connected: ${a.grants.map((g) => g.name || g.host).join(", ")}`
			: "Waiting for an AI app to pair";
	if (a.state === "connecting") return "Connecting…";
	if (a.reconnecting) return "Connection lost, retrying…";
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
 * The settings and address secrets this panel kept in `localStorage`, for
 * the worker to take over once; `undefined` if there are none. Until
 * 2026-11-09 the default relay was one on this computer, and nothing was
 * saved for it: a panel that connected there (the library keeps a secret per
 * relay) stays with it.
 */
export function oldSettings(
	storage: Pick<Storage, "getItem" | "key" | "length">,
): Extract<PanelCommand, { type: "migrate" }> | undefined {
	const secrets: Record<string, string> = {};
	for (let i = 0; i < storage.length; i++) {
		const key = storage.key(i);
		if (key?.startsWith(SECRET_PREFIX)) {
			const value = storage.getItem(key);
			if (value !== null) secrets[key] = value;
		}
	}
	const relay = storage.getItem(OLD_KEYS.relay);
	const keepOn = storage.getItem(OLD_KEYS.keepOn);
	const blurForms = storage.getItem(OLD_KEYS.blurForms);
	if (
		relay === null &&
		keepOn === null &&
		blurForms === null &&
		Object.keys(secrets).length === 0
	)
		return undefined;
	const old = "http://localhost:8080";
	const legacy =
		relay === null && `${SECRET_PREFIX}${old}:overmark` in secrets
			? old
			: undefined;
	const chosen = relay ?? legacy;
	return {
		type: "migrate",
		...(chosen !== undefined ? { relay: chosen } : {}),
		...(keepOn !== null ? { keepOn: keepOn === "true" } : {}),
		...(blurForms !== null ? { blurForms: blurForms === "true" } : {}),
		secrets,
	};
}

function forgetOldSettings(): void {
	try {
		for (const key of Object.values(OLD_KEYS)) localStorage.removeItem(key);
		for (let i = localStorage.length - 1; i >= 0; i--) {
			const key = localStorage.key(i);
			if (key?.startsWith(SECRET_PREFIX)) localStorage.removeItem(key);
		}
	} catch {
		// Storage blocked: nothing kept there either.
	}
}

/**
 * Start the panel's side of the connection; `update` changes the panel's
 * state, `showHome` leaves an open case for the home view, where the card is.
 */
export async function startAi(
	update: (change: (s: PanelState) => void) => void,
	showHome: () => void,
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
	// worker does not talk to it (DEC-015).
	if ((await chrome.tabs.getCurrent()) !== undefined) {
		update(
			(s) =>
				(s.ai = {
					...s.ai,
					status: "Open the side panel from the Overmark icon for AI access",
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

	const windowId = (await chrome.windows.getCurrent()).id;
	let port: chrome.runtime.Port | undefined;
	let current: AiState | undefined;
	/** What the worker was told: pairing on (codes come only then). */
	let pairing = false;
	/** The user asked to add another AI app (with apps paired already). */
	let addingApp = false;
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
						status: "Overmark was updated: close and open this panel again.",
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
		let old: PanelCommand | undefined;
		try {
			old = oldSettings(localStorage);
		} catch {
			// Storage blocked: nothing kept there either.
		}
		if (old !== undefined) send(old);
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
				}),
		);
	}

	function show(a: AiState): void {
		current = a;
		// The library's state, as the worker last said it.
		document.documentElement.dataset["aiState"] = a.state;
		if (a.migrated) forgetOldSettings();
		const connected = a.state === "connected";
		update((s) => {
			s.ai = {
				...s.ai,
				status: statusText(a),
				connected,
				active: a.state !== "disconnected" || a.reconnecting || a.retrying,
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

	/** The header's pill: to the card, turning AI access on if it is off. */
	byId<HTMLButtonElement>("ai-button").addEventListener("click", () => {
		if (current !== undefined && cardView(current, false).turnOn)
			send({ type: "connect" });
		showHome();
		// After the render that shows the home view.
		setTimeout(() => byId("ai-card").scrollIntoView({ block: "nearest" }));
	});

	byId<HTMLButtonElement>("connect").addEventListener("click", () =>
		send({ type: "connect" }),
	);

	byId<HTMLButtonElement>("stop-ai").addEventListener("click", () =>
		send({ type: "stop" }),
	);

	aiSwitch.addEventListener("change", () => {
		switchIntent = { on: aiSwitch.checked, until: Date.now() + SWITCH_WAIT_MS };
		addingApp = false;
		send({ type: aiSwitch.checked ? "connect" : "stop" });
	});

	function addApp(on: boolean): void {
		addingApp = on;
		if (current) showCard(current);
	}

	byId<HTMLButtonElement>("add-app").addEventListener("click", () =>
		addApp(true),
	);
	byId<HTMLButtonElement>("pair-done").addEventListener("click", () =>
		addApp(false),
	);

	keepOn.addEventListener("change", () =>
		send({ type: "keep-on", on: keepOn.checked }),
	);

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

	function copy(button: HTMLButtonElement, text: string | undefined): void {
		if (text === undefined) return;
		navigator.clipboard.writeText(text).then(
			() => {
				button.textContent = "Copied";
				setTimeout(() => {
					button.textContent = "Copy";
				}, 1500);
			},
			() => undefined,
		);
	}

	const copyAddress = byId<HTMLButtonElement>("pair-copy");
	copyAddress.addEventListener("click", () =>
		copy(copyAddress, current?.address),
	);
	const copyCode = byId<HTMLButtonElement>("pair-copy-code");
	copyCode.addEventListener("click", () => copy(copyCode, current?.code));

	byId<HTMLButtonElement>("pair-take-back").addEventListener("click", () =>
		send({ type: "connect" }),
	);

	const newAddress = byId<HTMLButtonElement>("pair-new-address");
	newAddress.addEventListener("click", () => {
		const armed =
			newAddressArmedAt !== undefined &&
			Date.now() - newAddressArmedAt < NEW_ADDRESS_ARMED_MS;
		// With apps connected it asks first: they all have to pair again.
		if ((current?.grants.length ?? 0) > 0 && !armed) {
			newAddressArmedAt = Date.now();
			newAddress.textContent = "Really? Every app must pair again";
			setTimeout(() => {
				newAddressArmedAt = undefined;
				newAddress.textContent = "New address";
			}, NEW_ADDRESS_ARMED_MS);
			return;
		}
		newAddressArmedAt = undefined;
		newAddress.textContent = "New address";
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
				"data-armed": armed ? "" : false,
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

	function showCard(a: AiState): void {
		// Adding another app ends with the connection.
		if (a.state !== "connected") addingApp = false;
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
			? "Overmark's address is in use elsewhere in this browser."
			: "Another tab or program took over this address, and the AI apps paired with it may now talk to it. Make a new address to disconnect them.";
		const problem = [
			a.relayNote,
			a.state === "disconnected" ? a.problem : undefined,
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
		byId("pair-grants").replaceChildren(
			...a.grants.map((grant) =>
				h(
					"li",
					{ "data-grant": grant.grantId },
					h(
						"span",
						{},
						grant.name || grant.host,
						grant.name ? h("span", { class: "meta" }, ` ${grant.host}`) : null,
					),
					disconnectButton(grant),
				),
			),
		);
		syncPairing(view.pairing);
		byId("pairing").hidden = !view.pairing;
		byId("add-app").hidden = !view.addApp;
		byId("pair-done").hidden = !view.done;
		// The address only while pairing: it is what an AI app is added with.
		byId("pair-address").textContent = view.address;
		const code = a.code;
		byId("pair-code").textContent =
			code === undefined ? "––– –––" : `${code.slice(0, 3)} ${code.slice(3)}`;
		byId<HTMLButtonElement>("pair-copy-code").disabled = code === undefined;
	}

	// --- Questions ---

	/** Since when the panel has been visible and focused, if it is. */
	let focusedSince: number | undefined;
	const cards = new Map<string, { card: HTMLElement; shownAt: number }>();
	const list = byId("questions");

	function question(q: QuestionView): HTMLElement {
		const answer = (text: string, value: Answer, primary = false) =>
			h(
				"button",
				{
					type: "button",
					"data-answer": value,
					class: primary ? "primary" : false,
					// Allow only once the panel has been in front a while: the click
					// that brings it forward cannot approve.
					disabled: value === "allow",
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
			h("p", { class: "meta" }, `Tool ${q.tool}, with these arguments:`),
			h("pre", {}, q.args),
			h(
				"div",
				{ class: "row" },
				answer("Don't allow", "deny"),
				answer("Allow", "allow", true),
			),
		);
	}

	function showQuestions(questions: QuestionView[]): void {
		const ids = new Set(questions.map((q) => q.id));
		let removed = false;
		for (const [id, { card }] of cards)
			if (!ids.has(id)) {
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
				cards.set(q.id, { card, shownAt: Date.now() });
			}
		arm();
	}

	/**
	 * Allow counts once the panel has been visible and focused for
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
				'button[data-answer="allow"]',
			))
				b.disabled = !ready;
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
