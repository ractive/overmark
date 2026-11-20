/**
 * Sitegloss 0.3.0 beside this build (DEC-046): a 0.3.0 browser on the same
 * team keeps syncing while this build comments and closes, and 0.3.0 reads a
 * file this build writes. 0.3.0's sync is the copy in `compat/v0.3.0` (never
 * edited); the server is the one in memory, with what the server added
 * (closing, comments, the app's name).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
	type Case,
	withCaseComment,
	withClosed,
	withoutCaseComment,
} from "../src/lib/case.ts";
import { CloudSync } from "../src/lib/cloud/engine.ts";
import { exportCase, readExport, storeImport } from "../src/lib/export.ts";
import { MemoryStore } from "../src/lib/store.ts";
import { readZip } from "../src/lib/zip.ts";
import type { FakeApi } from "./cloud-fake.ts";
import { FakeServer } from "./cloud-fake.ts";
import {
	addMark,
	change,
	type Device,
	device,
	SERVER,
	signIn,
	startCase,
	webp,
} from "./cloud-helpers.ts";
import {
	type Case as Case030,
	validateCase as validateCase030,
	withComment as withComment030,
} from "./compat/v0.3.0/src/lib/case.ts";
import { CloudSync as CloudSync030 } from "./compat/v0.3.0/src/lib/cloud/engine.ts";
import { memoryKv as memoryKv030 } from "./compat/v0.3.0/src/lib/kv.ts";
import { MemoryStore as MemoryStore030 } from "./compat/v0.3.0/src/lib/store.ts";

const TESS = { id: "u_tess", name: "Tess Tester" };
const DANA = { id: "u_dana", name: "Dana Developer" };
const CLAUDE = {
	id: "https://claude.ai/oauth",
	name: "Claude",
	host: "claude.ai",
};

/** A browser with 0.3.0's sync. */
function device030(api: FakeApi) {
	const store = new MemoryStore030();
	const kv = memoryKv030();
	const statuses: { state: string; problems: unknown[] }[] = [];
	const clock = { now: new Date("2026-11-19T10:00:00.000Z") };
	let ids = 0;
	const engine = new CloudSync030({
		store,
		kv,
		// The server in memory speaks the contract 0.3.0 was built for, and more.
		api: () => api as never,
		now: () => {
			clock.now = new Date(clock.now.getTime() + 1000);
			return clock.now;
		},
		newId: (prefix: string) => `${prefix}_old_${++ids}`,
		onStatus: (status) => statuses.push(status),
	});
	return { store, kv, api, engine, statuses, clock };
}

let server: FakeServer;
let tess: Device<FakeApi>;
let dana: ReturnType<typeof device030>;

beforeEach(async () => {
	server = new FakeServer();
	tess = device("tess", server.api(TESS));
	dana = device030(server.api(DANA));
	await signIn(tess);
	await dana.engine.signedIn(SERVER, await dana.api.me());
});

const sync = async () => {
	for (let i = 0; i < 3; i++) {
		await tess.engine.request();
		await dana.engine.request();
	}
};
const lastStatus = () => dana.statuses.at(-1);

describe("a 0.3.0 browser on the same team", () => {
	test("keeps syncing marks while this build comments, closes and names its AI app; what it adds opens the case again", async () => {
		await startCase(tess, "c_flow");
		await addMark(tess, "c_flow", "Total is cut off");
		await addMark(tess, "c_flow", "Pay button too pale");
		await change(tess, "c_flow", (c, now) =>
			withCaseComment(c, { id: "k_case", text: "Both pages checked." }, now),
		);
		await change(tess, "c_flow", (c, now) =>
			withCaseComment(
				c,
				{ id: "k_mark", text: "Fixed in PR 12.", mark: "a1", app: CLAUDE },
				now,
			),
		);
		await change(tess, "c_flow", (c, now) => withClosed(c, true, now));
		await sync();
		expect(server.commentsOf("c_flow")).toHaveLength(2);
		expect(server.caseOf("c_flow")?.closed?.user?.name).toBe("Tess Tester");
		// 0.3.0 has the case and its marks, and nothing it does not know.
		const old = (await dana.store.getCase("c_flow")) as Case030;
		expect(old.annotations.map((a) => a.comment)).toEqual([
			"Total is cut off",
			"Pay button too pale",
		]);
		expect("comments" in old || "closed" in old).toBe(false);
		expect(lastStatus()?.state).toBe("synced");
		expect(lastStatus()?.problems).toEqual([]);

		// 0.3.0 changes a mark: it arrives, and the thread and the close stay.
		await dana.store.updateCase("c_flow", (c) => ({
			value: withComment030(
				c as Case030,
				"a1",
				"Total is cut off on small screens",
				new Date(dana.clock.now.getTime() + 60_000).toISOString(),
			),
		}));
		await sync();
		const here = (await tess.store.getCase("c_flow")) as Case;
		expect(here.annotations[0]?.comment).toBe(
			"Total is cut off on small screens",
		);
		expect(here.comments?.map((k) => k.id)).toEqual(["k_case", "k_mark"]);
		expect(here.closed).toBeDefined();
		expect(server.commentsOf("c_flow")).toHaveLength(2);

		// A comment deleted here: the server lists it with no case, and 0.3.0
		// passes it by.
		await change(tess, "c_flow", (c, now) =>
			withoutCaseComment(c, "k_case", now),
		);
		await sync();
		expect(server.commentsOf("c_flow").map((k) => k.id)).toEqual(["k_mark"]);
		expect(lastStatus()?.state).toBe("synced");
		expect(lastStatus()?.problems).toEqual([]);

		// 0.3.0 adds an open mark (it knows nothing of closing): the server
		// opens the case again, and this build follows.
		await dana.store.putImage("c_flow", "crops/a3.webp", {
			blob: webp("crop by dana", 280, 160),
			width: 280,
			height: 160,
		});
		await dana.store.updateCase("c_flow", (c) => {
			const value = c as Case030;
			const first = value.annotations[0] as Case030["annotations"][number];
			return {
				value: {
					...value,
					annotations: [
						...value.annotations,
						{
							...first,
							id: "a3",
							number: 3,
							comment: "From 0.3.0",
							crop: "crops/a3.webp",
							shape: { kind: "note", at: { x: 5, y: 5 } },
							element: null,
						},
					],
					updatedAt: new Date(dana.clock.now.getTime() + 120_000).toISOString(),
				},
			};
		});
		await sync();
		expect(server.marksOf("c_flow").map((m) => m.comment)).toContain(
			"From 0.3.0",
		);
		expect(server.caseOf("c_flow")?.closed).toBeNull();
		expect(
			((await tess.store.getCase("c_flow")) as Case).closed,
		).toBeUndefined();
	});
});

