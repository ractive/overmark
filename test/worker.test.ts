/**
 * The AI connection's pieces in the service worker (DEC-015): who may send
 * what, the questions of tools that change something, the address secret's
 * storage, the settings in IndexedDB (and what an unreleased build left in
 * chrome.storage.local removed), the panel's old settings handed over, and
 * bundles: one a service worker can run, a side panel that keeps no setting.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfirmRequest, RelayClient } from "@ractive-ch/tab-mcp-client";
import { build } from "../scripts/build.ts";
import { isWorkerRequest } from "../src/lib/messages.ts";
import { oldSettings, statusText } from "../src/sidepanel/ai.ts";
import {
	DATABASE,
	memoryKv,
	type OldArea,
	removeOldSettings,
} from "../src/worker/kv.ts";
import {
	type AiState,
	isPanelSender,
	type PanelCommand,
	parseCommand,
} from "../src/worker/protocol.ts";
import {
	appName,
	NOTIFICATION_BUTTONS,
	NOTIFICATION_GUARD_MS,
	type NotificationText,
	Questions,
	type QuestionsHost,
	visible,
	WEBMCP_CALLER,
} from "../src/worker/questions.ts";
import { CachedSecretStorage } from "../src/worker/secret.ts";
import { kvContract } from "./kv-contract.ts";

const ID = "fphhchhlgklidhnodoleiebmdhnfdadg";
const PANEL = `chrome-extension://${ID}/sidepanel/index.html`;
const contentScript = { id: ID, url: "https://site.test/page", tab: { id: 1 } };

/** Every command there is, valid. */
const COMMANDS: PanelCommand[] = [
	{ type: "hello", windowId: 1 },
	{ type: "connect" },
	{ type: "stop" },
	{ type: "keep-on", on: true },
	{ type: "blur-forms", on: false },
	{ type: "pair", on: true },
	{ type: "revoke", grantId: "g" },
	{ type: "allow-all", grantId: "g", on: true },
	{ type: "ask-again", grantId: "g", tool: "delete_case" },
	{ type: "new-address" },
	{ type: "set-relay", relay: "https://relay.example" },
	{ type: "answer", id: "q", answer: "allow" },
	{ type: "answer", id: "q", answer: "always" },
	{
		type: "migrate",
		relay: "https://relay.example",
		keepOn: true,
		blurForms: false,
		secrets: { "tab-mcp:secret:https://relay.example:overmark": "s" },
	},
];

