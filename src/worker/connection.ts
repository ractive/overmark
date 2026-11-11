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
	type ConfirmRequest,
	type DisconnectDetail,
	type ReplacedDetail,
	TabMcp,
	type ToolCallStart,
} from "@ractive-ch/tab-mcp-client";
import { cropImages, scaleImage, toWebp } from "../lib/images.ts";
import type { Broadcast, ContentRequest } from "../lib/messages.ts";
import type { CaseStore } from "../lib/store.ts";
import { AlwaysAllowed } from "./always.ts";
import { decide } from "./decide.ts";
import { KeepOn } from "./keep-on.ts";
import { type Kv, openKv, removeOldSettings } from "./kv.ts";
import {
	type AiState,
	type CallView,
	type PanelCommand,
	parseCommand,
	type WorkerMessage,
} from "./protocol.ts";
import {
	NOTIFICATION_BUTTONS,
	Questions,
	type QuestionsHost,
} from "./questions.ts";
import { CachedSecretStorage } from "./secret.ts";
import {
	DEFAULT_RELAY,
	KEYS,
	loadSettings,
	type Replaced,
	relayProblem,
	SESSION_ON,
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
	/** The takeover happened in this worker's life: the library knows of it. */
	#replacedHere = false;
	#lastCall: CallView | undefined;
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
		const kv = await openKv();
		await removeOldSettings(chrome.storage.local).catch((error: unknown) =>
			console.warn("Overmark: removing the old settings", error),
		);
		// A previous worker's questions died with it.
		await clearNotifications();
		const [storage, settings, session, always] = await Promise.all([
			CachedSecretStorage.load(kv),
			loadSettings(kv),
			chrome.storage.session.get(SESSION_ON),
			AlwaysAllowed.load(kv),
		]);
		const connection = new Connection(
			deps,
			kv,
			storage,
			settings,
			session[SESSION_ON] === true,
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
				name: "overmark",
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
			onChange: (caseId) => void broadcast({ type: "cases:changed", caseId }),
			// Read at each call: only the worker writes it, and only after the
			// write to the store succeeded, so this is what the panel shows.
			blurForms: () => this.#settings.blurForms,
			maxMessageBytes: () => mcp.session?.limits.maxMessageBytes,
		});
		for (const tool of tools) void mcp.registerTool(tool);
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

	#decide(mcp: TabMcp, request: ConfirmRequest): Promise<boolean> {
		return decide(
			{
				always: this.#always,
				ask: async (r) => {
					const lines = await confirmLines(this.#deps.store, this.#tab, r);
					const front = await tabInFront().catch(() => undefined);
					// No answer in time is Don't allow; the library tells the AI
					// app "The user declined" for that as for any no.
					return this.#questions.ask(r, lines, front?.id);
				},
				connected: (grantId) => mcp.grants.some((g) => g.grantId === grantId),
				kept: () => this.#allowCovered(),
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
		for (const type of [
			"statechange",
			"reconnecting",
			"pairingcode",
			"grantschange",
		] as const)
			mcp.addEventListener(type, changed, { signal });
		// The relay's list of the apps connected to this address: only it, so
		// a start or a lost connection (no list yet) forgets nothing.
		mcp.addEventListener("grantschange", () => this.#keepGrants(mcp.grants), {
			signal,
		});
		mcp.addEventListener(
			"toolcall",
			(event) => {
				const { tool, title, client } = (event as CustomEvent<ToolCallStart>)
					.detail;
				this.#lastCall = {
					tool: title ?? tool,
					// The name is what the app declares; the host is verified.
					app: client.name ? `${client.name} (${client.host})` : client.host,
					at: Date.now(),
				};
				this.#changed();
			},
			{ signal },
		);
		mcp.addEventListener(
			"connected",
			() => {
				this.#problem = undefined;
				void this.#setReplaced(undefined);
				void this.#setSessionOn(true);
				this.#changed();
			},
			{ signal },
		);
		mcp.addEventListener(
			"disconnected",
			(event) => {
				const { reason } = (event as CustomEvent<DisconnectDetail>).detail;
				// The relay ended an idle or old session: with "Keep AI access
				// on" `KeepOn` connects again, without it AI access is off.
				if (
					reason === "user" ||
					((reason === "idle" || reason === "expired") &&
						!this.#settings.keepOn)
				)
					void this.#setSessionOn(false);
				this.#changed();
			},
			{ signal },
		);
		mcp.addEventListener(
			"replaced",
			(event) => {
				const { sibling } = (event as CustomEvent<ReplacedDetail>).detail;
				this.#replacedHere = true;
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
		if (replaced === undefined) this.#replacedHere = false;
		await saveReplaced(this.#kv, replaced);
		await this.#syncAlarm();
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
		else if (this.#sessionOn && this.#mcp.reconnecting === undefined)
			this.#connect();
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
				this.#connect();
				this.#changed();
				return;
			case "stop":
				// Ends the session, not the pairing: the AI app works again after
				// the next connect. "Keep AI access on" would undo that.
				await this.#setKeepOn(false);
				await this.#setSessionOn(false);
				this.#keep.stop();
				this.#mcp.disconnect();
				this.#changed();
				return;
			case "keep-on":
				await this.#setKeepOn(command.on);
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
				this.#mcp.revoke(command.grantId);
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
	 * A new address. After a takeover the library first takes the old address
	 * back, so the relay disconnects the AI apps that now talk to whoever took
	 * it, but only if the takeover happened in this worker's life: a new
	 * worker's library knows nothing of it. Then the extension connects with
	 * the old address itself, and the new address is made while connected,
	 * which revokes every grant of the old one.
	 */
	async #newAddress(): Promise<void> {
		const takeBack =
			this.#settings.replaced !== undefined && !this.#replacedHere;
		this.#problem = undefined;
		this.#changed();
		try {
			if (takeBack) await this.#mcp.connect({ resume: true });
			// It connects again if it was connected: "connected" turns AI access on.
			await this.#mcp.newAddress();
			await this.#setReplaced(undefined);
		} catch (error) {
			this.#problem = message(error);
		}
		this.#changed();
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
					buttons: NOTIFICATION_BUTTONS.map((title) => ({ title })),
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
		const address = mcp.address;
		const code = mcp.pairingCode?.code;
		const replaced = this.#settings.replaced;
		return {
			relay: this.#relay,
			...(this.#relayNote !== undefined ? { relayNote: this.#relayNote } : {}),
			keepOn: this.#settings.keepOn,
			blurForms: this.#settings.blurForms,
			state: mcp.state,
			reconnecting: mcp.reconnecting !== undefined,
			retrying: this.#keep.retrying,
			...(problem !== undefined ? { problem } : {}),
			...(address !== undefined ? { address } : {}),
			grants: mcp.grants.map((g) => {
				const always = this.#always.entry(g.grantId);
				return {
					grantId: g.grantId,
					name: g.client.name,
					host: g.client.host,
					allowAll: always.all,
					always: always.tools.map((tool) => ({
						tool,
						title: this.#titles.get(tool) ?? tool,
					})),
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
	 * ("?"), AI access is on ("on"), or it is connecting or retrying ("…").
	 */
	#showBadge(): void {
		const questions = this.#questions.list.length;
		const mcp = this.#mcp;
		const [text, color, title] =
			questions > 0
				? [
						"?",
						"#b45309",
						`Overmark: ${questions === 1 ? "an AI app asks" : `${questions} questions wait`} for your answer. Open the side panel to answer.`,
					]
				: mcp.state === "connected"
					? ["on", "#15803d", "Overmark: AI access is on"]
					: mcp.state === "connecting" || mcp.reconnecting
						? ["…", "#6b7280", "Overmark: connecting to the AI app"]
						: ["", "#6b7280", "Overmark"];
		void chrome.action.setBadgeText({ text }).catch(() => {});
		void chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
		void chrome.action.setTitle({ title }).catch(() => {});
	}
}
