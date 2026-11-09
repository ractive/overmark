import { beforeEach, describe, expect, test } from "bun:test";
import type { ConnectOptions } from "@ractive-ch/tab-mcp-client";
import { KeepOn, type KeptConnection } from "../src/worker/keep-on.ts";

/** What `TabMcp` does for `KeepOn`, with connects that fail on demand. */
class FakeConnection extends EventTarget implements KeptConnection {
	state: KeptConnection["state"] = "disconnected";
	reconnecting: KeptConnection["reconnecting"];
	/** The errors of the next connects; none left: it works. */
	errors: Error[] = [];
	calls: ConnectOptions[] = [];
	async connect(options: ConnectOptions = {}) {
		this.calls.push(options);
		this.state = "connecting";
		await Bun.sleep(0);
		const error = this.errors.shift();
		if (error !== undefined) {
			this.state = "disconnected";
			throw error;
		}
		this.state = "connected";
		this.dispatchEvent(new CustomEvent("connected"));
		return {} as Awaited<ReturnType<KeptConnection["connect"]>>;
	}
	end(reason: string) {
		this.state = "disconnected";
		this.dispatchEvent(new CustomEvent("disconnected", { detail: { reason } }));
	}
}

let wanted: boolean;
let changes: number;
let connection: FakeConnection;
let keep: KeepOn;

beforeEach(() => {
	wanted = true;
	changes = 0;
	connection = new FakeConnection();
	keep = new KeepOn(
		() => wanted,
		() => changes++,
		[1, 2],
	);
	keep.watch(connection);
});

describe("KeepOn", () => {
	test("connects without a click, and only while wanted", async () => {
		wanted = false;
		keep.connect();
		expect(connection.calls).toEqual([]);
		wanted = true;
		keep.connect();
		expect(connection.calls).toEqual([{ resume: true }]);
	});

	test.each(["idle", "expired"])(
		"connects again after a session ended as %s",
		(reason) => {
			connection.state = "connected";
			connection.end(reason);
			expect(connection.calls).toEqual([{ resume: true }]);
		},
	);

	test("stays off after an idle session when no longer wanted", () => {
		wanted = false;
		connection.state = "connected";
		connection.end("idle");
		expect(connection.calls).toEqual([]);
	});

	test.each(["user", "replaced", "new_address", "network", "policy"])(
		"leaves a session that ended as %s alone",
		(reason) => {
			connection.state = "connected";
			connection.end(reason);
			expect(connection.calls).toEqual([]);
		},
	);

	test("says why a connect failed and tries again until it works", async () => {
		connection.errors = [new Error("relay down"), new Error("still down")];
		keep.connect();
		await Bun.sleep(0);
		await Bun.sleep(0);
		expect(keep.problem).toBe("relay down");
		expect(keep.retrying).toBe(true);
		while (connection.state !== "connected") await Bun.sleep(1);
		await Bun.sleep(0);
		expect(connection.calls).toHaveLength(3);
		expect(keep.problem).toBeUndefined();
		expect(keep.retrying).toBe(false);
		expect(changes).toBeGreaterThan(0);
	});

	test("the last wait repeats", async () => {
		connection.errors = Array.from({ length: 5 }, () => new Error("down"));
		keep.connect();
		while (connection.state !== "connected") await Bun.sleep(1);
		expect(connection.calls).toHaveLength(6);
	});

	test("no longer wanted: the next try does not happen", async () => {
		connection.errors = [new Error("relay down")];
		keep.connect();
		await Bun.sleep(0);
		await Bun.sleep(0);
		wanted = false;
		await Bun.sleep(10);
		expect(connection.calls).toHaveLength(1);
	});

	test("stop drops the waiting try, the reason, and a try on its way", async () => {
		connection.errors = [new Error("relay down")];
		keep.connect();
		await Bun.sleep(0);
		await Bun.sleep(0);
		keep.stop();
		expect(keep.problem).toBeUndefined();
		expect(keep.retrying).toBe(false);
		await Bun.sleep(10);
		expect(connection.calls).toHaveLength(1);

		connection.errors = [new DOMException("cancelled", "AbortError")];
		keep.connect();
		keep.stop();
		await Bun.sleep(10);
		expect(keep.problem).toBeUndefined();
		expect(keep.retrying).toBe(false);
	});

	test("does not take the address back from a tab that took it over", async () => {
		connection.errors = [
			Object.assign(new Error("taken over"), { reason: "replaced" }),
		];
		keep.connect();
		await Bun.sleep(10);
		expect(keep.problem).toBe("taken over");
		expect(keep.retrying).toBe(false);
		expect(connection.calls).toHaveLength(1);
	});

	test("takes over when the library gave up reconnecting", async () => {
		connection.dispatchEvent(
			new CustomEvent("error", { detail: { error: new Error("refused") } }),
		);
		expect(keep.problem).toBe("refused");
		while (connection.state !== "connected") await Bun.sleep(1);
	});

	test("an error while connected is no failed connect", () => {
		connection.state = "connected";
		connection.dispatchEvent(
			new CustomEvent("error", { detail: { error: new Error("oops") } }),
		);
		expect(keep.problem).toBeUndefined();
		expect(keep.retrying).toBe(false);
	});

	test("leaves connecting to the library while it reconnects", () => {
		connection.reconnecting = { reason: "network", attempt: 1, at: 0 };
		keep.connect();
		expect(connection.calls).toEqual([]);
	});

	test("a connect the panel started failing counts as well", async () => {
		keep.failed(new Error("no relay"));
		expect(keep.problem).toBe("no relay");
		while (connection.state !== "connected") await Bun.sleep(1);
	});

	test("a new connection takes over from the one before", async () => {
		const old = connection;
		old.errors = [new Error("relay down")];
		keep.connect();
		connection = new FakeConnection();
		keep.watch(connection);
		await Bun.sleep(10);
		expect(keep.problem).toBeUndefined();
		expect(old.calls).toHaveLength(1);
		old.state = "connected";
		old.end("idle");
		expect(old.calls).toHaveLength(1);
	});
});