describe("who may send what", () => {
	test("a port is the panel's only from the side panel's page of this extension", () => {
		expect(isPanelSender({ id: ID, url: PANEL }, ID)).toBe(true);
		// A content script: its page's address, and a tab.
		expect(isPanelSender(contentScript, ID)).toBe(false);
		expect(isPanelSender({ ...contentScript, url: PANEL }, ID)).toBe(false);
		// The panel's page opened in a tab by its address is no side panel.
		expect(isPanelSender({ id: ID, url: PANEL, tab: { id: 2 } }, ID)).toBe(
			false,
		);
		// Another extension, another page of this one, no address at all.
		expect(
			isPanelSender(
				{ id: "x".repeat(32), url: PANEL.replace(ID, "x".repeat(32)) },
				ID,
			),
		).toBe(false);
		expect(
			isPanelSender({ id: ID, url: PANEL.replace(ID, "x".repeat(32)) }, ID),
		).toBe(false);
		expect(
			isPanelSender(
				{ id: ID, url: `chrome-extension://${ID}/sidepanel/other.html` },
				ID,
			),
		).toBe(false);
		expect(isPanelSender({ id: ID }, ID)).toBe(false);
		expect(isPanelSender({ id: ID, url: "not a url" }, ID)).toBe(false);
	});

	test("no command is a one-off message the worker answers: content scripts cannot command", () => {
		for (const command of COMMANDS)
			expect(isWorkerRequest(command)).toBe(false);
		// What content scripts do send still passes.
		expect(
			isWorkerRequest({ type: "capture", caseId: "c_1", shotId: "s1" }),
		).toBe(true);
		for (const odd of [null, "capture", 1, {}, { type: "toString" }])
			expect(isWorkerRequest(odd)).toBe(false);
	});

	test("commands are checked: only well-formed ones pass, as they are", () => {
		for (const command of COMMANDS)
			expect(parseCommand(command)).toEqual(command);
		for (const bad of [
			null,
			"connect",
			{},
			{ type: "unknown" },
			{ type: "hello", windowId: "1" },
			{ type: "hello", windowId: 1.5 },
			{ type: "keep-on", on: "yes" },
			{ type: "blur-forms" },
			{ type: "blur-forms", on: 1 },
			{ type: "pair" },
			{ type: "revoke", grantId: 1 },
			{ type: "set-relay" },
			{ type: "answer", id: "q", answer: "never" },
			{ type: "allow-all", grantId: "g" },
			{ type: "allow-all", grantId: 1, on: true },
			{ type: "ask-again", grantId: "g" },
			{ type: "ask-again", tool: "delete_case" },
			{ type: "answer", id: 1, answer: "allow" },
			{ type: "migrate" },
			{ type: "migrate", secrets: {}, keepOn: "true" },
			{ type: "migrate", secrets: {}, relay: 5 },
		])
			expect(parseCommand(bad)).toBeUndefined();
		// Extra fields are dropped; secrets that are no strings too.
		expect(parseCommand({ type: "stop", extra: 1 })).toEqual({ type: "stop" });
		expect(
			parseCommand({ type: "migrate", secrets: { a: "1", b: 2 } }),
		).toEqual({ type: "migrate", secrets: { a: "1" } });
	});
});

/** A host whose notifications and panels the test controls. */
function fakeHost(options: { panel?: boolean } = {}) {
	const shown = new Map<string, NotificationText>();
	const cleared: string[] = [];
	let now = 1_000_000;
	const host: QuestionsHost & {
		shown: typeof shown;
		cleared: string[];
		advance(ms: number): void;
		changes: number;
	} = {
		shown,
		cleared,
		changes: 0,
		advance(ms) {
			now += ms;
		},
		windowOf: async (tabId) => (tabId === 7 ? 3 : undefined),
		panelInFocus: async (windowId) => options.panel === true && windowId === 3,
		notify: async (id, text) => {
			shown.set(id, text);
		},
		clear: (id) => {
			shown.delete(id);
			cleared.push(id);
		},
		changed: () => {
			host.changes++;
		},
		now: () => now,
	};
	return host;
}

function request(
	args: Record<string, unknown> = { caseId: "c_1" },
	signal = new AbortController().signal,
	tool = "delete_case",
	grantId = "g1",
): ConfirmRequest {
	return {
		tool: { name: tool, title: "Delete case", description: "" },
		arguments: args,
		client: claude(grantId),
		signal,
	};
}

function claude(grantId = "g1", name = "Claude"): RelayClient {
	return {
		kind: "relay",
		grantId,
		id: "https://claude.ai/oauth",
		name,
		host: "claude.ai",
	};
}

const CASE = ["Case: “Button contrast” (www.example.com/kk, 2 marks)."];
const settle = () => Bun.sleep(5);

