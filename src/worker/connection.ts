/**
 * The connection to the user's AI app, in the service worker (DEC-015): the
 * library's `TabMcp` with Overmark's tools, the questions of tools that
 * change something, and the state the side panels show. A WebSocket that
 * carries messages keeps the worker alive (Chrome 116), and the relay's
 * heartbeat (a ping every 25 s, answered) carries some even when nothing
 * else happens. While AI access is on, an alarm wakes the worker once a
 * minute, and every worker start connects again: always with "Keep AI
 * access on", else until the browser closes or the extension is updated,
 * reloaded or disabled (all of which clear `chrome.storage.session`). The
 * settings and the address secret are in the worker's own IndexedDB
 * (`kv.ts`, DEC-016), out of content scripts' reach, as is what each AI app
 * may do without asking (`always.ts`, DEC-018).
 */

import {
	type ConfirmAnswer,
	type ConfirmRequest,
	type ConnectionState,
	type StateChangeDetail,
	TabMcp,
} from "@ractive-ch/tab-mcp-client";
import { cropImages, scaleImage, toWebp } from "../lib/images.ts";
import type { Broadcast, ContentRequest } from "../lib/messages.ts";
import type { CaseStore } from "../lib/store.ts";
import { AlwaysAllowed } from "./always.ts";
import { badge } from "./badge.ts";
import { decide } from "./decide.ts";
import { endedProblem, KeepOn } from "./keep-on.ts";
import { type Kv, openKv, removeOldSettings } from "./kv.ts";
import {
	type AiState,
	type CallView,
	type PanelCommand,
	parseCommand,
	SERVER_NAME,
	type WorkerMessage,
} from "./protocol.ts";
import { appName, Questions, type QuestionsHost } from "./questions.ts";
import { CachedSecretStorage } from "./secret.ts";
import {
	DEFAULT_RELAY,
	KEYS,
	loadSettings,
	type Replaced,
	relayProblem,
	SESSION_ON,
	SESSION_STOPPED,
	type Settings,
	saveReplaced,
} from "./settings.ts";
import { type Capture, tabInFront, workerTab } from "./tab.ts";
import {
	confirmLines,
	createTools,
	INSTRUCTIONS,
	type TabBridge,
} from "./tools.ts";

/** Wakes the worker while AI access is on, should the connection be down. */
export const ALARM = "overmark-ai";

/** One open side panel. */
interface Panel {
	port: chrome.runtime.Port;
	windowId?: number;
	/** It shows the address and code. */
	pairing: boolean;
	/** On screen, as it last said (covered by another extension's panel: not). */
	visible: boolean;
}

export interface ConnectionDeps {
	store: CaseStore;
	capture: Capture;
	/** A tool changed or deleted a case (the sync writes it, DEC-021). */
	changed?: (caseId: string) => void;
	/** The settings database: `openKv()` unless given (a memory one in tests). */
	kv?: Kv;
}

/** Clear every notification of the extension: a previous worker's questions died with it. */
async function clearNotifications(): Promise<void> {
	try {
		const all = await chrome.notifications.getAll();
		await Promise.all(
			Object.keys(all).map((id) => chrome.notifications.clear(id)),
		);
	} catch {
		// None to clear, or notifications not available.
	}
}

/**
 * Close `chrome.storage.local` to content scripts, which may read and write
 * it by default. Only an extra layer (DEC-016): nothing is kept there any
 * more, and not every Chrome takes this for the local area, so a refusal is
 * only logged.
 */
async function restrictStorage(): Promise<void> {
	try {
		await chrome.storage.local.setAccessLevel({
			accessLevel: "TRUSTED_CONTEXTS",
		});
	} catch (error) {
		console.warn("Overmark: storage access level", error);
	}
}

/** Tell every tab's overlay, whatever a tab answers. */
async function tellTabs(news: ContentRequest): Promise<void> {
	try {
		for (const { id } of await chrome.tabs.query({}))
			if (id !== undefined)
				chrome.tabs.sendMessage(id, news).catch(() => undefined);
	} catch {
		// No tabs to tell.
	}
}

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

