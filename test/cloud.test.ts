/**
 * The sync with a team (DEC-039), against the API in memory
 * (`cloud-fake.ts`), which keeps the server's rules: two devices that end up
 * the same, changes that wait while the server is away, marks that take the
 * number the server gives, deletes that reach everyone, and a contract that
 * has grown since this build.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
	type Case,
	isOwnFinding,
	withChoice,
	withComment,
	withFinding,
	withLink,
	withoutAnnotation,
	withTitle,
	withVerified,
} from "../src/lib/case.ts";
import {
	ApiFailure,
	type Op,
	SMALL_PAGE,
	TOO_LARGE,
} from "../src/lib/cloud/api.ts";
import {
	type Account,
	type CaseBook,
	KEYS,
	type Queue,
} from "../src/lib/cloud/book.ts";
import type { StoredImage } from "../src/lib/store.ts";
import type { FakeApi } from "./cloud-fake.ts";
import { FakeServer, TEAM } from "./cloud-fake.ts";
import {
	addMark,
	CART,
	change,
	type Device,
	device,
	images,
	keys,
	look,
	PAY,
	signIn,
	startCase,
	status,
	sync,
} from "./cloud-helpers.ts";

const TESS = { id: "u_tess", name: "Tess Tester" };
const DANA = { id: "u_dana", name: "Dana Developer" };

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
const posts = (d: Device<FakeApi>) =>
	d.api.calls.filter((c) => c.startsWith("POST ops"));

/** Both signed in, and a case of Tess's with two marks on two pages at both. */
async function shared(): Promise<void> {
	await signIn(tess);
	await signIn(dana);
	await startCase(tess, "c_flow");
	await addMark(tess, "c_flow", "Total is cut off", { element: true });
	await addMark(tess, "c_flow", "Pay button too pale", {
		url: PAY,
		title: "Payment",
	});
	await sync(tess, dana);
}

describe("the first time a device meets its team", () => {
	test("cases that were here before are not sent without a word: the user is asked", async () => {
		await startCase(tess, "c_old");
		await addMark(tess, "c_old", "Was here before");
		await startCase(tess, "c_older");
		await addMark(tess, "c_older", "This one too");
		await signIn(tess);
		expect(server.cases.size).toBe(0);
		expect(posts(tess)).toEqual([]);
		expect(status(tess)?.undecided).toBe(2);
		expect(tess.kv.data.get(KEYS.modes)).toEqual({
			c_old: "undecided",
			c_older: "undecided",
		});
		// "Sync them".
		await tess.engine.decide(true);
		expect([...server.cases.keys()].sort()).toEqual(["c_old", "c_older"]);
		expect(status(tess)?.undecided).toBe(0);
		expect(status(tess)?.state).toBe("synced");
	});

	test("Keep them on this device: nothing goes, and one can be shared later", async () => {
		await startCase(tess, "c_old");
		await addMark(tess, "c_old", "Was here before");
		await startCase(tess, "c_other");
		await addMark(tess, "c_other", "Stays private");
		await signIn(tess);
		await tess.engine.decide(false);
		expect(server.cases.size).toBe(0);
		expect(status(tess)?.undecided).toBe(0);
		// Changing it changes nothing about that.
		await change(tess, "c_old", (c, now) => withTitle(c, "Renamed", now));
		await tess.engine.request();
		expect(server.cases.size).toBe(0);
		// "Share with team" on one of them.
		await tess.engine.share("c_old");
		expect([...server.cases.keys()]).toEqual(["c_old"]);
		expect(server.caseOf("c_old")?.title).toBe("Renamed");
		expect(tess.kv.data.get(KEYS.modes)).toEqual({
			c_old: "synced",
			c_other: "local",
		});
	});

	test("a case made after that is the team's, once it has a mark", async () => {
		await signIn(tess);
		await startCase(tess, "c_new");
		await tess.engine.request();
		// As the folder sync: a case without marks is not sent.
		expect(server.cases.size).toBe(0);
		await addMark(tess, "c_new", "First mark");
		await tess.engine.request();
		expect(server.caseOf("c_new")?.title).toBe("Your cart");
		expect(server.marksOf("c_new").map((m) => m.comment)).toEqual([
			"First mark",
		]);
		expect(server.caseOf("c_new")?.createdBy).toEqual(TESS);
	});

	test("images go before the operations that name them, and one the team has is not sent again", async () => {
		await signIn(tess);
		await startCase(tess, "c_new");
		await addMark(tess, "c_new", "First mark");
		await tess.engine.request();
		const calls = tess.api.calls.filter((c) => !c.startsWith("GET"));
		const firstPost = calls.findIndex((c) => c.startsWith("POST ops"));
		expect(
			calls.slice(0, firstPost).filter((c) => c.startsWith("PUT blob")),
		).toHaveLength(2);
		expect(calls.slice(firstPost).some((c) => c.startsWith("PUT blob"))).toBe(
			false,
		);
		expect(server.blobs.size).toBe(2);
		// Dana fetches them; a second mark of Tess's uploads only its own two.
		await signIn(dana);
		expect(dana.api.calls.filter((c) => c.startsWith("GET blob"))).toHaveLength(
			2,
		);
		expect(dana.api.calls.some((c) => c.startsWith("PUT blob"))).toBe(false);
		tess.api.calls.length = 0;
		await addMark(tess, "c_new", "Second mark");
		await tess.engine.request();
		expect(tess.api.calls.filter((c) => c.startsWith("PUT blob"))).toHaveLength(
			2,
		);
	});
});