describe("questions", () => {
	test("without a panel in front, a notification asks and names the case; Allow after the guard counts", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		const answer = questions.ask(request(), CASE, 7);
		await settle();
		expect(questions.list).toEqual([
			{
				id: expect.any(String),
				app: "Claude (claude.ai)",
				tool: "delete_case",
				title: "Delete case",
				lines: CASE,
				args: '{\n  "caseId": "c_1"\n}',
			},
		]);
		expect(host.changes).toBeGreaterThan(0);
		const [[id, text]] = [...host.shown] as [[string, NotificationText]];
		expect(text).toEqual({
			title: "Allow Delete case?",
			message: `Claude (claude.ai) wants to run delete_case: ${CASE[0]}`,
			contextMessage: "Overmark · close it to not allow",
		});
		host.advance(NOTIFICATION_GUARD_MS);
		questions.notificationButton(id, 0);
		expect(await answer).toBe("allow");
		expect(questions.list).toEqual([]);
		expect(host.shown.size).toBe(0);
	});

	test("questions an Always allow given meanwhile covers are allowed; others still wait", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		const signal = new AbortController().signal;
		const same = questions.ask(request(undefined, signal), CASE, 7);
		const otherTool = questions.ask(
			request(undefined, signal, "set_summary"),
			CASE,
			7,
		);
		const otherApp = questions.ask(
			request(undefined, signal, "delete_case", "g2"),
			CASE,
			7,
		);
		await settle();
		questions.allowCovered(
			(grantId, tool) => grantId === "g1" && tool === "delete_case",
		);
		expect(await same).toBe("allow");
		expect(questions.list.map((q) => q.tool)).toEqual([
			"set_summary",
			"delete_case",
		]);
		for (const q of questions.list) questions.answer(q.id, "deny");
		expect(await otherTool).toBe("deny");
		expect(await otherApp).toBe("deny");
	});

	test("without lines, the notification shows the arguments in short", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		void questions.ask(request({ caseId: "c_9" }), [], undefined);
		await settle();
		expect([...host.shown.values()][0]?.message).toBe(
			'Claude (claude.ai) wants to run delete_case: {"caseId":"c_9"}',
		);
	});

	test("the buttons are Allow and Always allow; closing it or a click on the body is Don't allow", async () => {
		expect([...NOTIFICATION_BUTTONS]).toEqual(["Allow", "Always allow"]);
		const host = fakeHost();
		const questions = new Questions(host);
		const always = questions.ask(request(), CASE, 7);
		await settle();
		host.advance(NOTIFICATION_GUARD_MS);
		questions.notificationButton([...host.shown.keys()].at(-1) as string, 1);
		expect(await always).toBe("always");
		const answer = questions.ask(request(), CASE, 7);
		await settle();
		host.advance(NOTIFICATION_GUARD_MS);
		// A button there is not answers nothing.
		const id = [...host.shown.keys()].at(-1) as string;
		questions.notificationButton(id, 2);
		await settle();
		expect(questions.list).toHaveLength(1);
		questions.notificationDismissed(id);
		expect(await answer).toBe("deny");
	});

	test("an Allow or Always allow within the guard does not count: the notification shows again", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		let settled = false;
		const answer = questions.ask(request(), CASE, 7);
		void answer.then(() => {
			settled = true;
		});
		await settle();
		let shown = [...host.shown.keys()][0] as string;
		const first = shown;
		host.advance(NOTIFICATION_GUARD_MS - 1);
		for (const index of [1, 0]) {
			questions.notificationButton(shown, index);
			await settle();
			expect(settled).toBe(false);
			const again = [...host.shown.keys()][0] as string;
			expect(again).not.toBe(shown);
			expect(host.cleared).toContain(shown);
			shown = again;
		}
		// The old one closing (as it was cleared) answers nothing.
		questions.notificationDismissed(first);
		await settle();
		expect(settled).toBe(false);
		host.advance(NOTIFICATION_GUARD_MS);
		questions.notificationButton(shown, 1);
		expect(await answer).toBe("always");
	});

	test("a click answers only its own call; one on a settled call is dropped", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		const a = questions.ask(request({ caseId: "c_a" }), [], 7);
		const b = questions.ask(request({ caseId: "c_b" }), [], 7);
		await settle();
		const [idA, idB] = [...host.shown.keys()] as [string, string];
		host.advance(NOTIFICATION_GUARD_MS);
		questions.notificationDismissed(idB);
		expect(await b).toBe("deny");
		// A late Allow on b's notification does not go to a.
		questions.notificationButton(idB, 0);
		await settle();
		expect(questions.list.map((q) => q.args)).toEqual([
			'{\n  "caseId": "c_a"\n}',
		]);
		questions.notificationButton(idA, 0);
		expect(await a).toBe("allow");
	});

	test("with the panel of the tab's focused window open, no notification; it goes out once the panel closes", async () => {
		const host = fakeHost({ panel: true });
		const questions = new Questions(host);
		const answer = questions.ask(request(), CASE, 7);
		await settle();
		expect(host.shown.size).toBe(0);
		expect(questions.list).toHaveLength(1);
		// Another window's panel closing changes nothing.
		questions.panelClosed(4);
		expect(host.shown.size).toBe(0);
		questions.panelClosed(3);
		expect(host.shown.size).toBe(1);
		questions.answer(questions.list[0]?.id as string, "allow");
		expect(await answer).toBe("allow");
		// Cleared once Chrome has made it.
		await settle();
		expect(host.shown.size).toBe(0);
	});

	test("a notification Chrome makes only after its call settled is cleared once it is there", async () => {
		const host = fakeHost();
		let made: () => void = () => {};
		host.notify = (id, text) =>
			new Promise<void>((resolve) => {
				made = () => {
					host.shown.set(id, text);
					resolve();
				};
			});
		const questions = new Questions(host);
		const controller = new AbortController();
		const answer = questions.ask(request({}, controller.signal), CASE, 7);
		await settle();
		// The AI app cancels before Chrome has made the notification.
		controller.abort();
		expect(await answer).toBe("deny");
		await settle();
		expect(host.cleared).toEqual([]);
		made();
		await settle();
		expect(host.shown.size).toBe(0);
		expect(host.cleared).toHaveLength(1);
	});

	test("no tab in front, or one in another window: a notification", async () => {
		const host = fakeHost({ panel: true });
		const questions = new Questions(host);
		void questions.ask(request(), CASE, undefined);
		void questions.ask(request(), CASE, 8);
		await settle();
		expect(host.shown.size).toBe(2);
	});

	test("an answer from a panel counts, also while a notification shows", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		const answer = questions.ask(request(), CASE, 7);
		await settle();
		expect(host.shown.size).toBe(1);
		questions.answer("not-a-question", "allow");
		questions.answer(questions.list[0]?.id as string, "deny");
		expect(await answer).toBe("deny");
		expect(host.shown.size).toBe(0);
	});

	test("nobody answering is a timeout; the AI app cancelling is Don't allow", async () => {
		const host = fakeHost();
		const questions = new Questions(host, 20);
		expect(await questions.ask(request(), CASE, 7)).toBe("timeout");
		expect(host.shown.size).toBe(0);
		expect(questions.list).toEqual([]);
		const controller = new AbortController();
		const cancelled = questions.ask(request({}, controller.signal), [], 7);
		await settle();
		controller.abort();
		expect(await cancelled).toBe("deny");
		expect(questions.list).toEqual([]);
		const gone = new AbortController();
		gone.abort();
		expect(await questions.ask(request({}, gone.signal), [], 7)).toBe("deny");
	});

	test("a call through WebMCP is not asked about: Don't allow at once, nothing shows", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		const r: ConfirmRequest = { ...request(), client: { kind: "webmcp" } };
		expect(await questions.ask(r, CASE, 7)).toBe("deny");
		await settle();
		expect(questions.list).toEqual([]);
		expect(host.shown.size).toBe(0);
		expect(host.changes).toBe(0);
		expect(appName({ kind: "webmcp" })).toBe(WEBMCP_CALLER);
		expect(appName(claude())).toBe("Claude (claude.ai)");
	});

	test("arguments, lines and names show invisible and direction characters as \\u escapes", async () => {
		expect(visible("pay‮evil​")).toBe("pay\\u202Eevil\\u200B");
		expect(visible("a b")).toBe("a\\u00A0b");
		expect(visible('{\n\t"a": 1\r}')).toBe('{\n\t"a": 1\\u000D}');
		// Also variation selectors, private use, lone surrogates, tags (as JSON writes them).
		expect(visible("ok\ufe0f")).toBe("ok\\uFE0F");
		expect(visible("a\ue000b")).toBe("a\\uE000b");
		expect(visible("a\ud800b")).toBe("a\\uD800b");
		expect(visible("a\u{e0041}b")).toBe("a\\uDB40\\uDC41b");
		expect(visible("a\u2800b\u3000c")).toBe("a\\u2800b\\u3000c");
		const questions = new Questions(fakeHost());
		const r = request({ caseId: "c‮1" });
		r.client = claude("g1", "Cl​aude");
		void questions.ask(r, ["Case: “x‮”"], 7);
		await settle();
		const [view] = questions.list;
		expect(view?.app).toBe("Cl\\u200Baude (claude.ai)");
		expect(view?.lines).toEqual(["Case: “x\\u202E”"]);
		expect(view?.args).toContain("c\\u202E1");
	});
});

