/**
 * The worker's connection (`Connection`) with the real tab-mcp client 0.16
 * and a relay in this process: Disconnect, the end of a session by the
 * relay, and New address after a takeover, as the panel sees them. Chrome is
 * a fake that keeps the session area, the alarms and the badge; the settings
 * database is a memory one. From the review of PR 58 (its harness).
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
	MemoryTokenStore,
	type RevokeOptions,
	type RevokeSelector,
} from "@ractive-ch/tab-mcp";
import { startTestRelay, tokenFor } from "@ractive-ch/tab-mcp/testing";
import { type Kv, memoryKv } from "../src/lib/kv.ts";
import type { CaseStore } from "../src/lib/store.ts";
import { Connection } from "../src/worker/connection.ts";
import type { AiState } from "../src/worker/protocol.ts";
import type { Capture } from "../src/worker/tab.ts";

/** A memory store whose revocations wait `slowMs`, and fail while `failing`. */
class SlowStore extends MemoryTokenStore {
	failing = false;
	slowMs = 0;
	override async revoke(selector: RevokeSelector, options: RevokeOptions) {
		if (this.slowMs > 0) await Bun.sleep(this.slowMs);
		if (this.failing) throw new Error("store down");
		return super.revoke(selector, options);
	}
}

const globals = globalThis as unknown as Record<string, unknown>;
const before = { chrome: globals["chrome"], WebSocket: globals["WebSocket"] };
/** What Chrome keeps across workers: the session area and the alarms. */
const session = new Map<string, unknown>();
const alarms = new Map<string, unknown>();
/** The icon's spark needs the built icons, which Bun cannot fetch: only that warning is dropped. */
const warn = console.warn;
const warnSpy = spyOn(console, "warn").mockImplementation((...args) => {
	if (args[0] !== "Overmark: the toolbar icon") warn(...args);
});

beforeAll(() => {
	globals["chrome"] = {
		storage: {
			local: {
				setAccessLevel: async () => {},
				get: async () => ({}),
				remove: async () => {},
			},
			session: {
				get: async (keys: string[]) =>
					Object.fromEntries(
						keys.filter((k) => session.has(k)).map((k) => [k, session.get(k)]),
					),
				set: async (entries: Record<string, unknown>) => {
					for (const [k, v] of Object.entries(entries)) session.set(k, v);
				},
			},
		},
		notifications: {
			getAll: async () => ({}),
			clear: async () => true,
			create: async () => {},
		},
		alarms: {
			get: async (name: string) => alarms.get(name),
			create: async (name: string, info: unknown) => {
				alarms.set(name, info);
			},
			clear: async (name: string) => alarms.delete(name),
		},
		action: {
			setBadgeText: async () => {},
			setBadgeBackgroundColor: async () => {},
			setBadgeTextColor: async () => {},
			setTitle: async () => {},
			setIcon: async () => {},
		},
		runtime: {
			getManifest: () => ({ version: "0.0.0" }),
			sendMessage: async () => {},
			getURL: (path: string) => `chrome-extension://x/${path}`,
		},
		tabs: { query: async () => [], sendMessage: async () => {} },
		windows: { get: async () => ({ focused: false }) },
	};
});

afterAll(() => {
	warnSpy.mockRestore();
	globals["chrome"] = before.chrome;
	globals["WebSocket"] = before.WebSocket;
});

/** Wait for `ok`, up to `ms`. */
async function until(ok: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > end) throw new Error("timed out");
		await Bun.sleep(10);
	}
}

interface Worker {
	/** Every state the panel was sent. */
	states: AiState[];
	last(): AiState;
	send(command: Record<string, unknown>): void;
}

/** A worker as Chrome starts it, on `kv`, with one side panel open. */
async function startWorker(kv: Kv): Promise<Worker> {
	const connection = await Connection.start({
		store: {} as CaseStore,
		capture: (async () => {
			throw new Error("no capture");
		}) as unknown as Capture,
		kv,
	});
	const states: AiState[] = [];
	let receive: (raw: unknown) => void = () => {};
	connection.addPanel({
		postMessage: (m: { state: AiState }) => states.push(m.state),
		onMessage: { addListener: (fn: (raw: unknown) => void) => (receive = fn) },
		onDisconnect: { addListener: () => {} },
	} as unknown as chrome.runtime.Port);
	return {
		states,
		last: () => states.at(-1) as AiState,
		send: (command) => receive(command),
	};
}

