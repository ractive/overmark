/**
 * What the worker reads from the tab-mcp client library, checked against the
 * library itself and a relay in this process: the events and states the
 * connection (`connection.ts`) and Keep AI access on (`keep-on.ts`) follow,
 * and what `revoke()` answers. The fakes in `keep-on.test.ts` send the same
 * shapes; this is where a change of the library shows.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
	MemoryTokenStore,
	type RevokeOptions,
	type RevokeSelector,
} from "@ractive-ch/tab-mcp";
import { startTestRelay, tokenFor } from "@ractive-ch/tab-mcp/testing";
import {
	type ConnectionState,
	type StateChangeDetail,
	TabMcp,
} from "@ractive-ch/tab-mcp-client";
import {
	badgeOf,
	revokeProblem,
	sessionOnAfter,
} from "../src/worker/connection.ts";
import { KeepOn } from "../src/worker/keep-on.ts";

/** A memory store whose revocations fail while `failing`, as a store that is down. */
class FlakyStore extends MemoryTokenStore {
	failing = false;
	override revoke(selector: RevokeSelector, options: RevokeOptions) {
		if (this.failing) return Promise.reject(new Error("store down"));
		return super.revoke(selector, options);
	}
}

/** A page of Overmark's kind on `relay`, and the `statechange` details it heard. */
function page(relay: string) {
	const mcp = new TabMcp({
		relay,
		server: { name: "overmark", version: "0.0.0" },
		storage: null,
	});
	const heard: StateChangeDetail[] = [];
	mcp.addEventListener("statechange", (e) => heard.push(e.detail));
	return { mcp, heard };
}

/** Wait for `ok`, up to 5 s. */
async function until(ok: () => boolean): Promise<void> {
	const end = Date.now() + 5000;
	while (!ok()) {
		if (Date.now() > end) throw new Error("timed out");
		await Bun.sleep(10);
	}
}

describe("the library's state, as the worker reads it", () => {
	test("AI access on for the session follows connected, the user's stop and an ended session", () => {
		const on = (detail: StateChangeDetail, keepOn = false) =>
			sessionOnAfter(detail, keepOn);
		expect(on({ state: "connected" })).toBe(true);
		expect(on({ state: "disconnected", reason: "user" })).toBe(false);
		expect(on({ state: "disconnected", reason: "user" }, true)).toBe(false);
		for (const reason of ["idle", "expired"] as const) {
			expect(on({ state: "disconnected", reason })).toBe(false);
			// Keep AI access on connects again: it stays on.
			expect(on({ state: "disconnected", reason }, true)).toBeUndefined();
		}
		// Taken over (the `replaced` event turns it off), a new address, a
		// refusal: unchanged, as before.
		for (const reason of ["replaced", "new_address", "policy"] as const)
			expect(on({ state: "disconnected", reason })).toBeUndefined();
		// A failed connect, reconnecting, connecting: unchanged.
		expect(on({ state: "disconnected" })).toBeUndefined();
		expect(on({ state: "reconnecting", reason: "network" })).toBeUndefined();
		expect(on({ state: "reconnecting" })).toBeUndefined();
		expect(on({ state: "connecting" })).toBeUndefined();
	});

	test("the icon says … while connecting and while reconnecting", () => {
		const states: ConnectionState[] = [
			"disconnected",
			"connecting",
			"reconnecting",
			"connected",
		];
		expect(states.map(badgeOf)).toEqual([
			"off",
			"connecting",
			"connecting",
			"connected",
		]);
	});

	test("Disconnect that did not work says why, for each of revoke's rejections", () => {
		const relayError = (code: string) =>
			Object.assign(new Error(`Relay error ${code}: x`), { code });
		expect(revokeProblem(relayError("store_unavailable"), "Claude")).toBe(
			"Claude was not disconnected: the relay could not save this. Try again.",
		);
		expect(revokeProblem(relayError("unknown_id"), "Claude")).toBe(
			"The relay no longer knows Claude, so it cannot reach Overmark any more. It leaves this list when AI access next connects.",
		);
		expect(
			revokeProblem(
				new DOMException("TabMcp: not connected", "InvalidStateError"),
				"Claude",
			),
		).toBe(
			"Claude was not disconnected: Overmark is not connected to the relay. Turn on AI access and try again.",
		);
		expect(
			revokeProblem(
				new DOMException("TabMcp: the relay did not answer", "TimeoutError"),
				"Claude",
			),
		).toBe("Claude was not disconnected: the relay did not answer. Try again.");
		expect(revokeProblem(new Error("odd"), "Claude")).toBe(
			"Claude was not disconnected: odd",
		);
	});
});