describe("the address secret in the worker", () => {
	const KEY = "tab-mcp:secret:https://relay:overmark";
	const SECRET = "a".repeat(43);

	test("loaded once, read from memory, written through to the worker's database", async () => {
		const kv = memoryKv({ [KEY]: "s1", relay: "x" });
		const storage = await CachedSecretStorage.load(kv);
		expect(storage.getItem(KEY)).toBe("s1");
		// Only the library's keys.
		expect(storage.getItem("relay")).toBeNull();
		storage.setItem("tab-mcp:secret:https://other:overmark", "s2");
		expect(storage.getItem("tab-mcp:secret:https://other:overmark")).toBe("s2");
		await storage.written;
		expect(kv.data.get("tab-mcp:secret:https://other:overmark")).toBe("s2");
	});

	test("the panel's old secret is taken over only where the worker has none", async () => {
		const kv = memoryKv();
		const storage = await CachedSecretStorage.load(kv);
		expect(storage.adopt(KEY, SECRET)).toBe(true);
		await storage.written;
		expect(kv.data.get(KEY)).toBe(SECRET);
		// Never over one it has, never another key, never a value that is no secret.
		expect(storage.adopt(KEY, "b".repeat(43))).toBe(false);
		expect(storage.getItem(KEY)).toBe(SECRET);
		expect(storage.adopt("relay", SECRET)).toBe(false);
		expect(storage.adopt("tab-mcp:secret:https://x:overmark", "short")).toBe(
			false,
		);
		expect(storage.adopt("tab-mcp:secret:https://x:overmark", 42)).toBe(false);
		expect(storage.getItem("relay")).toBeNull();
	});
});

