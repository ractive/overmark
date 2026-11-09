/**
 * The connection to the user's AI app, in the service worker (DEC-015): the
 * library's `TabMcp` with Overmark's tools, the questions of tools that
 * change something, and the state the side panels show. A WebSocket that
 * carries messages keeps the worker alive (Chrome 116), and the relay's
 * heartbeat (a ping every 25 s, answered) carries some even when nothing
 * else happens. While AI access is on, an alarm wakes the worker once a
 * minute, and every worker start connects again: always with "Keep AI
 * access on", else until the browser closes or the extension is updated,
 * reloaded or disabled (all of which clear `chrome.storage.session`).
 */

import {
	type ConfirmRequest,
	type DisconnectDetail,
	type ReplacedDetail,
	TabMcp,
	type ToolCallStart,
} from "@ractive-ch/tab-mcp-client";
import { cropImages, scaleImage, toWebp } from "../lib/images.ts";
import type { Broadcast } from "../lib/messages.ts";
import type { CaseStore } from "../lib/store.ts";
import { KeepOn } from "./keep-on.ts";
import {
	type AiState,
	type CallView,
	type PanelCommand,
	parseCommand,
	type WorkerMessage,
} from "./protocol.ts";
import { Questions, type QuestionsHost } from "./questions.ts";
import { CachedSecretStorage, SECRET_PREFIX } from "./secret.ts";
import {
	DEFAULT_RELAY,
	KEYS,
	loadSettings,
	type Replaced,
	relayProblem,
	SESSION_ON,
	type Settings,
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
	/** Its pairing view is open. */
	pairing: boolean;
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

/** Remove every address secret from `area`. */
async function removeSecrets(area: chrome.storage.StorageArea): Promise<void> {
	const keys = Object.keys(await area.get(null)).filter((key) =>
		key.startsWith(SECRET_PREFIX),
	);
	if (keys.length > 0) await area.remove(keys);
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
	readonly #questions: Questions;
	readonly #panels = new Set<Panel>();
	readonly #keep: KeepOn;
	#settings: Settings;
	/** AI access is on for this browser session (without "Keep AI access on"). */
	#sessionOn: boolean;
	#relay: string;
	#relayNote: string | undefined;
	#mcp: TabMcp;
	#listening = new AbortController();
	/** Why the last command failed, until the next connection. */
	#problem: string | undefined;
	/**
	 * Why AI access cannot be on at all: Chrome would not keep the extension's
	 * storage from content scripts, so the address secret is not kept there.
	 */
	readonly #locked: string | undefined;
	/** The takeover happened in this worker's life: the library knows of it. */
	#replacedHere = false;
	#lastCall: CallView | undefined;
	/** Panel commands, one after the other. */
	#commands: Promise<void> = Promise.resolve();
	#sending = false;

	private constructor(
		deps: ConnectionDeps,
		storage: CachedSecretStorage,
		settings: Settings,
		sessionOn: boolean,
		locked: string | undefined,
	) {
		this.#deps = deps;
		this.#locked = locked;
		this.#tab = workerTab(deps.capture);
		this.#storage = storage;
		this.#settings = settings;
		this.#sessionOn = sessionOn;
		this.#questions = new Questions(this.#questionsHost());
		this.#keep = new KeepOn(
			() =>
				this.#locked === undefined &&
				this.#settings.keepOn &&
				this.#settings.replaced === undefined,
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
		// Content scripts have no business with the settings or the secret.
		// Where Chrome refuses that, the secret is not kept at all (fail closed):
		// a content script that a page took over could read it.
		const locked = await chrome.storage.local
			.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
			.then(
				() => undefined,
				(error: unknown) =>
					`Overmark cannot keep its storage from web pages in this browser (${message(error)}), so AI access stays off.`,
			);
		await clearNotifications();
		if (locked !== undefined) await removeSecrets(chrome.storage.local);
		const [storage, settings, session] = await Promise.all([
			locked === undefined
				? CachedSecretStorage.load(chrome.storage.local)
				: CachedSecretStorage.memory(),
			loadSettings(chrome.storage.local),
			chrome.storage.session.get(SESSION_ON),
		]);
		const connection = new Connection(
			deps,
			storage,
			settings,
			session[SESSION_ON] === true,
			locked,
		);
		connection.#showBadge();
		connection.keepUp();
		return connection;
	}

	// --- The library's connection ---

	/** A connection to `relay`; throws a `TypeError` for an address the library refuses. */
	#create(relay: string): TabMcp {
		// No "Always allow" (DEC-008): every call that changes something asks.
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
			onConfirm: (request) => this.#decide(request),
		});
		const tools = createTools({
			store: this.#deps.store,
			tab: this.#tab,
			images: { toWebp, scale: scaleImage, crop: cropImages },
			onChange: (caseId) => void broadcast({ type: "cases:changed", caseId }),
			// Read at each call: the panel changes it in storage at any time.
			blurForms: async () =>
				(await chrome.storage.local.get(KEYS.blurForms))[KEYS.blurForms] ===
				true,
			maxMessageBytes: () => mcp.session?.limits.maxMessageBytes,
		});
		for (const tool of tools) void mcp.registerTool(tool);
		return mcp;
	}

	/** A tool that changes something: asks, every time. */
	async #decide(request: ConfirmRequest): Promise<boolean> {
		const lines = await confirmLines(this.#deps.store, this.#tab, request);
		const front = await tabInFront().catch(() => undefined);
		// No answer in time is Don't allow; the library tells the AI app
		// "The user declined" for that as for any no.
		const answer = await this.#questions.ask(request, lines, front?.id);
		return answer === "allow";
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
		this.#problem = this.#locked;
		if (this.#locked !== undefined) {
			this.#changed();
			return;
		}
		mcp.connect({ resume: true }).catch((error: unknown) => {
			if (mcp === this.#mcp) this.#keep.failed(error);
		});
	}

	async #setReplaced(replaced: Replaced | undefined): Promise<void> {
		this.#settings = { ...this.#settings, replaced };
		if (replaced === undefined) {
			this.#replacedHere = false;
			await chrome.storage.local.remove(KEYS.replaced);
		} else await chrome.storage.local.set({ [KEYS.replaced]: replaced });
		await this.#syncAlarm();
	}

	async #setSessionOn(on: boolean): Promise<void> {
		this.#sessionOn = on;
		await chrome.storage.session.set({ [SESSION_ON]: on });
		await this.#syncAlarm();
	}

	async #setKeepOn(on: boolean): Promise<void> {
		this.#settings = { ...this.#settings, keepOn: on };
		await chrome.storage.local.set({ [KEYS.keepOn]: on });
		await this.#syncAlarm();
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
		const before = this.#mcp;
		this.#relay = relay;
		this.#relayNote = undefined;
		this.#problem = undefined;
		await chrome.storage.local.set({ [KEYS.relay]: relay });
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
		if (this.#settings.replaced !== undefined || this.#locked !== undefined)
			return;
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
		const panel: Panel = { port, pairing: false };
		this.#panels.add(panel);
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
			case "pair":
				panel.pairing = command.on;
				if (command.on) this.#mcp.startPairing();
				else this.#pairingOff();
				this.#changed();
				return;
			case "revoke":
				this.#mcp.revoke(command.grantId);
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
		// Locked: the panel keeps its copy until this browser can keep it safe.
		if (this.#settings.migrated || this.#locked !== undefined) return;
		for (const [key, value] of Object.entries(command.secrets))
			this.#storage.adopt(key, value);
		await this.#storage.written;
		this.#settings = { ...this.#settings, migrated: true };
		const changes: Record<string, unknown> = { [KEYS.migrated]: true };
		if (command.blurForms !== undefined)
			changes[KEYS.blurForms] = command.blurForms;
		await chrome.storage.local.set(changes);
		if (command.keepOn !== undefined) await this.#setKeepOn(command.keepOn);
		const problem =
			command.relay === undefined ? undefined : relayProblem(command.relay);
		if (problem !== undefined)
			this.#relayNote = `The saved relay ${command.relay} cannot be used (${problem}); using ${this.#relay}.`;
		if (
			command.relay !== undefined &&
			problem === undefined &&
			command.relay !== this.#relay
		) {
			try {
				await this.#useRelay(command.relay);
			} catch (error) {
				this.#relayNote = `The saved relay ${command.relay} cannot be used (${message(error)}); using ${this.#relay}.`;
			}
		} else this.#keep.connect();
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
		if (this.#locked !== undefined) {
			this.#problem = this.#locked;
			this.#changed();
			return;
		}
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
				if (![...this.#panels].some((p) => p.windowId === windowId))
					return false;
				return (await chrome.windows.get(windowId)).focused;
			},
			notify: async (id, text) => {
				await chrome.notifications.create(id, {
					type: "basic",
					iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
					...text,
					buttons: [{ title: "Don't allow" }, { title: "Allow" }],
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
		const problem = this.#keep.problem ?? this.#problem ?? this.#locked;
		const address = mcp.address;
		const code = mcp.pairingCode?.code;
		const replaced = this.#settings.replaced;
		return {
			relay: this.#relay,
			...(this.#relayNote !== undefined ? { relayNote: this.#relayNote } : {}),
			keepOn: this.#settings.keepOn,
			state: mcp.state,
			reconnecting: mcp.reconnecting !== undefined,
			retrying: this.#keep.retrying,
			...(problem !== undefined ? { problem } : {}),
			...(address !== undefined ? { address } : {}),
			grants: mcp.grants.map((g) => ({
				grantId: g.grantId,
				name: g.client.name,
				host: g.client.host,
			})),
			pairing: [...this.#panels].some((p) => p.pairing),
			...(code !== undefined ? { code } : {}),
			...(replaced !== undefined
				? { replaced: { sibling: replaced.sibling } }
				: {}),
			...(this.#lastCall !== undefined ? { lastCall: this.#lastCall } : {}),
			questions: this.#questions.list,
			migrated: this.#settings.migrated,
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