describe("two devices and one team", () => {
	test("a case made on one is on the other, with its pages, marks and images", async () => {
		await shared();
		const there = await dana.store.getCase("c_flow");
		expect(look(there)).toEqual(look(await tess.store.getCase("c_flow")));
		expect(look(there)).toMatchObject({
			title: "Your cart",
			pages: [CART, PAY],
			marks: [
				{ number: 1, id: "a1", comment: "Total is cut off", page: CART },
				{ number: 2, id: "a2", comment: "Pay button too pale", page: PAY },
			],
		});
		expect(await images(dana, "c_flow")).toEqual(await images(tess, "c_flow"));
		expect(Object.values(await images(dana, "c_flow"))).not.toContain(
			"MISSING",
		);
		expect(there?.annotations[0]?.element?.selector).toBe("form > button");
		// The case's first page, and who made the marks.
		expect(there?.page.url).toBe(CART);
		expect(there?.annotations[0]?.createdBy).toEqual(TESS);
		expect(status(dana)?.state).toBe("synced");
		expect(dana.changed).toContain("c_flow");
	});

	test("a case that came from the server is no import, and its findings keep whose they are", async () => {
		await shared();
		const app = {
			id: "https://claude.ai/oauth",
			name: "Claude",
			host: "claude.ai",
		};
		await change(tess, "c_flow", (c, now) =>
			withFinding(
				c,
				"a1",
				{ id: "f_1", text: "The total wraps", app, at: now },
				now,
			),
		);
		await sync(tess, dana);
		const there = (await dana.store.getCase("c_flow")) as Case;
		expect(there.importedAt).toBeUndefined();
		const finding = there.annotations[0]?.findings?.[0];
		expect(finding?.imported).toBeUndefined();
		expect(finding?.text).toBe("The total wraps");
		// Written for Tess: Tess's app's own on her device, nobody's on Dana's.
		expect(finding?.user).toEqual(TESS);
		expect(finding && isOwnFinding(finding, app.id, TESS.id)).toBe(true);
		expect(finding && isOwnFinding(finding, app.id, DANA.id)).toBe(false);
		expect(finding && isOwnFinding(finding, app.id, undefined)).toBe(false);
		const mine = (await tess.store.getCase("c_flow"))?.annotations[0]
			?.findings?.[0];
		expect(mine?.user).toEqual(TESS);
		// A finding that never left this device is its app's, as before.
		expect(
			isOwnFinding({ id: "f", text: "x", app, at: "now" }, app.id, undefined),
		).toBe(true);
	});

	test("what each changes reaches the other, with who did it", async () => {
		await shared();
		await change(dana, "c_flow", (c, now) =>
			withChoice(c, "a1", "fixed", "Widened the column", now),
		);
		await change(tess, "c_flow", (c, now) =>
			withLink(
				withTitle(c, "Checkout flow", now),
				"https://tickets.example/7",
				now,
			),
		);
		await sync(tess, dana);
		for (const d of [tess, dana])
			expect(look(await d.store.getCase("c_flow"))).toMatchObject({
				title: "Checkout flow",
				link: "https://tickets.example/7",
				marks: [
					{ status: "fixed", note: "Widened the column", by: "Dana Developer" },
					{ status: "open" },
				],
			});
		// The tester verifies: that is hers.
		await change(tess, "c_flow", (c, now) =>
			withVerified(c, "a1", undefined, now),
		);
		await sync(tess, dana);
		const there = (await dana.store.getCase("c_flow")) as Case;
		expect(there.annotations[0]?.resolution?.user).toEqual(DANA);
		expect(there.annotations[0]?.resolution?.verified?.user).toEqual(TESS);
	});

	test("two changes to different things of one mark both stay; the same thing: the later one", async () => {
		await shared();
		await change(tess, "c_flow", (c, now) =>
			withComment(c, "a1", "Total is cut off on small windows", now),
		);
		await change(dana, "c_flow", (c, now) =>
			withChoice(c, "a1", "wontfix", "", now),
		);
		await sync(tess, dana);
		for (const d of [tess, dana])
			expect(look(await d.store.getCase("c_flow"))?.marks[0]).toMatchObject({
				comment: "Total is cut off on small windows",
				status: "wontfix",
			});
		// Both change the comment: who sends later wins, on both.
		await change(tess, "c_flow", (c, now) =>
			withComment(c, "a2", "Tess's words", now),
		);
		await change(dana, "c_flow", (c, now) =>
			withComment(c, "a2", "Dana's words", now),
		);
		await tess.engine.request();
		await dana.engine.request();
		await sync(tess, dana);
		for (const d of [tess, dana])
			expect(look(await d.store.getCase("c_flow"))?.marks[1]?.comment).toBe(
				"Dana's words",
			);
	});

	test("nothing is sent twice: a run with nothing new asks only for the changes", async () => {
		await shared();
		tess.api.calls.length = 0;
		dana.api.calls.length = 0;
		await sync(tess, dana);
		expect(tess.api.calls.every((c) => c.startsWith("GET changes"))).toBe(true);
		expect(dana.api.calls.every((c) => c.startsWith("GET changes"))).toBe(true);
		// And the cases were not written again: nothing changed here.
		const before = tess.changed.length;
		await tess.engine.request();
		expect(tess.changed).toHaveLength(before);
	});
});

describe("changes that wait", () => {
	test("offline: every change is kept, said so, and sent when the server is back", async () => {
		await shared();
		tess.api.offline = true;
		await change(tess, "c_flow", (c, now) =>
			withComment(c, "a1", "Edited offline", now),
		);
		await addMark(tess, "c_flow", "Added offline");
		await tess.engine.request();
		expect(status(tess)?.state).toBe("offline");
		expect(status(tess)?.text).toContain("kept and sent");
		expect(look(await tess.store.getCase("c_flow"))?.marks).toHaveLength(3);
		expect(server.marksOf("c_flow")).toHaveLength(2);
		tess.api.offline = false;
		await sync(tess, dana);
		expect(status(tess)?.state).toBe("synced");
		expect(
			look(await dana.store.getCase("c_flow"))?.marks.map((m) => m.comment),
		).toEqual(["Edited offline", "Pay button too pale", "Added offline"]);
	});

	test("a change made while the server was away survives what the team did meanwhile", async () => {
		await shared();
		tess.api.offline = true;
		await change(tess, "c_flow", (c, now) =>
			withComment(c, "a1", "Tess, offline", now),
		);
		await tess.engine.request();
		// Meanwhile Dana settles that mark and edits the other.
		await change(dana, "c_flow", (c, now) =>
			withComment(
				withChoice(c, "a1", "fixed", "Done", now),
				"a2",
				"Dana's edit",
				now,
			),
		);
		await dana.engine.request();
		tess.api.offline = false;
		await tess.engine.request();
		expect(look(await tess.store.getCase("c_flow"))?.marks).toMatchObject([
			{ comment: "Tess, offline", status: "fixed", note: "Done" },
			{ comment: "Dana's edit" },
		]);
		await dana.engine.request();
		expect(look(await dana.store.getCase("c_flow"))).toEqual(
			look(await tess.store.getCase("c_flow")),
		);
	});

	test("a change made while the team's changes are fetched is not overwritten, and goes next", async () => {
		await shared();
		await change(dana, "c_flow", (c, now) =>
			withComment(c, "a1", "Dana's words", now),
		);
		await dana.engine.request();
		// Tess types while her device fetches.
		const changes = tess.api.changes.bind(tess.api);
		tess.api.changes = async (team, since) => {
			const answer = await changes(team, since);
			tess.api.changes = changes;
			await change(tess, "c_flow", (c, now) =>
				withChoice(
					withComment(c, "a1", "Tess, just now", now),
					"a2",
					"fixed",
					"",
					now,
				),
			);
			return answer;
		};
		await tess.engine.request();
		expect(look(await tess.store.getCase("c_flow"))?.marks).toMatchObject([
			{ comment: "Tess, just now" },
			{ status: "fixed" },
		]);
		await sync(tess, dana);
		expect(look(await dana.store.getCase("c_flow"))?.marks).toMatchObject([
			{ comment: "Tess, just now" },
			{ status: "fixed" },
		]);
	});

	test("a reply that never came: the same operations go again, and the server applies them once", async () => {
		await signIn(tess);
		await startCase(tess, "c_lost");
		await addMark(tess, "c_lost", "One");
		await addMark(tess, "c_lost", "Two");
		// The new case goes alone, and its answer is lost.
		tess.api.loseReplies = 1;
		await tess.engine.request();
		expect(status(tess)?.state).toBe("offline");
		expect(server.cases.has("c_lost")).toBe(true);
		const first = (tess.kv.data.get(KEYS.queue) as Queue).ops.map(
			(op) => op.opId,
		);
		expect(first).toHaveLength(1);
		// Then its screenshots and marks, whose answer is lost too.
		tess.api.loseReplies = 0;
		const ops = tess.api.ops.bind(tess.api);
		let requests = 0;
		tess.api.ops = async (team, list) => {
			if (++requests === 2) tess.api.loseReplies = 1;
			return ops(team, list);
		};
		await tess.engine.request();
		tess.api.ops = ops;
		expect(status(tess)?.state).toBe("offline");
		// Applied at the server, not known here: written down, to go again.
		expect(server.marksOf("c_lost")).toHaveLength(2);
		const queue = tess.kv.data.get(KEYS.queue) as Queue;
		const ids = [...first, ...queue.ops.map((op) => op.opId)];
		expect(ids.length).toBeGreaterThan(3);
		tess.api.calls.length = 0;
		await tess.engine.request();
		expect(status(tess)?.state).toBe("synced");
		expect(tess.kv.data.get(KEYS.queue)).toBeUndefined();
		expect(server.marksOf("c_lost").map((m) => m.comment)).toEqual([
			"One",
			"Two",
		]);
		expect([...server.applied.keys()].sort()).toEqual([...ids].sort());
		// Not derived a second time under new ids.
		expect(posts(tess)).toHaveLength(1);
		tess.api.calls.length = 0;
		await tess.engine.request();
		expect(posts(tess)).toEqual([]);
	});
});