describe("the settings in IndexedDB (memoryKv; e2e/store.test.ts runs openKv)", () => {
	for (const [name, run] of Object.entries(kvContract))
		test(name, () => run(memoryKv()));
});

describe("what an unreleased build kept in chrome.storage.local", () => {
	/** chrome.storage.local as the clean-up sees it. */
	function oldArea(initial: Record<string, unknown>) {
		const data = { ...initial };
		const area: OldArea & { data: Record<string, unknown> } = {
			data,
			get: async () => ({ ...data }),
			async remove(keys: string[]) {
				for (const key of keys) delete data[key];
			},
		};
		return area;
	}

	test("is removed at every start and never taken over", async () => {
		// As overmark#26 wrote it, or a content script where Chrome lets it:
		// a relay of theirs, keep-on, a secret, the handover marked done.
		const old = oldArea({
			"tab-mcp:secret:https://evil.example:overmark": "E".repeat(43),
			relay: "https://evil.example",
			keepAiOn: true,
			blurForms: false,
			replaced: { sibling: false },
			migrated: true,
			somethingElse: 1,
		});
		expect((await removeOldSettings(old)).sort()).toEqual(
			[
				"blurForms",
				"keepAiOn",
				"migrated",
				"relay",
				"replaced",
				"tab-mcp:secret:https://evil.example:overmark",
			].sort(),
		);
		expect(old.data).toEqual({ somethingElse: 1 });
		// Again, and on a start with nothing there: nothing to do.
		expect(await removeOldSettings(old)).toEqual([]);
		expect(await removeOldSettings(oldArea({}))).toEqual([]);
	});
});

