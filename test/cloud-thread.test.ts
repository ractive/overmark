/**
 * A case's thread, its closing and the AI app's name in the sync with a team
 * (DEC-046; the server's DEC-017 to DEC-019), against the API in memory.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
	type Case,
	isOwnComment,
	newId,
	withCaseComment,
	withCaseCommentText,
	withClosed,
	withoutAnnotation,
	withoutCaseComment,
	withResolution,
} from "../src/lib/case.ts";
import type { Op } from "../src/lib/cloud/api.ts";
import type { CaseBook } from "../src/lib/cloud/book.ts";
import type { FakeApi } from "./cloud-fake.ts";
import { FakeServer } from "./cloud-fake.ts";
import {
	addMark,
	change,
	type Device,
	device,
	PAY,
	signIn,
	startCase,
	sync,
} from "./cloud-helpers.ts";

const TESS = { id: "u_tess", name: "Tess Tester" };
const DANA = { id: "u_dana", name: "Dana Developer" };
const CLAUDE = {
	id: "https://claude.ai/oauth",
	name: "Claude",
	host: "claude.ai",
};

let server: FakeServer;
let tess: Device<FakeApi>;
let dana: Device<FakeApi>;

beforeEach(() => {
	server = new FakeServer();
	tess = device("tess", server.api(TESS));
	dana = device("dana", server.api(DANA));
});

const book = (d: Device, caseId: string) =>
	d.kv.data.get(`case:${caseId}`) as CaseBook | undefined;
/** The operations a device sent, of these types. */
const sent = (d: Device<FakeApi>, ...types: Op["type"][]): Op[] =>
	(d.api as unknown as { sentOps?: Op[] }).sentOps?.filter((o) =>
		types.includes(o.type),
	) ?? [];
/** The summary for the developer, as the panel writes it. */
const withVerdict = (c: Case, verdict: string, now: string): Case => ({
	...c,
	verdict,
	updatedAt: now,
});
const caseHere = async (d: Device, id = "c_flow") =>
	(await d.store.getCase(id)) as Case;

/** Record every operation a device sends. */
function recording(d: Device<FakeApi>): void {
	const api = d.api as FakeApi & { sentOps?: Op[] };
	api.sentOps = [];
	const ops = api.ops.bind(api);
	api.ops = async (team, list) => {
		api.sentOps?.push(...structuredClone(list));
		return ops(team, list);
	};
}

async function shared(): Promise<void> {
	await signIn(tess);
	await signIn(dana);
	await startCase(tess, "c_flow");
	await addMark(tess, "c_flow", "Total is cut off");
	await addMark(tess, "c_flow", "Pay button too pale", { url: PAY });
	await sync(tess, dana);
}