describe("mark numbers", () => {
	test("two add a mark at once: the later one takes the server's number, id and crop path with it", async () => {
		await shared();
		const mine = await addMark(tess, "c_flow", "Tess's third");
		const theirs = await addMark(dana, "c_flow", "Dana's third");
		expect([mine.id, theirs.id]).toEqual(["a3", "a3"]);
		const danaCrop = await (
			await dana.store.getImage("c_flow", "crops/a3.webp")
		)?.blob.text();
		await tess.engine.request();
		await dana.engine.request();
		// Dana's mark is 4 now, everywhere it is named.
		const there = (await dana.store.getCase("c_flow")) as Case;
		expect(
			there.annotations.map((a) => [a.id, a.number, a.crop, a.comment]),
		).toEqual([
			["a1", 1, "crops/a1.webp", "Total is cut off"],
			["a2", 2, "crops/a2.webp", "Pay button too pale"],
			["a3", 3, "crops/a3.webp", "Tess's third"],
			["a4", 4, "crops/a4.webp", "Dana's third"],
		]);
		expect(
			await (await dana.store.getImage("c_flow", "crops/a4.webp"))?.blob.text(),
		).toBe(danaCrop);
		expect(there.lastNumber).toBe(4);
		expect(keys(dana, "c_flow").filter((k) => k.includes("/crops/"))).toEqual([
			"c_flow/crops/a1.webp",
			"c_flow/crops/a2.webp",
			"c_flow/crops/a3.webp",
			"c_flow/crops/a4.webp",
		]);
		expect(book(dana, "c_flow")?.marks["a4"]).toBe(
			server.marksOf("c_flow")[3]?.id as string,
		);
		await sync(tess, dana);
		expect(look(await tess.store.getCase("c_flow"))).toEqual(look(there));
		expect(await images(tess, "c_flow")).toEqual(await images(dana, "c_flow"));
		expect(server.marksOf("c_flow").map((m) => m.number)).toEqual([1, 2, 3, 4]);
	});

	test("a mark that came from the team takes its number; a mark here that holds it, not sent yet, moves", async () => {
		await shared();
		await addMark(tess, "c_flow", "Tess's third");
		await tess.engine.request();
		// Dana's own third cannot go (her role may not add marks): it stays here.
		dana.api.permissions = dana.api.permissions.filter(
			(p) => p !== "mark:create",
		);
		await dana.engine.retry();
		await addMark(dana, "c_flow", "Dana's, not sent");
		await dana.engine.request();
		const there = (await dana.store.getCase("c_flow")) as Case;
		expect(there.annotations.map((a) => [a.id, a.comment])).toEqual([
			["a1", "Total is cut off"],
			["a2", "Pay button too pale"],
			["a3", "Tess's third"],
			["a4", "Dana's, not sent"],
		]);
		expect(status(dana)?.problems[0]?.text).toContain("does not allow");
		// Allowed again: it goes, as 4.
		dana.api.permissions.push("mark:create");
		await dana.engine.retry();
		await sync(tess, dana);
		expect(
			look(await tess.store.getCase("c_flow"))?.marks.map((m) => m.comment),
		).toEqual([
			"Total is cut off",
			"Pay button too pale",
			"Tess's third",
			"Dana's, not sent",
		]);
	});

	test("a number the team has used is not given again here after an Undo", async () => {
		await shared();
		await addMark(tess, "c_flow", "Third");
		await sync(tess, dana);
		// Tess takes it out again (the panel's delete keeps the number; so does this).
		await change(tess, "c_flow", (c, now) => withoutAnnotation(c, "a3", now));
		await sync(tess, dana);
		const next = await addMark(dana, "c_flow", "Dana's next");
		expect(next.number).toBe(4);
		await sync(tess, dana);
		expect(server.marksOf("c_flow").map((m) => m.number)).toEqual([1, 2, 4]);
	});
});