describe("the worker's connection with client 0.16", () => {
	const store = new SlowStore();
	const relay = startTestRelay({ store });
	const workers: Worker[] = [];
	afterAll(async () => {
		for (const w of workers) w.send({ type: "stop" });
		await Bun.sleep(50);
		await relay.stop();
	});

	/** A worker on a fresh database, connected, with `names` paired, each with Allow all changes. */
	async function paired(names: string[]) {
		session.clear();
		alarms.clear();
		store.failing = false;
		store.slowMs = 0;
		const kv = memoryKv({ relay: relay.url, panelHandedOver: true });
		const w = await startWorker(kv);
		workers.push(w);
		w.send({ type: "connect" });
		await until(() => w.last()?.state === "connected");
		const address = w.last().address as string;
		for (const name of names)
			await tokenFor(relay.store, address, {
				clientId: `https://${name.toLowerCase()}.example/client.json`,
				clientName: name,
			});
		// The relay lists the grants from its store at the next connection.
		w.send({ type: "stop" });
		await until(() => w.last().state === "disconnected");
		w.send({ type: "connect" });
		await until(
			() =>
				w.last().state === "connected" &&
				w.last().grants.length === names.length,
		);
		const ids: Record<string, string> = {};
		for (const g of w.last().grants) {
			ids[g.name] = g.grantId;
			w.send({ type: "allow-all", grantId: g.grantId, on: true });
		}
		await until(() => w.last().grants.every((g) => g.allowAll));
		return { w, kv, address, ids };
	}

	const grant = (w: Worker, name: string) =>
		w.last().grants.find((g) => g.name === name);

	test("Review of PR 58, 1: an answer for one Disconnect is not taken for another waiting", async () => {
		const { w, ids } = await paired(["One", "Two"]);
		// One is gone at the relay, which does not tell the session.
		await store.revoke(
			{ grantId: ids["One"] as string },
			{ now: Date.now(), keepUntil: Date.now() },
		);
		// Two's revoke waits in the store when One's is asked for, and then
		// fails. The relay answers One at once: it knows no such grant.
		store.slowMs = 300;
		store.failing = true;
		w.send({ type: "revoke", grantId: ids["Two"] });
		await Bun.sleep(20);
		w.send({ type: "revoke", grantId: ids["One"] });
		await until(
			() =>
				grant(w, "Two")?.problem !== undefined &&
				grant(w, "One")?.problem !== undefined,
		);
		await Bun.sleep(50);
		// Each app with its own answer: Two stays, with its Allow all changes.
		expect(grant(w, "Two")?.problem).toBe(
			"Two was not disconnected: the relay could not save this. Try again.",
		);
		expect(grant(w, "Two")?.allowAll).toBe(true);
		expect(grant(w, "One")?.problem).toBe(
			"The relay no longer knows One, so it cannot reach Overmark any more. It leaves this list when AI access next connects.",
		);
		expect(grant(w, "One")?.allowAll).toBe(false);
	});

	test("Review of PR 58, 2: a Disconnect sent and then cut off by Stop could not be confirmed", async () => {
		const { w, ids } = await paired(["One"]);
		store.slowMs = 300;
		w.send({ type: "revoke", grantId: ids["One"] });
		await Bun.sleep(20);
		w.send({ type: "stop" });
		await until(() => grant(w, "One")?.problem !== undefined);
		expect(grant(w, "One")?.problem).toBe(
			"Overmark could not confirm that One was disconnected: the connection ended first. It shows when AI access is next on.",
		);
		// The next connection's list is the truth: the relay did revoke it.
		await Bun.sleep(400);
		store.slowMs = 0;
		w.send({ type: "connect" });
		await until(() => w.last().state === "connected");
		await until(() => w.last().grants.length === 0);
	});

	test("Review of PR 58, 2: a Disconnect while off was not sent: not connected, try again", async () => {
		const { w, ids } = await paired(["One"]);
		w.send({ type: "stop" });
		await until(() => w.last().state === "disconnected");
		w.send({ type: "revoke", grantId: ids["One"] });
		await until(() => grant(w, "One")?.problem !== undefined);
		expect(grant(w, "One")?.problem).toBe(
			"One was not disconnected: Overmark is not connected to the relay. Turn on AI access and try again.",
		);
		// Its Allow all changes stays: the grant is not gone.
		expect(grant(w, "One")?.allowAll).toBe(true);
	});

	test.each([false, true])(
		"Review of PR 58, 3: a session the relay ends as rate_limited says why (Keep AI access on %p)",
		async (keepOn) => {
			const { w } = await paired([]);
			if (keepOn) {
				w.send({ type: "keep-on", on: true });
				await until(() => w.last().keepOn);
			}
			// More control frames at once than the relay's budget allows.
			for (let i = 0; i < 20; i++) {
				w.send({ type: "pair", on: true });
				w.send({ type: "pair", on: false });
			}
			await until(() => w.last().state === "disconnected");
			await Bun.sleep(100);
			expect(w.last().problem).toBe(
				"The relay ended the connection: Overmark sent it too many messages at once.",
			);
			// Never at once: the next try waits (5 s first).
			expect(w.last().retrying).toBe(keepOn);
			expect(w.last().state).toBe("disconnected");
			// Without Keep AI access on, it stays off: the alarm does not connect.
			expect(session.get("aiOn")).toBe(keepOn);
			expect(alarms.has("overmark-ai")).toBe(keepOn);
			w.send({ type: "keep-on", on: false });
			w.send({ type: "stop" });
			await until(() => !w.last().retrying);
		},
	);

	test("Review of PR 58, 4: after a takeover, New address clears it even when the connect after it fails", async () => {
		const first = await paired([]);
		first.w.send({ type: "stop" });
		await until(() => first.w.last().state === "disconnected");
		// A new worker after a takeover it did not see.
		await first.kv.set({ replaced: { sibling: false } });
		session.clear();
		const w = await startWorker(first.kv);
		workers.push(w);
		await until(() => w.last()?.replaced !== undefined);
		// The take-back connects (one socket); the connect after it cannot.
		const Real = before.WebSocket as typeof WebSocket;
		let sockets = 0;
		globals["WebSocket"] = class extends Real {
			constructor(url: string | URL, protocols?: string | string[]) {
				sockets++;
				super(sockets > 1 ? "ws://127.0.0.1:1/tab" : url, protocols);
			}
		};
		try {
			w.send({ type: "new-address" });
			await until(() => w.last().problem !== undefined, 10_000);
		} finally {
			globals["WebSocket"] = before.WebSocket;
		}
		expect(sockets).toBe(2);
		expect(w.last().replaced).toBeUndefined();
		expect(await first.kv.get("replaced")).toBeUndefined();
		// The connect again works, with a new address.
		w.send({ type: "connect" });
		await until(() => w.last().state === "connected");
		expect(w.last().address).not.toBe(first.address);
	});
});