describe("the thread", () => {
	test("a comment on the case and one on a mark reach the team, with who wrote them; changed and deleted, also without a case named", async () => {
		await shared();
		await change(tess, "c_flow", (c, now) =>
			withCaseComment(c, { id: "k_case", text: "Looked at both pages." }, now),
		);
		await change(tess, "c_flow", (c, now) =>
			withCaseComment(
				c,
				{ id: "k_mark", text: "Which total?", mark: "a1" },
				now,
			),
		);
		await sync(tess, dana);
		expect(server.commentsOf("c_flow").map((k) => k.text)).toEqual([
			"Looked at both pages.",
			"Which total?",
		]);
		const there = (await caseHere(dana)).comments ?? [];
		expect(there.map((k) => [k.id, k.mark ?? null, k.user?.name])).toEqual([
			["k_case", null, "Tess Tester"],
			["k_mark", "a1", "Tess Tester"],
		]);
		// Tess's own comment, changed and then deleted by her.
		await change(tess, "c_flow", (c, now) =>
			withCaseCommentText(c, "k_mark", "Which total, net or gross?", now),
		);
		await sync(tess, dana);
		const edited = (await caseHere(dana)).comments?.[1];
		expect(edited?.text).toBe("Which total, net or gross?");
		expect(edited?.edited?.user?.name).toBe("Tess Tester");
		await change(tess, "c_flow", (c, now) =>
			withoutCaseComment(c, "k_case", now),
		);
		await sync(tess, dana);
		// The server lists the delete with no case: found by the comment's id.
		expect(server.changes(0).removed).toContainEqual(
			expect.objectContaining({ type: "comment", id: "k_case" }),
		);
		expect((await caseHere(dana)).comments?.map((k) => k.id)).toEqual([
			"k_mark",
		]);
		expect(book(dana, "c_flow")?.shadow?.comments?.["k_case"]).toBeUndefined();
	});

	test("another's comment that is no longer here is not deleted for the team: only one's own", async () => {
		await shared();
		await change(dana, "c_flow", (c, now) =>
			withCaseComment(c, { id: "k_dana", text: "Dana's word" }, now),
		);
		await sync(dana, tess);
		recording(tess);
		// Gone from Tess's copy (a file replaced it, say).
		await change(tess, "c_flow", (c, now) => ({
			...c,
			comments: [],
			updatedAt: now,
		}));
		await sync(tess, dana);
		expect(sent(tess, "comment.delete")).toEqual([]);
		expect(server.commentsOf("c_flow").map((k) => k.id)).toEqual(["k_dana"]);
	});

	test("a comment written offline waits and goes when the server is back, at the end of the thread with its own time", async () => {
		await shared();
		await change(dana, "c_flow", (c, now) =>
			withCaseComment(c, { id: "k_first", text: "First" }, now),
		);
		tess.api.offline = true;
		await change(tess, "c_flow", (c, now) =>
			withCaseComment(c, { id: "k_offline", text: "Written offline" }, now),
		);
		const writtenAt = (await caseHere(tess)).comments?.[0]?.at;
		await tess.engine.request();
		await dana.engine.request();
		tess.api.offline = false;
		await sync(tess, dana);
		expect(server.commentsOf("c_flow").map((k) => k.id)).toEqual([
			"k_first",
			"k_offline",
		]);
		expect(server.commentsOf("c_flow")[1]?.at).toBe(writtenAt as string);
		expect((await caseHere(dana)).comments?.map((k) => k.id)).toEqual([
			"k_first",
			"k_offline",
		]);
	});

	test("a comment follows its mark when the mark takes another number; one about a deleted mark stays, about a deleted mark", async () => {
		await shared();
		// Both add a mark at once: Tess's becomes 4, and her comment follows it.
		await addMark(tess, "c_flow", "Tess's third");
		await change(tess, "c_flow", (c, now) =>
			withCaseComment(
				c,
				{ id: "k_on3", text: "About my third", mark: "a3" },
				now,
			),
		);
		await addMark(dana, "c_flow", "Dana's third");
		await dana.engine.request();
		await sync(tess, dana);
		const c = await caseHere(tess);
		const mine = c.annotations.find((a) => a.comment === "Tess's third");
		expect(mine?.id).toBe("a4");
		expect(c.comments?.[0]?.mark).toBe("a4");
		expect((await caseHere(dana)).comments?.[0]?.mark).toBe("a4");
		// The mark deleted: the comment stays, about a deleted mark.
		await change(tess, "c_flow", (c, now) => withoutAnnotation(c, "a4", now));
		await sync(tess, dana);
		const left = (await caseHere(dana)).comments?.[0];
		expect(left?.mark).toBeUndefined();
		expect(left?.markGone).toBe(true);
	});

	test("read whole again, the thread is in the server's order", async () => {
		await shared();
		for (const [who, id] of [
			[tess, "k_1"],
			[dana, "k_2"],
			[tess, "k_3"],
		] as const) {
			await change(who, "c_flow", (c, now) =>
				withCaseComment(c, { id, text: id }, now),
			);
			await who.engine.request();
		}
		await sync(tess, dana);
		// A new device of Dana's reads everything.
		const fresh = device("dana", server.api(DANA));
		await signIn(fresh);
		await sync(fresh);
		expect((await caseHere(fresh)).comments?.map((k) => k.id)).toEqual([
			"k_1",
			"k_2",
			"k_3",
		]);
	});
});

describe("closing", () => {
	test("closed for the team, with who; a new open mark opens it again at the server, and here", async () => {
		await shared();
		await change(tess, "c_flow", (c, now) => withClosed(c, true, now));
		await sync(tess, dana);
		expect(server.caseOf("c_flow")?.closed?.user?.name).toBe("Tess Tester");
		expect((await caseHere(dana)).closed?.user?.name).toBe("Tess Tester");
		// Dana adds an open mark: the case is open again, here and there.
		await addMark(dana, "c_flow", "One more thing");
		expect((await caseHere(dana)).closed).toBeUndefined();
		await sync(dana, tess);
		expect(server.caseOf("c_flow")?.closed).toBeNull();
		expect((await caseHere(tess)).closed).toBeUndefined();
	});

	test("reopened by hand, and closed again with a new mark in the same run: the mark first, then the close", async () => {
		await shared();
		await change(tess, "c_flow", (c, now) => withClosed(c, true, now));
		await sync(tess, dana);
		recording(dana);
		await change(dana, "c_flow", (c, now) => withClosed(c, false, now));
		await dana.engine.request();
		expect(sent(dana, "case.reopen")).toHaveLength(1);
		expect(server.caseOf("c_flow")?.closed).toBeNull();
		await addMark(dana, "c_flow", "Last one");
		await change(dana, "c_flow", (c, now) =>
			withClosed(
				withResolution(c, "a3", { kind: "fixed", note: "" }, now),
				true,
				now,
			),
		);
		await sync(dana, tess);
		const types = (dana.api as FakeApi & { sentOps: Op[] }).sentOps.map(
			(o) => o.type,
		);
		expect(types.lastIndexOf("case.close")).toBeGreaterThan(
			types.lastIndexOf("mark.create"),
		);
		expect(server.caseOf("c_flow")?.closed?.user?.name).toBe("Dana Developer");
		expect((await caseHere(tess)).closed).toBeDefined();
	});
});