describe("a case the team already has (review B, sync 2 and 3)", () => {
	/** Dana gets Tess's case as a file: the same id, the same marks, the same images. */
	async function fromFile(id: string): Promise<void> {
		const copy = (await tess.store.getCase(id)) as Case;
		const files = new Map<string, StoredImage>();
		for (const path of [
			...copy.shots.map((s) => s.image),
			...copy.annotations.map((a) => a.crop),
		]) {
			const image = await tess.store.getImage(id, path);
			if (image !== undefined) files.set(path, image);
		}
		await dana.store.replaceCase(structuredClone(copy), files);
	}
	const numbered = (id: string) =>
		server.marksOf(id).map((m) => [m.number, m.comment]);
	async function tessShares(): Promise<void> {
		await signIn(tess);
		await startCase(tess, "c_file");
		await addMark(tess, "c_file", "One", { element: true });
		await addMark(tess, "c_file", "Two");
		await tess.engine.request();
	}

	test("imported on a synced device before it fetched: the fetch comes first, the marks are the same marks, none is made twice", async () => {
		await signIn(dana);
		await tessShares();
		await fromFile("c_file");
		await sync(dana, tess);
		expect(numbered("c_file")).toEqual([
			[1, "One"],
			[2, "Two"],
		]);
		expect(look(await dana.store.getCase("c_file"))).toEqual(
			look(await tess.store.getCase("c_file")),
		);
		expect(status(dana)?.state).toBe("synced");
	});

	test("the fetch did not bring it (it was read before): the case goes alone, the server says it has it, nothing else is sent, and the two are joined", async () => {
		await signIn(dana);
		await tessShares();
		// Dana's device has read past the case, and does not have it (it was
		// deleted here unsent, say; here: the book is simply gone).
		await dana.engine.request();
		await dana.store.deleteCase("c_file");
		await dana.kv.remove("case:c_file");
		await fromFile("c_file");
		// Her own words on mark 2, and a mark only she has.
		await change(dana, "c_file", (c, now) =>
			withComment(c, "a2", "Dana's words", now),
		);
		await addMark(dana, "c_file", "Only Dana's", { url: PAY });
		const sent: Op[] = [];
		const ops = dana.api.ops.bind(dana.api);
		dana.api.ops = async (team, list) => {
			sent.push(...list);
			return ops(team, list);
		};
		dana.api.calls.length = 0;
		await dana.engine.request();
		// The case alone; then a read of the case; then only what the team lacks.
		expect(sent[0]?.type).toBe("case.create");
		expect(dana.api.calls).toContain("GET case c_file");
		expect(
			sent.filter((op) => op.type === "mark.create").map((op) => op.type),
		).toHaveLength(1);
		await sync(dana, tess);
		// The team's two marks once, the team's words where both had some, and
		// Dana's own mark as a new one.
		expect(numbered("c_file")).toEqual([
			[1, "One"],
			[2, "Two"],
			[3, "Only Dana's"],
		]);
		expect(look(await dana.store.getCase("c_file"))).toEqual(
			look(await tess.store.getCase("c_file")),
		);
		expect(status(dana)?.state).toBe("synced");
	});

	test("not asked about yet, and the first fetch fails: “Sync them” sends nothing twice", async () => {
		await tessShares();
		await fromFile("c_file");
		const changes = dana.api.changes.bind(dana.api);
		dana.api.changes = async () => {
			throw new ApiFailure("offline", "gone");
		};
		await signIn(dana);
		expect(status(dana)?.state).toBe("offline");
		expect(status(dana)?.undecided).toBe(1);
		dana.api.changes = changes;
		await dana.engine.decide(true);
		await sync(dana, tess);
		expect(numbered("c_file")).toEqual([
			[1, "One"],
			[2, "Two"],
		]);
	});

	test("kept back, with other words on a mark the team has too: the question says how many marks the team's text replaces, and sharing does that and nothing else", async () => {
		await tessShares();
		await fromFile("c_file");
		await change(dana, "c_file", (c, now) =>
			withComment(c, "a1", "Dana's newer words", now),
		);
		await addMark(dana, "c_file", "Dana's own third");
		await signIn(dana);
		// Before any answer: nothing taken, nothing sent, and the banner's
		// question can say what "Sync them" would replace.
		expect(tess.kv.data.get(KEYS.modes)).toEqual({ c_file: "synced" });
		expect(dana.kv.data.get(KEYS.modes)).toEqual({ c_file: "undecided" });
		expect(status(dana)?.joins).toEqual({ cases: 1, marks: 1 });
		expect(
			(await dana.store.getCase("c_file"))?.annotations.map((a) => a.comment),
		).toEqual(["Dana's newer words", "Two", "Dana's own third"]);
		expect(numbered("c_file")).toHaveLength(2);
		// "Keep them on this device": still nothing, and it stays said.
		await dana.engine.decide(false);
		await dana.engine.request();
		expect(numbered("c_file")).toHaveLength(2);
		expect(status(dana)?.joins).toBeUndefined();
		expect(status(dana)?.problems.map((p) => p.text)).toEqual([
			"“Your cart” is on this device only, and the team already has this case. Nothing of it was sent, and the team's was not taken. “Share with team” on the case joins the two: marks only here are sent, the team's other marks come here, and where both differ the team's text is kept: 1 mark.",
		]);
		// Shared, having been told: the team's text on mark 1, her mark sent.
		await dana.engine.share("c_file");
		await sync(dana, tess);
		expect(numbered("c_file")).toEqual([
			[1, "One"],
			[2, "Two"],
			[3, "Dana's own third"],
		]);
		expect(
			(await dana.store.getCase("c_file"))?.annotations.map((a) => a.comment),
		).toEqual(["One", "Two", "Dana's own third"]);
		expect(status(dana)?.problems).toEqual([]);
	});

	test("this device's own new case whose answer was lost, and the record of the request too: the server's empty case is found, and everything here is sent once", async () => {
		await signIn(tess);
		await signIn(dana);
		await startCase(tess, "c_mine");
		await addMark(tess, "c_mine", "One");
		tess.api.loseReplies = 1;
		await tess.engine.request();
		expect(server.cases.has("c_mine")).toBe(true);
		// The queue is lost with the answer (the browser's storage was reset
		// to before it, say): the same case is made under a new request.
		await tess.kv.remove(KEYS.queue);
		await sync(tess, dana);
		expect(numbered("c_mine")).toEqual([[1, "One"]]);
		expect(status(tess)?.state).toBe("synced");
		expect((await dana.store.getCase("c_mine"))?.annotations).toHaveLength(1);
	});
});