describe("tab-mcp client 0.16 with a relay", () => {
	const store = new FlakyStore();
	// A session nobody paired with ends as idle at the first heartbeat after
	// 300 ms.
	const relay = startTestRelay({
		store,
		unpairedIdleTimeoutMs: 300,
		heartbeatMs: 200,
	});
	afterAll(() => relay.stop());

	test("connect and disconnect: statechange with the state, the reason on the way out", async () => {
		const { mcp, heard } = page(relay.url);
		const session = await mcp.connect();
		expect(mcp.state).toBe("connected");
		expect(mcp.session?.address).toBe(session.address);
		mcp.disconnect();
		expect(mcp.session).toBeUndefined();
		expect(heard).toEqual([
			{ state: "connecting" },
			{ state: "connected" },
			{ state: "disconnected", reason: "user" },
		]);
		expect(heard.map((d) => sessionOnAfter(d, false))).toEqual([
			undefined,
			true,
			false,
		]);
	});

	test("an idle session ends as disconnected with reason idle, and Keep AI access on connects again", async () => {
		const { mcp, heard } = page(relay.url);
		const keep = new KeepOn(
			() => true,
			() => {},
		);
		keep.watch(mcp);
		try {
			await mcp.connect();
			await until(() => heard.some((d) => d.reason === "idle"));
			expect(heard).toContainEqual({ state: "disconnected", reason: "idle" });
			// KeepOn's own connect, not the library's reconnecting.
			expect(heard.some((d) => d.state === "reconnecting")).toBe(false);
			await until(
				() => heard.filter((d) => d.state === "connected").length === 2,
			);
		} finally {
			keep.stop();
			mcp.disconnect();
		}
	});

	test("revoke: resolves once the grant is gone, rejects with the relay's code or while not connected", async () => {
		const { mcp } = page(relay.url);
		const named = async (clientId: string) => {
			const { address } = await mcp.connect();
			await tokenFor(relay.store, address, {
				clientId,
				clientName: "Test",
			});
			// The relay lists a grant from its store at the next connection.
			mcp.disconnect();
			await mcp.connect();
			const grant = mcp.grants.find((g) => g.client.id === clientId);
			expect(grant).toBeDefined();
			return grant?.grantId as string;
		};
		try {
			// Not connected: nothing to send it to.
			mcp.disconnect();
			await expect(mcp.revoke("g_none")).resolves.toBeUndefined();
			const first = await named("https://one.example/client.json");
			mcp.disconnect();
			await expect(mcp.revoke(first)).rejects.toMatchObject({
				name: "InvalidStateError",
			});
			await mcp.connect();

			// The store fails: store_unavailable, and the grant stays.
			store.failing = true;
			await expect(mcp.revoke(first)).rejects.toMatchObject({
				code: "store_unavailable",
			});
			store.failing = false;
			expect(mcp.grants.some((g) => g.grantId === first)).toBe(true);

			// Works: resolves with the grant gone from `grants`.
			const changes: number[] = [];
			mcp.addEventListener("grantschange", (e) =>
				changes.push(e.detail.grants.length),
			);
			await mcp.revoke(first);
			expect(mcp.grants.some((g) => g.grantId === first)).toBe(false);
			expect(changes.length).toBeGreaterThan(0);

			// Gone from the relay's store behind the session's back: unknown_id.
			const second = await named("https://two.example/client.json");
			await relay.store.revoke(
				{ grantId: second },
				{ now: Date.now(), keepUntil: Date.now() },
			);
			await expect(mcp.revoke(second)).rejects.toMatchObject({
				code: "unknown_id",
			});
		} finally {
			store.failing = false;
			mcp.disconnect();
		}
	});

	test("registerTool takes callers: relay only; the old webmcp option is refused", async () => {
		const { mcp } = page(relay.url);
		const tool = {
			name: "t",
			description: "A tool",
			execute: () => "ok",
		};
		await expect(
			mcp.registerTool(tool, { callers: ["relay"] }),
		).resolves.toBeUndefined();
		await expect(
			mcp.registerTool({ ...tool, name: "u" }, { webmcp: false } as unknown as {
				callers: [];
			}),
		).rejects.toBeInstanceOf(TypeError);
	});

	// Last: it stops the relay.
	test("the relay going away: reconnecting with the reason, the attempt in `reconnecting`", async () => {
		const { mcp, heard } = page(relay.url);
		await mcp.connect();
		const keep = new KeepOn(
			() => true,
			() => {},
		);
		keep.watch(mcp);
		try {
			await relay.stop();
			await until(() => mcp.state === "reconnecting");
			expect(heard.at(-1)).toEqual({
				state: "reconnecting",
				reason: "shutdown",
			});
			expect(mcp.reconnecting?.attempt).toBe(1);
			expect(badgeOf(mcp.state)).toBe("connecting");
			// The library's to do: Keep AI access on does not connect over it.
			keep.connect();
			expect(keep.retrying).toBe(false);
			expect(mcp.state).toBe("reconnecting");
		} finally {
			keep.stop();
			mcp.disconnect();
		}
		expect(heard.at(-1)).toEqual({ state: "disconnected", reason: "user" });
	});
});