describe("the AI app's name (via)", () => {
	test("what an AI app did through this browser names the app; what the person did does not", async () => {
		await shared();
		recording(tess);
		// By an app: its comment, its close, its summary.
		await change(tess, "c_flow", (c, now) =>
			withCaseComment(
				c,
				{ id: newId("k"), text: "Fixed in PR 12.", app: CLAUDE },
				now,
			),
		);
		await change(tess, "c_flow", (c, now) => ({
			...withVerdict(c, "Shorter labels", now),
			via: { app: CLAUDE, at: now },
		}));
		await tess.engine.request();
		const comment = sent(tess, "comment.create")[0];
		expect(comment && "via" in comment ? comment.via : undefined).toEqual(
			CLAUDE,
		);
		const patch = sent(tess, "case.patch")[0];
		expect(patch && "via" in patch ? patch.via : undefined).toEqual(CLAUDE);
		expect(server.commentsOf("c_flow")[0]?.app?.name).toBe("Claude");
		expect(server.caseOf("c_flow")?.summaryBy?.app?.name).toBe("Claude");
		await dana.engine.request();
		const there = await caseHere(dana);
		expect(there.comments?.[0]?.app?.name).toBe("Claude");
		expect(there.summaryBy?.user?.name).toBe("Tess Tester");
		expect(there.summaryBy?.app?.name).toBe("Claude");
		// By hand after it: no app.
		await change(tess, "c_flow", (c, now) =>
			withVerdict(c, "Shorter labels, by hand", now),
		);
		await tess.engine.request();
		const second = sent(tess, "case.patch")[1];
		expect(second && "via" in second).toBe(false);
	});

	test("a mark made through an AI app is the app's at the server, beside the person", async () => {
		await shared();
		await change(tess, "c_flow", (c, now) => ({
			...c,
			annotations: c.annotations.map((a) => (a.id === "a2" ? a : a)),
			updatedAt: now,
		}));
		const made = await addMark(tess, "c_flow", "Made by Claude");
		await change(tess, "c_flow", (c, now) => ({
			...c,
			annotations: c.annotations.map((a) =>
				a.id === made.id
					? { ...a, author: "ai" as const, createdVia: CLAUDE }
					: a,
			),
			updatedAt: now,
		}));
		await sync(tess, dana);
		const wire = server
			.marksOf("c_flow")
			.find((m) => m.comment === "Made by Claude");
		expect(wire?.createdVia?.name).toBe("Claude");
		expect(wire?.author).toBe("ai");
		const there = (await caseHere(dana)).annotations.find(
			(a) => a.comment === "Made by Claude",
		);
		expect(there?.createdVia?.name).toBe("Claude");
		expect(there?.createdBy?.name).toBe("Tess Tester");
	});

	test("a comment from a file goes as the importer's, never as the app the file names; an app may not take it over", async () => {
		await shared();
		recording(tess);
		await change(tess, "c_flow", (c, now) => ({
			...c,
			comments: [
				{
					id: "k_file",
					text: "From the file",
					at: now,
					app: CLAUDE,
					imported: true,
				},
			],
			updatedAt: now,
		}));
		await tess.engine.request();
		const create = sent(tess, "comment.create")[0];
		expect(create && "via" in create).toBe(false);
		expect(server.commentsOf("c_flow")[0]?.user?.name).toBe("Tess Tester");
		expect(server.commentsOf("c_flow")[0]?.app).toBeUndefined();
		expect(
			isOwnComment(
				{ id: "k", text: "x", at: "t", app: CLAUDE, imported: true },
				undefined,
				CLAUDE.id,
			),
		).toBe(false);
	});
});