describe("the pages of a synced case are the server's (DEC-039)", () => {
	const LOCAL_PAY = "http://localhost:3000/checkout/pay/";

	test("a page is added by its first screenshot, with its title; no patch ever names the pages", async () => {
		const sent: Op[] = [];
		for (const d of [tess, dana]) {
			const ops = d.api.ops.bind(d.api);
			d.api.ops = async (team, list) => {
				sent.push(...list);
				return ops(team, list);
			};
		}
		await shared();
		expect(server.caseOf("c_flow")?.pages).toEqual([
			{ url: CART, title: "Your cart", lang: "en" },
			{ url: PAY, title: "Payment", lang: "en" },
		]);
		const there = (await dana.store.getCase("c_flow")) as Case;
		expect(there.pages).toEqual([
			{ url: CART, title: "Your cart", lang: "en" },
			{ url: PAY, title: "Payment", lang: "en" },
		]);
		// The same page on localhost is no second page, here or there.
		await addMark(dana, "c_flow", "On my machine too", {
			url: LOCAL_PAY,
			title: "Payment (dev)",
		});
		// A third page, then its mark goes again: the page comes and leaves.
		const done = await addMark(dana, "c_flow", "Thanks page", {
			url: "https://shop.example/done",
			title: "Thank you",
		});
		await sync(dana, tess);
		expect(server.caseOf("c_flow")?.pages.map((p) => p.url)).toEqual([
			CART,
			PAY,
			"https://shop.example/done",
		]);
		expect(look(await tess.store.getCase("c_flow"))?.pages).toEqual([
			CART,
			PAY,
			"https://shop.example/done",
		]);
		expect(
			(await tess.store.getCase("c_flow"))?.pages?.find(
				(p) => p.url === "https://shop.example/done",
			)?.title,
		).toBe("Thank you");
		await change(dana, "c_flow", (c, now) =>
			withoutAnnotation(c, done.id, now),
		);
		await sync(dana, tess);
		expect(server.caseOf("c_flow")?.pages.map((p) => p.url)).toEqual([
			CART,
			PAY,
		]);
		expect(look(await tess.store.getCase("c_flow"))?.pages).toEqual([
			CART,
			PAY,
		]);
		// All of that without one patch of the list, and no list in a new case.
		expect(sent.length).toBeGreaterThan(5);
		for (const op of sent) {
			if (op.type === "case.patch") expect(op.pages).toBeUndefined();
			if (op.type === "case.create") expect(op.case.pages).toBeUndefined();
		}
		expect(look(await dana.store.getCase("c_flow"))).toEqual(
			look(await tess.store.getCase("c_flow")),
		);
	});

	test("page is the first page of the server's list, with the window of that page's first screenshot", async () => {
		await shared();
		const mine = (await tess.store.getCase("c_flow")) as Case;
		const pay = mine.shots.find((s) => s.url === PAY);
		expect(mine.page.url).toBe(CART);
		// Someone changes the list at the server (the web app): the payment
		// page is first now.
		const pages = [...(server.caseOf("c_flow")?.pages ?? [])].reverse();
		server
			.api(DANA)
			.ops(TEAM, [
				{ opId: "o_pages", type: "case.patch", caseId: "c_flow", pages },
			]);
		await sync(tess, dana);
		for (const d of [tess, dana]) {
			const c = (await d.store.getCase("c_flow")) as Case;
			expect(c.pages?.map((p) => p.url)).toEqual([PAY, CART]);
			expect(c.page.url).toBe(PAY);
			expect(c.page.title).toBe("Payment");
			expect(c.page.viewport).toEqual(pay?.viewport as never);
			// Every mark is still on its own page.
			expect(look(c)?.marks.map((m) => m.page)).toEqual([CART, PAY]);
		}
		// Taking the list did not make anything to send.
		tess.api.calls.length = 0;
		await sync(tess, dana);
		expect(posts(tess)).toEqual([]);
	});
});

describe("deleting", () => {
	test("a mark deleted on one device goes on the other, its screenshot with its last mark", async () => {
		await shared();
		await change(tess, "c_flow", (c, now) => withoutAnnotation(c, "a2", now));
		await sync(tess, dana);
		const there = (await dana.store.getCase("c_flow")) as Case;
		expect(there.annotations.map((a) => a.id)).toEqual(["a1"]);
		expect(there.shots).toHaveLength(1);
		expect(keys(dana, "c_flow")).toHaveLength(2);
		expect(server.marksOf("c_flow")).toHaveLength(1);
		expect(server.shotsOf("c_flow")).toHaveLength(1);
		// The page that lost its last mark left the case, on both.
		expect(there.pages?.map((p) => p.url)).toEqual([CART]);
		expect(look(there)).toEqual(look(await tess.store.getCase("c_flow")));
	});

	test("a case deleted on one device is deleted for the team, and goes on the other", async () => {
		await shared();
		await tess.store.deleteCase("c_flow");
		await tess.engine.request();
		expect(server.caseOf("c_flow")).toBeUndefined();
		expect(book(tess, "c_flow")).toBeUndefined();
		dana.changed.length = 0;
		await dana.engine.request();
		expect(await dana.store.getCase("c_flow")).toBeUndefined();
		expect(keys(dana, "c_flow")).toEqual([]);
		expect(dana.changed).toEqual(["c_flow"]);
		expect(book(dana, "c_flow")).toBeUndefined();
	});

	test("a change to a case the team deleted meanwhile is said, and the case goes", async () => {
		await shared();
		tess.api.offline = true;
		await change(tess, "c_flow", (c, now) =>
			withComment(c, "a1", "Too late", now),
		);
		await tess.engine.request();
		await dana.store.deleteCase("c_flow");
		await dana.engine.request();
		tess.api.offline = false;
		await tess.engine.request();
		expect(await tess.store.getCase("c_flow")).toBeUndefined();
		// Nothing left to say once it is gone.
		await tess.engine.request();
		expect(status(tess)?.state).toBe("synced");
	});

	test("a case the user may not delete for the team comes back", async () => {
		await shared();
		dana.api.permissions = dana.api.permissions.filter(
			(p) => p !== "case:delete",
		);
		await dana.engine.retry();
		await dana.store.deleteCase("c_flow");
		await dana.engine.request();
		expect(server.caseOf("c_flow")).toBeDefined();
		expect(look(await dana.store.getCase("c_flow"))).toEqual(
			look(await tess.store.getCase("c_flow")),
		);
		expect(await images(dana, "c_flow")).toEqual(await images(tess, "c_flow"));
	});
});

describe("what the server does not take", () => {
	test("a refusal is said in plain words and not tried for ever; Sync now tries again", async () => {
		await shared();
		server.refuseWith = {
			type: "mark.patch",
			code: "limit",
			message: "A mark holds at most 20 findings.",
		};
		await change(tess, "c_flow", (c, now) =>
			withComment(c, "a1", "Refused", now),
		);
		await tess.engine.request();
		expect(status(tess)?.state).toBe("problem");
		expect(status(tess)?.problems).toEqual([
			{
				caseId: "c_flow",
				title: "Your cart",
				text: "A change to a mark was not taken: A mark holds at most 20 findings.",
			},
		]);
		// The change stays here, and is not sent again as it is.
		expect(look(await tess.store.getCase("c_flow"))?.marks[0]?.comment).toBe(
			"Refused",
		);
		tess.api.calls.length = 0;
		await tess.engine.request();
		await tess.engine.request();
		expect(posts(tess)).toEqual([]);
		expect(status(tess)?.problems).toHaveLength(1);
		// Other changes of the case still go.
		await change(tess, "c_flow", (c, now) => withTitle(c, "Renamed", now));
		await tess.engine.request();
		expect(server.caseOf("c_flow")?.title).toBe("Renamed");
		// The server takes it now: "Sync now" sends it again.
		server.refuseWith = undefined;
		await tess.engine.retry();
		expect(server.marksOf("c_flow")[0]?.comment).toBe("Refused");
		expect(status(tess)?.state).toBe("synced");
		expect(status(tess)?.problems).toEqual([]);
	});

	test("an error code this build does not know is a refusal like any other, in the server's words", async () => {
		await shared();
		server.refuseWith = {
			type: "mark.patch",
			code: "frozen",
			message: "The case is frozen for a release.",
		};
		await change(tess, "c_flow", (c, now) => withComment(c, "a1", "Edit", now));
		await tess.engine.request();
		expect(status(tess)?.problems[0]?.text).toBe(
			"A change to a mark was not taken: The case is frozen for a release.",
		);
	});

	test("what the user's role does not allow is not sent, and said", async () => {
		await shared();
		dana.api.permissions = dana.api.permissions.filter(
			(p) => p !== "mark:update",
		);
		await dana.engine.retry();
		dana.api.calls.length = 0;
		await change(dana, "c_flow", (c, now) =>
			withComment(c, "a1", "Not mine to edit", now),
		);
		await dana.engine.request();
		expect(posts(dana)).toEqual([]);
		expect(status(dana)?.state).toBe("problem");
		expect(status(dana)?.problems[0]?.text).toBe(
			"Your role in “Pedal & Pine web” does not allow a change you made here; it stays on this device.",
		);
		expect(server.marksOf("c_flow")[0]?.comment).toBe("Total is cut off");
	});

	test("an image that did not reach the server is sent again with its operation", async () => {
		await signIn(tess);
		await startCase(tess, "c_blob");
		await addMark(tess, "c_blob", "One");
		// The server says it has the images, and has not.
		const has = tess.api.hasBlob.bind(tess.api);
		tess.api.hasBlob = async () => true;
		await tess.engine.request();
		tess.api.hasBlob = has;
		expect(server.marksOf("c_blob").map((m) => m.comment)).toEqual(["One"]);
		expect(server.blobs.size).toBe(2);
		expect(status(tess)?.state).toBe("synced");
	});
});