async function broadcast(news: Broadcast): Promise<void> {
	try {
		await chrome.runtime.sendMessage(news);
	} catch {
		// No side panel open.
	}
}

/** The writes of "Stop AI access": the session's stop, Keep AI access on, the session's on. */
type StopWrite = "stopped" | "keepOn" | "session";

/**
 * "Stop AI access": `disconnect` first, whatever the writes after it do
 * (CR-08). Every write is tried; the errors of those that failed come back.
 */
export async function stopFirst(
	disconnect: () => void,
	writes: Partial<Record<StopWrite, () => Promise<unknown>>>,
): Promise<Partial<Record<StopWrite, unknown>>> {
	disconnect();
	const failed: Partial<Record<StopWrite, unknown>> = {};
	for (const [name, write] of Object.entries(writes))
		try {
			await write();
		} catch (error) {
			failed[name as StopWrite] = error;
		}
	return failed;
}

/** What the panel says after a Stop whose writes `failed`; `undefined` when none did. */
export function stopProblem(
	failed: Partial<Record<StopWrite, unknown>>,
): string | undefined {
	const errors = Object.values(failed);
	if (errors.length === 0) return undefined;
	const said = `AI access is off now, but a setting could not be saved (${message(errors[0])}).`;
	// The session's stop holds over the rest until the browser closes.
	if ("stopped" in failed && ("keepOn" in failed || "session" in failed))
		return `${said} It may come on again the next time Chrome starts Overmark in the background.`;
	if ("keepOn" in failed)
		return `${said} Keep AI access on is still saved as on: AI access comes on again when Chrome restarts.`;
	return said;
}

/**
 * AI access on for this browser session after a change of the library's
 * state: on once connected; off after the user's `disconnect()`, and after
 * the relay ended a session (idle, old, or for a reason `KeepOn` names)
 * unless "Keep AI access on" connects again. `undefined`: unchanged, as
 * while reconnecting.
 */
export function sessionOnAfter(
	{ state, reason }: StateChangeDetail,
	keepOn: boolean,
): boolean | undefined {
	if (state === "connected") return true;
	if (state !== "disconnected") return undefined;
	if (reason === "user") return false;
	const ended =
		reason === "idle" ||
		reason === "expired" ||
		endedProblem(reason) !== undefined;
	if (ended && !keepOn) return false;
	return undefined;
}

/** The icon's part of the connection: "…" while connecting or reconnecting. */
export function badgeOf(
	state: ConnectionState,
): "connected" | "connecting" | "off" {
	if (state === "connected") return "connected";
	if (state === "connecting" || state === "reconnecting") return "connecting";
	return "off";
}

/**
 * What the card says when Disconnect for `app` did not work: `revoke()`
 * rejected with `error`; `sent`: it was sent while connected, so the relay
 * may have done it before the session ended.
 */
export function revokeProblem(
	error: unknown,
	app: string,
	sent = false,
): string {
	const not = `${app} was not disconnected`;
	const code = (error as { code?: unknown } | undefined)?.code;
	if (code === "store_unavailable")
		return `${not}: the relay could not save this. Try again.`;
	if (code === "unknown_id")
		return `The relay no longer knows ${app}, so it cannot reach Overmark any more. It leaves this list when AI access next connects.`;
	const name = (error as { name?: unknown } | undefined)?.name;
	if (name === "InvalidStateError")
		return sent
			? `Overmark could not confirm that ${app} was disconnected: the connection ended first. It shows when AI access is next on.`
			: `${not}: Overmark is not connected to the relay. Turn on AI access and try again.`;
	if (name === "TimeoutError")
		return `${not}: the relay did not answer. Try again.`;
	return `${not}: ${message(error)}`;
}