describe("0.3.0's data opened by this build", () => {
	test("its cases, books and account open as they are, keep syncing, and get the thread and closing 0.3.0 passed by", async () => {
		await startCase(tess, "c_up");
		await addMark(tess, "c_up", "Total is cut off");
		await sync();
		// What 0.3.0 reads past and does not keep.
		await change(tess, "c_up", (c, now) =>
			withClosed(
				withCaseComment(c, { id: "k_before", text: "Before the upgrade" }, now),
				true,
				now,
			),
		);
		await sync();
		expect(lastStatus()?.state).toBe("synced");
		// The extension is reloaded with this build: the same database.
		const statuses: { state: string; problems: unknown[] }[] = [];
		const engine = new CloudSync({
			store: dana.store as never,
			kv: dana.kv as never,
			api: () => dana.api as never,
			onStatus: (s) => statuses.push(s),
		});
		expect((await engine.account())?.server).toBe(SERVER);
		await engine.request();
		await engine.request();
		expect(statuses.at(-1)?.state).toBe("synced");
		expect(statuses.at(-1)?.problems).toEqual([]);
		const here = (await dana.store.getCase("c_up")) as unknown as Case;
		expect(here.comments?.map((k) => k.text)).toEqual(["Before the upgrade"]);
		expect(here.closed?.user?.name).toBe("Tess Tester");
		// And on: a comment of Dana's reaches the team.
		await dana.store.updateCase("c_up", (c) => ({
			value: withCaseComment(
				c as unknown as Case,
				{ id: "k_after", text: "After the upgrade" },
				new Date(dana.clock.now.getTime() + 60_000).toISOString(),
			) as never,
		}));
		await engine.request();
		expect(server.commentsOf("c_up").map((k) => k.text)).toEqual([
			"Before the upgrade",
			"After the upgrade",
		]);
		// Looked for once: a run after that reads no case anew.
		let reads = 0;
		const getCase = dana.api.getCase.bind(dana.api);
		dana.api.getCase = (team, id) => {
			reads++;
			return getCase(team, id);
		};
		await engine.request();
		expect(reads).toBe(0);
	});
});

describe("a file this build writes", () => {
	test("0.3.0 reads it, without what it does not know; this build reads it back whole, without this browser's notes", async () => {
		await startCase(tess, "c_file");
		await addMark(tess, "c_file", "Total is cut off");
		// The thread, a close and a mark made through Claude, as the tools
		// and the panel make them.
		const c = await change(tess, "c_file", (k, now) => ({
			...withClosed(
				withCaseComment(
					withCaseComment(k, { id: "k_1", text: "On the case" }, now),
					{ id: "k_2", text: "On mark 1", mark: "a1", app: CLAUDE },
					now,
				),
				true,
				now,
				CLAUDE,
			),
			annotations: k.annotations.map((a) => ({ ...a, createdVia: CLAUDE })),
			createdVia: CLAUDE,
		}));
		expect(c.via?.app.name).toBe("Claude");
		const zip = await exportCase(tess.store, c);
		const json = JSON.parse(
			new TextDecoder().decode(
				(await readZip(zip)).get("case.json") as Uint8Array,
			),
		);
		// This browser's notes for its sync are not in the file.
		expect("via" in json || "createdVia" in json).toBe(false);
		expect("createdVia" in (json.annotations[0] ?? {})).toBe(true);
		// 0.3.0: the case and its marks, nothing else.
		const old = validateCase030(json);
		expect(old.annotations.map((a) => a.comment)).toEqual(["Total is cut off"]);
		expect(Object.keys(old)).not.toContain("comments");
		expect(Object.keys(old)).not.toContain("closed");
		expect(Object.keys(old.annotations[0] ?? {})).not.toContain("createdVia");
		// This build, imported as a user imports it: the thread and the close;
		// who wrote a comment is what the file says; a mark's app, the server's
		// to say, is left out.
		const into = new MemoryStore();
		const back = await storeImport(into, await readExport(zip));
		expect(
			back.comments?.map((k) => [
				k.id,
				k.mark ?? null,
				k.app?.name ?? null,
				k.imported ?? false,
			]),
		).toEqual([
			["k_1", null, null, true],
			["k_2", "a1", "Claude", true],
		]);
		expect(back.closed?.app?.name).toBe("Claude");
		expect(back.annotations[0]?.createdVia).toBeUndefined();
		expect(back.via).toBeUndefined();
		expect(back.createdVia).toBeUndefined();
	});
});