describe("an image from the server is taken only when it is the image named (review B, 2)", () => {
	const TEXT =
		"A mark of the team is not shown here: an image the server sent is not the image named (missing, not a WebP image, too large, or other content).";

	for (const [what, answer] of [
		[
			"other content under the name asked for (a redirect's target, say)",
			async () => new Blob(["ROUTER ADMIN PAGE"], { type: "image/webp" }),
		],
		[
			"the right bytes, said to be something else than a WebP image",
			async (right: Blob) =>
				new Blob([await right.arrayBuffer()], { type: "text/html" }),
		],
		[
			"an image the server does not have",
			async () => {
				throw new ApiFailure("refused", "No such image.", 404, "not_found");
			},
		],
		[
			"an answer larger than an image may be",
			async () => {
				throw new ApiFailure("server", "Too large.", 200, TOO_LARGE);
			},
		],
	] as const)
		test(`${what}: not stored, said, and the rest of the run goes on`, async () => {
			await shared();
			await addMark(tess, "c_flow", "Its crop goes wrong on the way");
			await startCase(tess, "c_next");
			await addMark(tess, "c_next", "A case after it");
			await tess.engine.request();
			const bad = server
				.marksOf("c_flow")
				.find((m) => m.comment === "Its crop goes wrong on the way");
			const sha = bad?.crop.sha256 as string;
			const get = dana.api.getBlob.bind(dana.api);
			dana.api.getBlob = async (team, asked) =>
				asked === sha ? answer(await get(team, asked)) : get(team, asked);
			await dana.engine.request();
			// The mark with the bad image is not here; everything else is.
			const there = (await dana.store.getCase("c_flow")) as Case;
			expect(there.annotations.map((a) => a.comment)).toEqual([
				"Total is cut off",
				"Pay button too pale",
			]);
			expect(Object.values(await images(dana, "c_flow"))).not.toContain(
				"MISSING",
			);
			expect(
				(await dana.store.getCase("c_next"))?.annotations.map((a) => a.comment),
			).toEqual(["A case after it"]);
			expect(status(dana)?.state).toBe("problem");
			expect(status(dana)?.problems).toEqual([
				{ caseId: "c_flow", title: "Your cart", text: TEXT },
			]);
			// Nothing of it went back to the server, and nothing was deleted there.
			expect(server.marksOf("c_flow")).toHaveLength(3);
			// The image is right again: "Sync now" reads the team's state anew.
			dana.api.getBlob = get;
			await dana.engine.retry();
			expect(look(await dana.store.getCase("c_flow"))).toEqual(
				look(await tess.store.getCase("c_flow")),
			);
			expect(status(dana)?.state).toBe("synced");
		});

	test("a bad screenshot leaves out the marks on it, and only those", async () => {
		await shared();
		await addMark(tess, "c_flow", "On a new screenshot", {
			url: "https://shop.example/done",
		});
		await tess.engine.request();
		const shot = server
			.shotsOf("c_flow")
			.find((s) => s.url === "https://shop.example/done");
		const get = dana.api.getBlob.bind(dana.api);
		dana.api.getBlob = async (team, asked) =>
			asked === shot?.image.sha256
				? new Blob(["<html>"], { type: "text/html" })
				: get(team, asked);
		await dana.engine.request();
		const there = (await dana.store.getCase("c_flow")) as Case;
		expect(there.annotations).toHaveLength(2);
		expect(there.shots).toHaveLength(2);
		expect(status(dana)?.problems.map((p) => p.text)).toEqual([TEXT]);
	});
});

describe("an answer larger than an answer may be (review B, 11)", () => {
	test("a page of changes too large to read is asked for again in small pages, and all of it arrives", async () => {
		await signIn(tess);
		await signIn(dana);
		await startCase(tess, "c_big");
		// One request each: the server never splits what one request changed.
		for (let i = 1; i <= 45; i++) {
			await addMark(tess, "c_big", `Mark ${i}`);
			await tess.engine.request();
		}
		// Dana's client refuses any answer of more than 30 things as too large.
		const changes = dana.api.changes.bind(dana.api);
		const asked: (number | undefined)[] = [];
		dana.api.changes = async (team, since, limit) => {
			asked.push(limit);
			const answer = await changes(team, since, limit);
			const things =
				(answer.cases?.length ?? 0) +
				(answer.shots?.length ?? 0) +
				(answer.marks?.length ?? 0);
			if (things > 30)
				throw new ApiFailure("server", "Too large.", 200, TOO_LARGE);
			return answer;
		};
		await dana.engine.request();
		expect(asked[0]).toBeUndefined();
		expect(asked.slice(1).every((limit) => limit === SMALL_PAGE)).toBe(true);
		expect(asked.length).toBeGreaterThan(3);
		expect((await dana.store.getCase("c_big"))?.annotations).toHaveLength(45);
		expect(status(dana)?.state).toBe("synced");
	});

	test("a small page that is still too large is the server's trouble: said, nothing stored, tried again later", async () => {
		await signIn(dana);
		dana.api.changes = async () => {
			throw new ApiFailure(
				"server",
				"The server's answer is larger than an answer may be.",
				200,
				TOO_LARGE,
			);
		};
		await dana.engine.request();
		expect(status(dana)?.state).toBe("problem");
		expect(status(dana)?.text).toContain("larger than an answer may be");
	});
});