export class Connection {
	readonly #deps: ConnectionDeps;
	readonly #tab: TabBridge;
	readonly #storage: CachedSecretStorage;
	readonly #kv: Kv;
	readonly #questions: Questions;
	readonly #panels = new Set<Panel>();
	readonly #keep: KeepOn;
	/** Always allow and Allow all changes, by AI app (DEC-018). */
	readonly #always: AlwaysAllowed;
	/** The tools' titles, by name, for the card's list. */
	#titles = new Map<string, string>();
	#settings: Settings;
	/** AI access is on for this browser session (without "Keep AI access on"). */
	#sessionOn: boolean;
	#relay: string;
	#relayNote: string | undefined;
	#mcp: TabMcp;
	#listening = new AbortController();
	/** Why the last command failed, until the next connection. */
	#problem: string | undefined;
	#lastCall: CallView | undefined;
	/** Why Disconnect did not work, by grant: until it goes, or connected again. */
	readonly #revokeProblems = new Map<
		string,
		{ error: unknown; sent: boolean }
	>();
	/**
	 * Disconnects, one at a time. Relays from 0.10.2 name the grant their
	 * error answers and the library pairs it; an older one (the user may set
	 * any relay) names nothing, and the library then rejects every revoke
	 * waiting with that error, another app's included.
	 */
	#revokes: Promise<void> = Promise.resolve();
	/** Panel commands, one after the other. */
	#commands: Promise<void> = Promise.resolve();
	#sending = false;