/** A `localStorage` with these entries. */
function local(entries: Record<string, string>) {
	const keys = Object.keys(entries);
	return {
		length: keys.length,
		key: (i: number) => keys[i] ?? null,
		getItem: (key: string) => entries[key] ?? null,
	};
}

describe("the side panel's old settings", () => {
	test("none: nothing to hand over", () => {
		expect(oldSettings(local({ other: "1" }))).toBeUndefined();
	});

	test("settings and secrets go to the worker once", () => {
		expect(
			oldSettings(
				local({
					"overmark:relay": "https://relay.example",
					"overmark:keep-ai-on": "true",
					"overmark:blur-forms": "false",
					"tab-mcp:secret:https://relay.example:overmark": "s",
					unrelated: "x",
				}),
			),
		).toEqual({
			type: "migrate",
			relay: "https://relay.example",
			keepOn: true,
			blurForms: false,
			secrets: { "tab-mcp:secret:https://relay.example:overmark": "s" },
		});
	});

	test("a panel that connected to the old default relay on this computer stays with it", () => {
		expect(
			oldSettings(
				local({ "tab-mcp:secret:http://localhost:8080:overmark": "s" }),
			),
		).toEqual({
			type: "migrate",
			relay: "http://localhost:8080",
			secrets: { "tab-mcp:secret:http://localhost:8080:overmark": "s" },
		});
	});
});

describe("the panel's status line", () => {
	const base: AiState = {
		relay: "https://relay.example",
		keepOn: false,
		blurForms: false,
		state: "disconnected",
		reconnecting: false,
		retrying: false,
		grants: [],
		pairing: false,
		questions: [],
		migrated: true,
	};

	test.each([
		[{}, "Not connected"],
		[{ state: "connecting" }, "Connecting…"],
		[{ state: "connected" }, "Waiting for an AI app to pair"],
		[
			{
				state: "connected",
				grants: [
					{ grantId: "g", name: "Claude", host: "claude.ai" },
					{ grantId: "h", name: "", host: "chatgpt.com" },
				],
			},
			"Connected: Claude, chatgpt.com",
		],
		[{ reconnecting: true }, "Connection lost, retrying…"],
		[
			{ problem: "Could not connect", retrying: true },
			"Not connected: Could not connect Trying again…",
		],
		[
			{ replaced: { sibling: false }, problem: "x" },
			"Not connected: the address is in use elsewhere.",
		],
		[
			{ relayNote: "The saved relay x cannot be used." },
			"The saved relay x cannot be used.",
		],
	] as [Partial<AiState>, string][])("%o", (change, text) => {
		expect(statusText({ ...base, ...change })).toBe(text);
	});
});

describe("the service worker's bundle", () => {
	test("has no dynamic import(), which a service worker refuses", async () => {
		const dir = mkdtempSync(join(tmpdir(), "overmark-build-"));
		try {
			const { outdir } = await build({ outdir: join(dir, "dist"), test: true });
			const code = await Bun.file(join(outdir, "background.js")).text();
			expect(code).not.toMatch(/\bimport\s*\(/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the side panel's bundle", () => {
	test("touches no storage of the settings: it changes them only over the port", async () => {
		const dir = mkdtempSync(join(tmpdir(), "overmark-build-"));
		try {
			const { outdir } = await build({ outdir: join(dir, "dist"), test: true });
			const files = [
				...new Bun.Glob("sidepanel/**/*.js").scanSync({ cwd: outdir }),
			];
			expect(files.length).toBeGreaterThan(0);
			for (const file of files) {
				const code = await Bun.file(join(outdir, file)).text();
				// Neither chrome.storage (any area) nor the worker's database.
				expect(code).not.toMatch(/\bstorage\s*\.\s*(local|session|sync)\b/);
				expect(code).not.toMatch(/\bstorage\s*\.\s*onChanged\b/);
				expect(code).not.toContain(DATABASE);
			}
			// The worker's does use both.
			const worker = await Bun.file(join(outdir, "background.js")).text();
			expect(worker).toContain(DATABASE);
			expect(worker).toMatch(/\bstorage\.local\b/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