describe("the team's storage", () => {
	test("full: the image is not taken, its mark not shared, said in plain words, and not uploaded again at every run", async () => {
		await signIn(tess);
		await startCase(tess, "c_full");
		await addMark(tess, "c_full", "Fits");
		await tess.engine.request();
		const put = tess.api.putBlob.bind(tess.api);
		tess.api.putBlob = async () => {
			tess.api.calls.push("PUT blob (refused)");
			throw new ApiFailure(
				"refused",
				"The team's storage is full.",
				507,
				"quota",
			);
		};
		await addMark(tess, "c_full", "Does not fit");
		await tess.engine.request();
		expect(status(tess)?.state).toBe("problem");
		expect(status(tess)?.problems).toEqual([
			{
				caseId: "c_full",
				title: "Your cart",
				text: "An image was not taken, so its mark is not shared: The team's storage is full. 1 more of its changes were not taken either.",
			},
		]);
		expect(server.marksOf("c_full").map((m) => m.comment)).toEqual(["Fits"]);
		// Not a server that is down: nothing is tried again by itself.
		tess.api.calls.length = 0;
		await tess.engine.request();
		await tess.engine.request();
		expect(tess.api.calls.filter((c) => c.startsWith("PUT"))).toEqual([]);
		// Room again, and "Sync now".
		tess.api.putBlob = put;
		await tess.engine.retry();
		expect(server.marksOf("c_full").map((m) => m.comment)).toEqual([
			"Fits",
			"Does not fit",
		]);
		expect(status(tess)?.state).toBe("synced");
	});
});

describe("a contract that has grown", () => {
	test("fields and kinds of removed things this build does not know are passed by", async () => {
		await shared();
		server.future = true;
		await change(dana, "c_flow", (c, now) =>
			withComment(c, "a1", "From the future", now),
		);
		await sync(dana, tess);
		expect(status(tess)?.state).toBe("synced");
		expect(look(await tess.store.getCase("c_flow"))?.marks[0]?.comment).toBe(
			"From the future",
		);
		// Nothing of it was stored in the case.
		expect(JSON.stringify(await tess.store.getCase("c_flow"))).not.toContain(
			"somethingNew",
		);
	});

	test("many changes come in pages, and all of them arrive", async () => {
		await signIn(tess);
		await startCase(tess, "c_many");
		// Each in a revision of its own: a page never splits one.
		for (let i = 1; i <= 7; i++) {
			await addMark(tess, "c_many", `Mark ${i}`);
			await tess.engine.request();
		}
		server.pageSize = 3;
		await signIn(dana);
		expect(
			dana.api.calls.filter((c) => c.startsWith("GET changes")).length,
		).toBeGreaterThan(2);
		expect(
			look(await dana.store.getCase("c_many"))?.marks.map((m) => m.comment),
		).toEqual([1, 2, 3, 4, 5, 6, 7].map((i) => `Mark ${i}`));
		expect(Object.values(await images(dana, "c_many"))).not.toContain(
			"MISSING",
		);
	});

	test("a server with another history (reset): its state is taken whole, and a case it lost is sent again", async () => {
		await shared();
		await startCase(tess, "c_second");
		await addMark(tess, "c_second", "Only Tess had this");
		await addMark(tess, "c_flow", "A third mark, after the copy");
		await tess.engine.request();
		await dana.engine.request();
		// The server is restored from a copy made before that case and that mark.
		server.cases.delete("c_second");
		for (const [id, m] of server.marks)
			if (m.value.caseId === "c_second" || m.value.number === 3)
				server.marks.delete(id);
		for (const [id, s] of server.shots)
			if (
				s.value.caseId === "c_second" ||
				!server.marksOf("c_flow").some((m) => m.shotId === id)
			)
				server.shots.delete(id);
		server.restore();
		const cursor = tess.kv.data.get(KEYS.cursor) as number;
		expect(cursor).toBeGreaterThan(server.seq);
		await tess.engine.request();
		await tess.engine.request();
		expect(tess.kv.data.get(KEYS.cursor)).toBe(server.seq);
		// The mark the server lost is not deleted here on its word: it is
		// still here, and the server has it again, under the id it had.
		expect(look(await tess.store.getCase("c_flow"))?.marks).toHaveLength(3);
		expect(server.marksOf("c_flow").map((m) => m.comment)).toEqual([
			"Total is cut off",
			"Pay button too pale",
			"A third mark, after the copy",
		]);
		expect(server.marksOf("c_flow")[2]?.id).toBe(
			book(tess, "c_flow")?.marks["a3"] as string,
		);
		// The one the server lost is still here, and is the team's again.
		expect(server.caseOf("c_second")?.title).toBe("Your cart");
		expect(server.marksOf("c_second").map((m) => m.comment)).toEqual([
			"Only Tess had this",
		]);
		expect(status(tess)?.state).toBe("synced");
	});
});

describe("signing out and in", () => {
	test("signing out stops the sync and keeps the cases, on this device only", async () => {
		await shared();
		await tess.engine.signOut();
		expect(await tess.engine.account()).toBeUndefined();
		expect(status(tess)?.state).toBe("off");
		expect(look(await tess.store.getCase("c_flow"))?.marks).toHaveLength(2);
		expect(tess.kv.data.get(KEYS.modes)).toEqual({ c_flow: "local" });
		tess.api.calls.length = 0;
		await change(tess, "c_flow", (c, now) =>
			withComment(c, "a1", "Signed out", now),
		);
		await tess.engine.request();
		expect(tess.api.calls).toEqual([]);
		expect(server.marksOf("c_flow")[0]?.comment).toBe("Total is cut off");
	});

	test("signing in again goes on where it was: nothing twice, and what changed meanwhile both ways", async () => {
		await shared();
		await tess.engine.signOut();
		await change(tess, "c_flow", (c, now) =>
			withComment(c, "a1", "While signed out", now),
		);
		await change(dana, "c_flow", (c, now) =>
			withChoice(c, "a2", "fixed", "", now),
		);
		await dana.engine.request();
		await signIn(tess);
		await sync(tess, dana);
		expect(status(tess)?.undecided).toBe(0);
		expect(server.marksOf("c_flow")).toHaveLength(2);
		expect(server.shotsOf("c_flow")).toHaveLength(2);
		for (const d of [tess, dana])
			expect(look(await d.store.getCase("c_flow"))?.marks).toMatchObject([
				{ comment: "While signed out", status: "open" },
				{ status: "fixed" },
			]);
	});

	test("a sign-in that ran out: said, nothing lost, and it goes on after signing in again", async () => {
		await shared();
		tess.api.unauthorized = true;
		await change(tess, "c_flow", (c, now) =>
			withComment(c, "a1", "While the token was out", now),
		);
		await tess.engine.request();
		expect(status(tess)?.state).toBe("signed-out");
		expect(((await tess.engine.account()) as Account).expired).toBe(true);
		// Not tried again until the user signs in.
		tess.api.calls.length = 0;
		await tess.engine.request();
		expect(tess.api.calls).toEqual([]);
		tess.api.unauthorized = false;
		await signIn(tess);
		expect(status(tess)?.state).toBe("synced");
		expect(status(tess)?.undecided).toBe(0);
		expect(server.marksOf("c_flow")[0]?.comment).toBe(
			"While the token was out",
		);
	});

	test("someone else signs in on the device: what the first synced stays, on this device only", async () => {
		await shared();
		const other = server.api({ id: "u_pat", name: "Pat Product" });
		tess.api = other;
		// The same engine, another person's connection.
		const pat = device("pat", other);
		for (const [key, value] of tess.kv.data) pat.kv.data.set(key, value);
		for (const [key, value] of tess.store.cases)
			pat.store.cases.set(key, value);
		await pat.engine.signedIn("https://sitegloss.test", await other.me());
		// The team's case is here already and the team has it: it goes on syncing.
		expect(status(pat)?.state).toBe("synced");
		expect(server.marksOf("c_flow")).toHaveLength(2);
	});

	test("no longer a member of the team: the sync stops, the cases stay", async () => {
		await shared();
		const me = tess.api.me.bind(tess.api);
		tess.api.me = async () => ({ ...(await me()), teams: [] });
		await tess.engine.retry();
		expect(status(tess)?.state).toBe("off");
		expect(status(tess)?.text).toContain("no longer a member");
		expect(look(await tess.store.getCase("c_flow"))?.marks).toHaveLength(2);
		expect(tess.kv.data.get(KEYS.modes)).toEqual({ c_flow: "local" });
	});
});