	private constructor(
		deps: ConnectionDeps,
		kv: Kv,
		storage: CachedSecretStorage,
		settings: Settings,
		sessionOn: boolean,
		always: AlwaysAllowed,
	) {
		this.#deps = deps;
		this.#kv = kv;
		this.#always = always;
		this.#tab = workerTab(deps.capture);
		this.#storage = storage;
		this.#settings = settings;
		this.#sessionOn = sessionOn;
		this.#questions = new Questions(this.#questionsHost());
		this.#keep = new KeepOn(
			() => this.#settings.keepOn && this.#settings.replaced === undefined,
			() => this.#changed(),
		);
		const relay = settings.relay ?? DEFAULT_RELAY;
		let mcp: TabMcp;
		try {
			if (relayProblem(relay) !== undefined)
				throw new TypeError(relayProblem(relay));
			mcp = this.#create(relay);
			this.#relay = relay;
		} catch (error) {
			// A stored address the library refuses must not stop the connection.
			this.#relayNote = `The saved relay ${relay} cannot be used (${message(error)}); using ${DEFAULT_RELAY}.`;
			this.#relay = DEFAULT_RELAY;
			mcp = this.#create(DEFAULT_RELAY);
		}
		this.#mcp = mcp;
		this.#watch(mcp);
	}

	/**
	 * The connection, connected again if the user left AI access on and the
	 * address was not taken over meanwhile.
	 */
	static async start(deps: ConnectionDeps): Promise<Connection> {
		await restrictStorage();
		// The settings live in IndexedDB, out of content scripts' reach. An
		// unreleased build kept them in chrome.storage.local: removed there at
		// every start, never taken over (DEC-016).
		const kv = deps.kv ?? (await openKv());
		await removeOldSettings(chrome.storage.local).catch((error: unknown) =>
			console.warn("Overmark: removing the old settings", error),
		);
		// A previous worker's questions died with it.
		await clearNotifications();
		const [storage, settings, session, always] = await Promise.all([
			CachedSecretStorage.load(kv),
			loadSettings(kv),
			chrome.storage.session.get([SESSION_ON, SESSION_STOPPED]),
			AlwaysAllowed.load(kv),
		]);
		// A Stop in this browser session holds, whatever was stored before it.
		const stopped = session[SESSION_STOPPED] === true;
		const connection = new Connection(
			deps,
			kv,
			storage,
			stopped ? { ...settings, keepOn: false } : settings,
			!stopped && session[SESSION_ON] === true,
			always,
		);
		connection.#showBadge();
		connection.keepUp();
		// Overlays a panel started before this worker knew: the stored value.
		connection.#tellBlur();
		return connection;
	}

	// --- The library's connection ---

	/** A connection to `relay`; throws a `TypeError` for an address the library refuses. */
	#create(relay: string): TabMcp {
		// The library's own "Always allow" stays off: Overmark asks itself, and
		// keeps Always allow per AI app and tool (DEC-018).
		const mcp: TabMcp = new TabMcp({
			relay,
			server: {
				name: SERVER_NAME,
				title: "Overmark",
				version: chrome.runtime.getManifest().version,
				instructions: INSTRUCTIONS,
				icons: [],
			},
			appName: "Overmark",
			storage: this.#storage,
			onConfirm: (request) => this.#decide(mcp, request),
		});
		const tools = createTools({
			store: this.#deps.store,
			tab: this.#tab,
			images: { toWebp, scale: scaleImage, crop: cropImages },
			onChange: (caseId) => {
				this.#deps.changed?.(caseId);
				void broadcast({ type: "cases:changed", caseId });
			},
			// Read at each call: only the worker writes it, and only after the
			// write to the store succeeded, so this is what the panel shows.
			blurForms: () => this.#settings.blurForms,
			maxMessageBytes: () => mcp.session?.limits.maxMessageBytes,
		});
		// AI apps through the relay only: no WebMCP (off anyway, and a worker
		// has no document) and no served port. `tools.ts` refuses other
		// callers too.
		for (const tool of tools)
			void mcp.registerTool(tool, { callers: ["relay"] });
		this.#titles = new Map(tools.map((t) => [t.name, t.title ?? t.name]));
		return mcp;
	}

	/**
	 * A tool that changes something: runs without asking if the user chose
	 * Always allow for it, or Allow all changes, for this AI app (DEC-018);
	 * otherwise asks. The "Last AI call" is recorded either way ("toolcall").
	 */
	/** Questions an Always allow given meanwhile covers are allowed. */
	#allowCovered(): void {
		this.#questions.allowCovered((grantId, tool) =>
			this.#always.has(grantId, tool),
		);
	}

	#decide(mcp: TabMcp, request: ConfirmRequest): Promise<ConfirmAnswer> {
		return decide(
			{
				always: this.#always,
				ask: async (r) => {
					const lines = await confirmLines(this.#deps.store, this.#tab, r);
					const front = await tabInFront().catch(() => undefined);
					// No answer in time is "timeout": `decide` tells the library
					// "unanswered", which the AI app hears as such, not as a no.
					return this.#questions.ask(r, lines, front?.id);
				},
				connected: (grantId) => mcp.grants.some((g) => g.grantId === grantId),
				kept: () => this.#allowCovered(),
				refused: (r) =>
					console.warn(
						`Overmark: refused ${r.tool.name} through WebMCP: only an AI app connected through the relay may change something`,
					),
				notKept: (error) => {
					console.warn("Overmark: keeping Always allow", error);
					this.#problem = `Always allow could not be saved: ${message(error)}`;
				},
			},
			request,
		).finally(() => this.#changed());
	}

	/** An app whose grant is gone takes its Always allow with it. */
	#keepGrants(grants: readonly { grantId: string }[]): void {
		this.#always.keepGrants(grants.map((g) => g.grantId)).then(
			() => this.#changed(),
			(error: unknown) =>
				console.warn("Overmark: forgetting Always allow", error),
		);
	}

	#watch(mcp: TabMcp): void {
		this.#listening.abort();
		this.#listening = new AbortController();
		const { signal } = this.#listening;
		const changed = () => this.#changed();
		for (const type of ["pairingcode", "grantschange"] as const)
			mcp.addEventListener(type, changed, { signal });
		// The relay's list of the apps connected to this address: only it, so
		// a start or a lost connection (no list yet) forgets nothing.
		mcp.addEventListener(
			"grantschange",
			({ detail: { grants } }) => {
				this.#keepGrants(grants);
				for (const id of this.#revokeProblems.keys())
					if (!grants.some((g) => g.grantId === id))
						this.#revokeProblems.delete(id);
			},
			{ signal },
		);
		mcp.addEventListener(
			"toolcall",
			({ detail: { tool, title, client } }) => {
				this.#lastCall = {
					tool: title ?? tool,
					// As the questions name it: the declared name escaped, the
					// verified host after it (or the WebMCP label).
					app: appName(client),
					at: Date.now(),
				};
				this.#changed();
			},
			{ signal },
		);
		// Every change of state (and each attempt scheduled while
		// reconnecting) redraws.
		mcp.addEventListener(
			"statechange",
			({ detail }) => {
				if (detail.state === "connected") {
					this.#problem = undefined;
					// "Not connected" no longer holds.
					this.#revokeProblems.clear();
					void this.#setReplaced(undefined);
				}
				const on = sessionOnAfter(detail, this.#settings.keepOn);
				if (on !== undefined) void this.#setSessionOn(on);
				this.#changed();
			},
			{ signal },
		);
		mcp.addEventListener(
			"replaced",
			({ detail: { sibling } }) => {
				void this.#setReplaced({ sibling });
				void this.#setSessionOn(false);
				this.#changed();
			},
			{ signal },
		);
		this.#keep.watch(mcp);
	}

	/** Connect now: the panel's button, a start or the alarm. */
	#connect(): void {
		const mcp = this.#mcp;
		if (mcp.state !== "disconnected") return;
		this.#problem = undefined;
		mcp.connect({ resume: true }).catch((error: unknown) => {
			if (mcp === this.#mcp) this.#keep.failed(error);
		});
	}

	async #setReplaced(replaced: Replaced | undefined): Promise<void> {
		this.#settings = { ...this.#settings, replaced };
		await saveReplaced(this.#kv, replaced);
		await this.#syncAlarm();
	}

	/** "Stop AI access" in this browser session: over a stored Keep AI access on. */
	async #setStopped(on: boolean): Promise<void> {
		await chrome.storage.session.set({ [SESSION_STOPPED]: on });
	}

	async #setSessionOn(on: boolean): Promise<void> {
		this.#sessionOn = on;
		await chrome.storage.session.set({ [SESSION_ON]: on });
		await this.#syncAlarm();
	}

	/** Settings change in memory only once the store has them. */
	async #setKeepOn(on: boolean): Promise<void> {
		await this.#kv.set({ [KEYS.keepOn]: on });
		this.#settings = { ...this.#settings, keepOn: on };
		await this.#syncAlarm();
	}

	/**
	 * Blur form fields: kept, then told to the overlays already open. A write
	 * that fails changes nothing: the command's problem is shown, the panel's
	 * box goes back with the next state, and the tools keep the old value.
	 */
	async #setBlurForms(on: boolean): Promise<void> {
		await this.#kv.set({ [KEYS.blurForms]: on });
		this.#settings = { ...this.#settings, blurForms: on };
		this.#tellBlur();
	}

	#tellBlur(): void {
		void tellTabs({
			type: "overlay:settings",
			blurForms: this.#settings.blurForms,
		});
	}

	/** The alarm runs while AI access is on (and the address is ours). */
	async #syncAlarm(): Promise<void> {
		const on =
			(this.#settings.keepOn || this.#sessionOn) &&
			this.#settings.replaced === undefined;
		try {
			if (on) {
				if ((await chrome.alarms.get(ALARM)) === undefined)
					await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
			} else await chrome.alarms.clear(ALARM);
		} catch (error) {
			console.warn("Overmark: alarm", error);
		}
	}

	/**
	 * Use `relay` from now on. The connection to the one before is ended
	 * whatever its state: left retrying, it would connect again unseen.
	 */
	async #useRelay(relay: string): Promise<void> {
		const next = this.#create(relay);
		await this.#kv.set({ [KEYS.relay]: relay });
		await this.#switchTo(relay, next);
	}

	/** Switch to `next`, a connection to `relay` that is stored already. */
	async #switchTo(relay: string, next: TabMcp): Promise<void> {
		const before = this.#mcp;
		this.#settings = { ...this.#settings, relay };
		this.#relay = relay;
		this.#relayNote = undefined;
		this.#problem = undefined;
		await this.#setReplaced(undefined);
		// AI access was on for the relay before: this one connects with
		// "Keep AI access on", or on the user's click.
		await this.#setSessionOn(false);
		this.#mcp = next;
		this.#watch(next);
		before.disconnect();
		this.#keep.connect();
		this.#changed();
	}

	// --- Chrome's events ---

	/**
	 * The worker started, or woke for the alarm: connect if AI access is on
	 * and the connection is down.
	 */
	keepUp(): void {
		void this.#syncAlarm();
		if (this.#settings.replaced !== undefined) return;
		if (this.#settings.keepOn) this.#keep.connect();
		// Not while the library reconnects by itself: `#connect` waits for
		// `disconnected`.
		else if (this.#sessionOn) this.#connect();
	}

	notificationButton(id: string, index: number): void {
		this.#questions.notificationButton(id, index);
	}

	notificationDismissed(id: string): void {
		this.#questions.notificationDismissed(id);
	}

	// --- The side panels ---

	/**
	 * A side panel's port, its sender already checked, with the messages it
	 * sent before the connection had started.
	 */
	addPanel(port: chrome.runtime.Port, early: unknown[] = []): void {
		const panel: Panel = { port, pairing: false, visible: true };
		this.#panels.add(panel);
		// Its overlays may have started before it knew the worker's value.
		this.#tellBlur();
		const receive = (raw: unknown) => {
			// Anything that is not a command is dropped; the rest run one after
			// the other, so a stop never ends before the connect that came first.
			const command = parseCommand(raw);
			if (command === undefined) return;
			this.#commands = this.#commands
				.then(() => this.#command(panel, command))
				.catch((error: unknown) => {
					this.#problem = message(error);
					this.#changed();
				});
		};
		for (const raw of early) receive(raw);
		port.onMessage.addListener(receive);
		port.onDisconnect.addListener(() => {
			this.#panels.delete(panel);
			if (panel.pairing) this.#pairingOff();
			if (panel.windowId !== undefined)
				this.#questions.panelClosed(panel.windowId);
		});
		this.#send(panel);
	}

	async #command(panel: Panel, command: PanelCommand): Promise<void> {
		switch (command.type) {
			case "hello":
				panel.windowId = command.windowId;
				return;
			case "visible":
				panel.visible = command.visible;
				// Hidden: the questions it alone showed go out as notifications.
				if (!command.visible && panel.windowId !== undefined)
					this.#questions.panelClosed(panel.windowId);
				return;
			case "connect":
				// The user's click takes the address back after a takeover. AI
				// access is on for the session once connected ("connected").
				await this.#setReplaced(undefined);
				await this.#setStopped(false);
				this.#connect();
				this.#changed();
				return;
			case "stop": {
				// Ends the session, not the pairing: the AI app works again after
				// the next connect. "Keep AI access on" would undo that, so it is
				// off in memory at once, before the store has it, and the session
				// remembers the stop over it, so a new worker keeps it too (CR-08).
				const wasOn = this.#settings.keepOn;
				this.#settings = { ...this.#settings, keepOn: false };
				const failed = await stopFirst(
					() => {
						this.#keep.stop();
						this.#mcp.disconnect();
					},
					{
						stopped: () => this.#setStopped(true),
						...(wasOn
							? { keepOn: () => this.#kv.set({ [KEYS.keepOn]: false }) }
							: {}),
						session: () => this.#setSessionOn(false),
					},
				);
				await this.#syncAlarm();
				this.#changed();
				const problem = stopProblem(failed);
				if (problem !== undefined) throw new Error(problem);
				return;
			}
			case "keep-on":
				await this.#setKeepOn(command.on);
				if (command.on) await this.#setStopped(false);
				if (command.on) this.#keep.connect();
				else this.#keep.stop();
				this.#changed();
				return;
			case "blur-forms":
				await this.#setBlurForms(command.on);
				this.#changed();
				return;
			case "pair":
				panel.pairing = command.on;
				if (command.on) this.#mcp.startPairing();
				else this.#pairingOff();
				this.#changed();
				return;
			case "revoke":
				// Not awaited: the commands after it (a Stop) must not wait for
				// the relay's answer, up to 15 s.
				this.#revoke(command.grantId);
				return;
			case "allow-all":
				// Only for an app the card shows.
				if (!this.#mcp.grants.some((g) => g.grantId === command.grantId))
					return;
				await this.#always.setAll(command.grantId, command.on);
				if (command.on) this.#allowCovered();
				this.#changed();
				return;
			case "ask-again":
				await this.#always.removeTool(command.grantId, command.tool);
				this.#changed();
				return;
			case "new-address":
				await this.#newAddress();
				return;
			case "set-relay":
				if (
					relayProblem(command.relay) !== undefined ||
					command.relay === this.#relay
				)
					return;
				await this.#useRelay(command.relay);
				return;
			case "answer":
				this.#questions.answer(command.id, command.answer);
				return;
			case "migrate":
				await this.#migrate(command);
				return;
		}
	}

	/**
	 * The settings and the address secret the side panel kept in its
	 * `localStorage` before the connection moved here, taken over once, so
	 * the address an AI app was given stays the same.
	 */
	async #migrate(
		command: Extract<PanelCommand, { type: "migrate" }>,
	): Promise<void> {
		if (this.#settings.panelHandedOver) return;
		// The secrets first: a crash after them leaves no marker, and the
		// panel, which deletes its copy only once the marker is set, hands
		// everything over again at its next start (taking no secret twice).
		for (const [key, value] of Object.entries(command.secrets))
			this.#storage.adopt(key, value);
		await this.#storage.written;
		const problem =
			command.relay === undefined ? undefined : relayProblem(command.relay);
		let next: TabMcp | undefined;
		let note: string | undefined;
		if (problem !== undefined)
			note = `The saved relay ${command.relay} cannot be used (${problem}); using ${this.#relay}.`;
		else if (command.relay !== undefined && command.relay !== this.#relay)
			try {
				next = this.#create(command.relay);
			} catch (error) {
				note = `The saved relay ${command.relay} cannot be used (${message(error)}); using ${this.#relay}.`;
			}
		// The settings and the marker in one transaction: all or none.
		const keepOn = command.keepOn ?? this.#settings.keepOn;
		const blurForms = command.blurForms ?? this.#settings.blurForms;
		await this.#kv.set({
			[KEYS.keepOn]: keepOn,
			[KEYS.blurForms]: blurForms,
			...(next !== undefined ? { [KEYS.relay]: command.relay } : {}),
			[KEYS.panelHandedOver]: true,
		});
		this.#settings = {
			...this.#settings,
			keepOn,
			blurForms,
			panelHandedOver: true,
		};
		this.#tellBlur();
		await this.#syncAlarm();
		if (next !== undefined && command.relay !== undefined)
			await this.#switchTo(command.relay, next);
		else this.#keep.connect();
		if (note !== undefined) this.#relayNote = note;
		this.#changed();
	}

	/**
	 * A new address. The library first takes the old address back, connected
	 * or not, taken over or not (since client 0.16), so the relay revokes
	 * every grant of it and disconnects the AI apps that may now talk to
	 * whoever took it; then it connects with the new one if it was on. After
	 * a takeover AI access is off, and a new worker's library knows nothing
	 * of the takeover: the new address connects, so the card shows it to
	 * pair again.
	 */
	async #newAddress(): Promise<void> {
		const replaced = this.#settings.replaced !== undefined;
		this.#problem = undefined;
		this.#changed();
		try {
			// "connected" turns AI access on.
			await this.#mcp.newAddress();
			// The address is new: no longer the one taken over, also should
			// the connect after it fail.
			await this.#setReplaced(undefined);
			if (replaced) await this.#mcp.connect({ resume: true });
		} catch (error) {
			this.#problem = message(error);
		}
		this.#changed();
	}

	/**
	 * Disconnect one AI app (DEC-017). Its Always allow goes with the grant,
	 * once the relay's list no longer has it (`#keepGrants`, DEC-018), or
	 * when the relay says it does not know the grant at all.
	 */
	#revoke(grantId: string): void {
		const mcp = this.#mcp;
		this.#revokeProblems.delete(grantId);
		this.#changed();
		this.#revokes = this.#revokes.then(() => {
			if (mcp !== this.#mcp) return;
			const sent = mcp.state === "connected";
			return mcp.revoke(grantId).catch((error: unknown) => {
				if (mcp !== this.#mcp) return;
				this.#revokeProblems.set(grantId, { error, sent });
				if ((error as { code?: unknown }).code === "unknown_id")
					this.#keepGrants(mcp.grants.filter((g) => g.grantId !== grantId));
				this.#changed();
			});
		});
	}

	/** Pairing stops once no panel's pairing view is open. */
	#pairingOff(): void {
		if (![...this.#panels].some((p) => p.pairing)) this.#mcp.stopPairing();
	}

	#questionsHost(): QuestionsHost {
		return {
			windowOf: async (tabId) => {
				try {
					return (await chrome.tabs.get(tabId)).windowId;
				} catch {
					return undefined;
				}
			},
			panelInFocus: async (windowId) => {
				// Open is not enough: it has to be on screen, not covered by
				// another extension's panel for the tab.
				if (
					![...this.#panels].some((p) => p.windowId === windowId && p.visible)
				)
					return false;
				return (await chrome.windows.get(windowId)).focused;
			},
			notify: async (id, text) => {
				await chrome.notifications.create(id, {
					type: "basic",
					iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
					...text,
					buttons: text.buttons.map((title) => ({ title })),
					requireInteraction: true,
					priority: 2,
				});
			},
			clear: (id) => void chrome.notifications.clear(id).catch(() => {}),
			changed: () => this.#changed(),
			now: () => Date.now(),
		};
	}

	// --- State ---

	get state(): AiState {
		const mcp = this.#mcp;
		const problem = this.#keep.problem ?? this.#problem;
		const address = mcp.session?.address;
		const code = mcp.pairingCode?.code;
		const replaced = this.#settings.replaced;
		return {
			relay: this.#relay,
			...(this.#relayNote !== undefined ? { relayNote: this.#relayNote } : {}),
			keepOn: this.#settings.keepOn,
			blurForms: this.#settings.blurForms,
			state: mcp.state,
			retrying: this.#keep.retrying,
			...(problem !== undefined ? { problem } : {}),
			...(address !== undefined ? { address } : {}),
			grants: mcp.grants.map((g) => {
				const always = this.#always.entry(g.grantId);
				const failed = this.#revokeProblems.get(g.grantId);
				const problem =
					failed === undefined
						? undefined
						: revokeProblem(
								failed.error,
								g.client.name || g.client.host,
								failed.sent,
							);
				return {
					grantId: g.grantId,
					name: g.client.name,
					host: g.client.host,
					allowAll: always.all,
					always: always.tools.map((tool) => ({
						tool,
						title: this.#titles.get(tool) ?? tool,
					})),
					...(problem !== undefined ? { problem } : {}),
				};
			}),
			pairing: [...this.#panels].some((p) => p.pairing),
			...(code !== undefined ? { code } : {}),
			...(replaced !== undefined
				? { replaced: { sibling: replaced.sibling } }
				: {}),
			...(this.#lastCall !== undefined ? { lastCall: this.#lastCall } : {}),
			questions: this.#questions.list,
			migrated: this.#settings.panelHandedOver,
		};
	}

	/** Tell the panels (once per turn of the event loop) and set the badge. */
	#changed(): void {
		this.#showBadge();
		if (this.#sending) return;
		this.#sending = true;
		queueMicrotask(() => {
			this.#sending = false;
			for (const panel of this.#panels) this.#send(panel);
		});
	}

	#send(panel: Panel): void {
		const news: WorkerMessage = { type: "state", state: this.state };
		try {
			panel.port.postMessage(news);
		} catch {
			// Closed meanwhile: its onDisconnect removes it.
		}
	}

	/**
	 * The icon says what is going on with no panel open: a question waits
	 * ("?"), it is connecting or retrying ("…"), or AI access is on (a green
	 * spark in the icon, no badge); the sync's "!" comes in between (badge.ts).
	 */
	#showBadge(): void {
		badge.ai({
			questions: this.#questions.list.length,
			ai: badgeOf(this.#mcp.state),
		});
	}
}