describe("the worker stopped in the middle", () => {
	test("operations written down and never sent go at the next run, as they were", async () => {
		await signIn(tess);
		await startCase(tess, "c_stop");
		await addMark(tess, "c_stop", "One");
		await tess.engine.request();
		await addMark(tess, "c_stop", "Two", { url: PAY });
		const before = new Set(server.applied.keys());
		// The run stops after writing the operations down: no request is made.
		const ops = tess.api.ops.bind(tess.api);
		tess.api.ops = async () => {
			throw new Error("the worker stopped");
		};
		await tess.engine.request();
		expect(status(tess)?.state).toBe("problem");
		const queue = tess.kv.data.get(KEYS.queue) as Queue;
		expect(queue.ops.map((op: Op) => op.type)).toEqual([
			"case.patch",
			"shot.create",
			"mark.create",
		]);
		tess.api.ops = ops;
		await tess.engine.request();
		expect(
			[...server.applied.keys()].filter((id) => !before.has(id)).sort(),
		).toEqual(queue.ops.map((op: Op) => op.opId).sort());
		expect(server.marksOf("c_stop")).toHaveLength(2);
		expect(tess.kv.data.get(KEYS.queue)).toBeUndefined();
	});

	test("a case stored and its book not: the marks are the server's still, none is made twice", async () => {
		await shared();
		await addMark(tess, "c_flow", "Third");
		await tess.engine.request();
		// Dana's device stores the case and stops before it writes its book.
		const put = dana.kv.set.bind(dana.kv);
		let stopped = false;
		dana.kv.set = async (entries) => {
			const b = entries["case:c_flow"] as CaseBook | undefined;
			// The book that would say the server has the new mark.
			if (b?.shadow && Object.keys(b.shadow.marks).length === 3 && !stopped) {
				stopped = true;
				throw new Error("the worker stopped");
			}
			return put(entries);
		};
		await dana.engine.request();
		expect(stopped).toBe(true);
		expect((await dana.store.getCase("c_flow"))?.annotations).toHaveLength(3);
		dana.kv.set = put;
		await sync(dana, tess);
		expect(server.marksOf("c_flow")).toHaveLength(3);
		expect(look(await dana.store.getCase("c_flow"))).toEqual(
			look(await tess.store.getCase("c_flow")),
		);
	});

	test("a new case stored and its book not: nothing of it is made twice at the server", async () => {
		await shared();
		await startCase(tess, "c_other");
		await addMark(tess, "c_other", "One");
		await addMark(tess, "c_other", "Two");
		await tess.engine.request();
		// Dana's device stores the new case and stops before the book that
		// says what the server has of it.
		const put = dana.kv.set.bind(dana.kv);
		let stopped = false;
		dana.kv.set = async (entries) => {
			const b = entries["case:c_other"] as CaseBook | undefined;
			if (b?.shadow !== undefined && !stopped) {
				stopped = true;
				throw new Error("the worker stopped");
			}
			return put(entries);
		};
		await dana.engine.request();
		expect(stopped).toBe(true);
		expect((await dana.store.getCase("c_other"))?.annotations).toHaveLength(2);
		dana.kv.set = put;
		await sync(dana, tess);
		expect(server.marksOf("c_other")).toHaveLength(2);
		expect(server.shotsOf("c_other")).toHaveLength(2);
		expect(look(await dana.store.getCase("c_other"))).toEqual(
			look(await tess.store.getCase("c_other")),
		);
		expect(status(dana)?.state).toBe("synced");
	});
});

describe("who is asked what", () => {
	test("a case without a mark is nothing to ask about; one never answered about is asked about again", async () => {
		await startCase(tess, "c_empty");
		await startCase(tess, "c_old");
		await addMark(tess, "c_old", "Was here before");
		await signIn(tess);
		expect(status(tess)?.undecided).toBe(1);
		// Signed out without an answer, and in again: the same question.
		await tess.engine.signOut();
		expect(tess.kv.data.get(KEYS.modes)).toEqual({});
		await signIn(tess);
		expect(status(tess)?.undecided).toBe(1);
		expect(server.cases.size).toBe(0);
		// The empty case gets its first mark now: made since, it is the team's.
		await addMark(tess, "c_empty", "First mark");
		await tess.engine.request();
		expect([...server.cases.keys()]).toEqual(["c_empty"]);
	});

	test("a case made while the sign-in had run out is the team's when it is back, without a question", async () => {
		await signIn(tess);
		tess.api.unauthorized = true;
		await tess.engine.retry();
		expect(status(tess)?.state).toBe("signed-out");
		await startCase(tess, "c_meanwhile");
		await addMark(tess, "c_meanwhile", "Made meanwhile");
		tess.api.unauthorized = false;
		await signIn(tess);
		expect(status(tess)?.undecided).toBe(0);
		expect(server.caseOf("c_meanwhile")).toBeDefined();
	});

	test("a team joined later: found at the next look, and chosen when it is the only one", async () => {
		const me = tess.api.me.bind(tess.api);
		tess.api.me = async () => ({ ...(await me()), teams: [] });
		await signIn(tess);
		expect(((await tess.engine.account()) as Account).teamId).toBeUndefined();
		expect(status(tess)?.state).toBe("off");
		tess.api.me = me;
		// "Sync now" asks again.
		await tess.engine.retry();
		expect(((await tess.engine.account()) as Account).teamId).toBe(TEAM);
		expect(status(tess)?.state).toBe("synced");
	});
});

describe("the engine and its team", () => {
	test("the team's id is what the engine talks to", async () => {
		await signIn(tess);
		expect(((await tess.engine.account()) as Account).teamId).toBe(TEAM);
	});
});
