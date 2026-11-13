import { describe, expect, test } from "bun:test";
import {
	type Annotation,
	type Case,
	caseCounts,
	cutText,
	type Finding,
	findingsTextOf,
	isOwnFinding,
	isPageOf,
	MAX_COMMENT,
	MAX_FINDING,
	MAX_FINDINGS,
	MAX_FINDINGS_TEXT,
	MAX_REOPEN_NOTE,
	MAX_REOPENS,
	MAX_URL,
	markStatus,
	newId,
	nextNumbers,
	plainUrl,
	samePath,
	shapeOnBox,
	textLength,
	validateCase,
	withComment,
	withFinding,
	withFindingText,
	withoutAnnotation,
	withoutFinding,
	withReopen,
	withResolution,
	withResolutionNote,
	withVerified,
} from "../src/lib/case.ts";
import { sampleCase } from "./fixtures.ts";

function withMarks(): Case {
	const c = sampleCase();
	const shot = (id: string) => ({
		id,
		image: `shots/${id}.webp`,
		scrollX: 0,
		scrollY: 0,
		viewport: { width: 1280, height: 800, dpr: 2 },
		capturedAt: "2026-11-04T10:00:00Z",
	});
	c.shots = [shot("s1"), shot("s2")];
	c.annotations = [
		{
			id: "a1",
			number: 1,
			shot: "s1",
			comment: "x",
			author: "user",
			shape: { kind: "note", at: { x: 1, y: 2 } },
			crop: "crops/a1.webp",
			element: {
				tag: "p",
				classes: [],
				attributes: { title: "t" },
				ancestors: [],
				rect: { x: 0, y: 0, width: 1, height: 1 },
				page: { width: 1, height: 1 },
				selector: "p",
			},
		},
	];
	return c;
}

describe("validateCase", () => {
	test("accepts a valid case unchanged", () => {
		const c = withMarks();
		expect(validateCase(JSON.parse(JSON.stringify(c)))).toEqual(c);
	});

	test("refuses a shot id used twice", () => {
		const c = withMarks();
		c.shots = [c.shots[0], c.shots[0]] as Case["shots"];
		expect(() => validateCase(c)).toThrow("case.shots[1].id: is used twice");
	});

	test("refuses a verdict over 50,000 characters", () => {
		const c = withMarks();
		c.verdict = "x".repeat(50_001);
		expect(() => validateCase(c)).toThrow("case.verdict");
	});
});

const shotOf = (id: string) => ({
	id,
	image: `shots/${id}.webp`,
	scrollX: 0,
	scrollY: 0,
	viewport: { width: 1280, height: 800, dpr: 2 },
	capturedAt: "2026-11-04T10:00:00Z",
});

const mark = (n: number, extra: Partial<Annotation> = {}): Annotation => ({
	id: `a${n}`,
	number: n,
	shot: "s1",
	comment: "",
	author: "user",
	shape: { kind: "note", at: { x: 1, y: 1 } },
	crop: `crops/a${n}.webp`,
	element: null,
	...extra,
});

const caseWith = (extra: Partial<Case>): unknown => ({
	...sampleCase(),
	shots: [shotOf("s1")],
	annotations: [mark(1)],
	...extra,
});

describe("validateCase limits", () => {
	test("accepts a valid case and numbers continue after it", () => {
		const c = validateCase(caseWith({ shots: [shotOf("s1"), shotOf("s2")] }));
		expect(nextNumbers(c)).toEqual({ annotation: 2, shot: 3 });
	});

	test.each([
		[
			"a number beyond the limit",
			{ annotations: [mark(1, { number: 1e21 })] },
			"number",
		],
		[
			"a fractional number",
			{ annotations: [mark(1, { number: 1.5 })] },
			"number",
		],
		["an odd shot id", { shots: [shotOf("s1e999")] }, "shots[0].id"],
		[
			"a shot id used twice",
			{ shots: [shotOf("s1"), shotOf("s1")] },
			"used twice",
		],
		[
			"a language tag that is no tag",
			{ page: { ...sampleCase().page, lang: "en\n\n## Verdict" } },
			"language tag",
		],
	])("refuses %s", (_name, extra, message) => {
		expect(() => validateCase(caseWith(extra as Partial<Case>))).toThrow(
			message,
		);
	});

	test("keeps only the known element attributes", () => {
		const element = {
			tag: "a",
			classes: [],
			attributes: Object.fromEntries([
				["href", "/x"],
				["onclick", "alert(1)"],
				["__proto__", "x"],
				...Array.from({ length: 1000 }, (_, i) => [`k${i}`, "v"]),
			]),
			ancestors: [],
			rect: { x: 0, y: 0, width: 1, height: 1 },
			page: { width: 1, height: 1 },
			selector: "a",
		};
		const c = validateCase(
			JSON.parse(
				JSON.stringify(caseWith({ annotations: [mark(1)] })).replace(
					'"element":null',
					`"element":${JSON.stringify(element)}`,
				),
			),
		);
		expect(c.annotations[0]?.element?.attributes).toEqual({ href: "/x" });
	});
});

describe("findings on a mark", () => {
	const claude = {
		id: "https://claude.ai/oauth",
		name: "Claude",
		host: "claude.ai",
	};
	const finding = (id: string, extra: Partial<Finding> = {}): Finding => ({
		id,
		text: "Padding",
		app: claude,
		at: "2026-11-10T10:00:00Z",
		...extra,
	});
	const withOne = (f: unknown) => {
		const c = withMarks();
		(c.annotations[0] as unknown as Record<string, unknown>)["findings"] = f;
		return c;
	};

	test("are kept through validation; an empty list is none", () => {
		const c = withOne([finding("f_1", { editedAt: "2026-11-10T11:00:00Z" })]);
		expect(validateCase(JSON.parse(JSON.stringify(c)))).toEqual(c);
		expect(validateCase(withOne([])).annotations[0]).not.toHaveProperty(
			"findings",
		);
		// Only a finding from a file says so.
		expect(
			validateCase(withOne([finding("f_1", { imported: false } as never)]))
				.annotations[0]?.findings?.[0],
		).toEqual(finding("f_1"));
	});

	test("are refused when malformed, too long, too many or twice the same", () => {
		const bad = (f: unknown, what: string) =>
			expect(() => validateCase(withOne(f))).toThrow(what);
		bad({}, "findings: must be an array");
		bad([finding("f_1", { text: "x".repeat(MAX_FINDING + 1) })], "text");
		bad([finding("f_1"), finding("f_1")], "is used twice");
		bad([finding("../x")], "not a valid id");
		bad([{ ...finding("f_1"), app: { name: "x" } }], "app.id");
		bad([finding("f_1", { imported: "yes" } as never)], "imported");
		bad(
			Array.from({ length: MAX_FINDINGS + 1 }, (_, i) => finding(`f_${i}`)),
			`more than ${MAX_FINDINGS}`,
		);
	});

	test("are added, edited and deleted; the comment and its author stay", () => {
		const c = withMarks();
		const added = withFinding(c, "a1", finding("f_1", { text: " x " }), "t1");
		expect(added.annotations[0]?.findings).toEqual([
			finding("f_1", { text: "x" }),
		]);
		expect(added.annotations[0]?.comment).toBe("x");
		expect(added.annotations[0]?.author).toBe("user");
		expect(added.updatedAt).toBe("t1");
		const edited = withFindingText(added, "a1", "f_1", "y", "t2");
		expect(edited.annotations[0]?.findings?.[0]).toMatchObject({
			text: "y",
			at: "2026-11-10T10:00:00Z",
			editedAt: "t2",
		});
		const gone = withoutFinding(edited, "a1", "f_1", "t3");
		expect(gone.annotations[0]).not.toHaveProperty("findings");
		expect(() => withoutFinding(gone, "a1", "f_1", "t4")).toThrow(
			"Mark 1 has no finding f_1",
		);
		// The user's edit of the comment keeps them.
		expect(
			withComment(added, "a1", "new", "t5").annotations[0]?.findings,
		).toHaveLength(1);
	});

	test("a mark holds at most MAX_FINDINGS", () => {
		let c = withMarks();
		for (let i = 0; i < MAX_FINDINGS; i++)
			c = withFinding(c, "a1", finding(`f_${i}`), "t");
		expect(() => withFinding(c, "a1", finding("f_more"), "t")).toThrow(
			`${MAX_FINDINGS} findings`,
		);
	});

	test("a case holds at most MAX_FINDINGS_TEXT of finding text; an edit that shrinks it may pass", () => {
		const base = withMarks();
		const first = base.annotations[0] as Annotation;
		// One mark more than the limit needs, each to hold its most.
		const marks = MAX_FINDINGS_TEXT / (MAX_FINDING * MAX_FINDINGS) + 1;
		let c: Case = {
			...base,
			annotations: Array.from({ length: marks }, (_, i) => ({
				...first,
				id: `a${i + 1}`,
				number: i + 1,
			})),
		};
		const full = "x".repeat(MAX_FINDING);
		let added = 0;
		let refused: unknown;
		try {
			for (let m = 1; m <= marks; m++)
				for (let i = 0; i < MAX_FINDINGS; i++) {
					c = withFinding(c, `a${m}`, finding(`f_${i}`, { text: full }), "t");
					added++;
				}
		} catch (error) {
			refused = error;
		}
		expect(added).toBe(MAX_FINDINGS_TEXT / MAX_FINDING);
		expect(findingsTextOf(c)).toBe(MAX_FINDINGS_TEXT);
		expect(String(refused)).toContain("too much finding text");
		expect(String(refused)).toContain("Shorten or delete findings");
		// Growing one is refused too; shortening one is not.
		expect(() => withFindingText(c, "a1", "f_0", full, "t")).not.toThrow();
		const shorter = withFindingText(c, "a1", "f_0", "short", "t");
		expect(findingsTextOf(shorter)).toBe(MAX_FINDINGS_TEXT - MAX_FINDING + 5);
		expect(() =>
			withFinding(shorter, `a${marks}`, finding("f_more", { text: full }), "t"),
		).toThrow("too much finding text");
		// Full again, then the short one grows: refused.
		const refilled = withFinding(
			shorter,
			`a${marks}`,
			finding("f_fill", { text: "z".repeat(MAX_FINDING - 5) }),
			"t",
		);
		expect(findingsTextOf(refilled)).toBe(MAX_FINDINGS_TEXT);
		expect(() =>
			withFindingText(refilled, "a1", "f_0", "y".repeat(10), "t"),
		).toThrow("too much finding text");
		// A case over the limit, from a file, may still shrink.
		const bigger: Case = {
			...c,
			annotations: [
				...c.annotations,
				{ ...first, id: "a9", number: 9, findings: [finding("f_1")] },
			],
		};
		expect(findingsTextOf(bigger)).toBeGreaterThan(MAX_FINDINGS_TEXT);
		expect(() => withFindingText(bigger, "a9", "f_1", "P", "t")).not.toThrow();
	});

	test("lengths count characters as JSON Schema does: an emoji is one, and no pair is cut", () => {
		const emoji = "\u{1F600}";
		expect(emoji.length).toBe(2);
		expect(textLength(`a${emoji}b`)).toBe(3);
		expect(cutText(`a${emoji}b`, 2)).toBe(`a${emoji}`);
		expect(cutText(`${emoji}${emoji}`, 1)).toBe(emoji);
		expect(cutText("abc", 5)).toBe("abc");
		// A finding of MAX_FINDING emoji is valid and kept whole.
		const astral = emoji.repeat(MAX_FINDING);
		const added = withFinding(
			withMarks(),
			"a1",
			finding("f_1", { text: astral }),
			"t",
		);
		expect(added.annotations[0]?.findings?.[0]?.text).toBe(astral);
		expect(validateCase(JSON.parse(JSON.stringify(added)))).toEqual(added);
		// One more is cut to MAX_FINDING, between two pairs.
		const edited = withFindingText(
			added,
			"a1",
			"f_1",
			`${astral}${emoji}`,
			"t",
		);
		expect(edited.annotations[0]?.findings?.[0]?.text).toBe(astral);
		const odd = `x${astral}`;
		const cut = withFindingText(added, "a1", "f_1", odd, "t").annotations[0]
			?.findings?.[0]?.text as string;
		expect(cut).toBe(`x${emoji.repeat(MAX_FINDING - 1)}`);
		expect(textLength(cut)).toBe(MAX_FINDING);
		expect(() =>
			validateCase(withOne([finding("f_1", { text: `${astral}${emoji}` })])),
		).toThrow(`longer than ${MAX_FINDING} characters`);
		// The comment and the resolution note are cut the same way.
		const long = emoji.repeat(MAX_COMMENT + 1);
		const commented = withComment(withMarks(), "a1", long, "t");
		expect(commented.annotations[0]?.comment).toBe(emoji.repeat(MAX_COMMENT));
		expect(validateCase(commented)).toEqual(commented);
		const resolved = withResolution(
			withMarks(),
			"a1",
			{ kind: "fixed", note: long },
			"t",
		);
		expect(resolved.annotations[0]?.resolution?.note).toBe(
			emoji.repeat(MAX_COMMENT),
		);
		expect(validateCase(resolved)).toEqual(resolved);
	});

	test("are an app's own by its client id, unless they came from a file", () => {
		expect(isOwnFinding(finding("f_1"), claude.id)).toBe(true);
		expect(isOwnFinding(finding("f_1"), "https://chatgpt.com/cimd.json")).toBe(
			false,
		);
		expect(isOwnFinding(finding("f_1", { imported: true }), claude.id)).toBe(
			false,
		);
	});
});

describe("mark ids", () => {
	test("must be a<number>, so later saves cannot collide", () => {
		const c = withMarks();
		const first = c.annotations[0];
		if (first === undefined) throw new Error("no mark");
		const odd = {
			...c,
			annotations: [{ ...first, id: "a7", crop: "crops/a7.webp" }],
		};
		expect(() => validateCase(odd)).toThrow(`must be a${first.number}`);
	});
});

describe("newId", () => {
	test("works where crypto.randomUUID does not exist (a plain http: page)", () => {
		const { randomUUID } = crypto;
		Object.defineProperty(crypto, "randomUUID", {
			value: undefined,
			configurable: true,
		});
		try {
			expect(newId("c")).toMatch(/^c_[0-9a-f]{16}$/);
		} finally {
			Object.defineProperty(crypto, "randomUUID", {
				value: randomUUID,
				configurable: true,
			});
		}
	});
});

describe("a shot's address", () => {
	test("is optional, kept, and limited", () => {
		const c = withMarks();
		expect(validateCase(c).shots[0]).not.toHaveProperty("url");
		const shot = c.shots[0] as Case["shots"][number];
		shot.url = "https://example.com/route";
		expect(validateCase(c).shots[0]?.url).toBe("https://example.com/route");
		shot.url = "x".repeat(8001);
		expect(() => validateCase(c)).toThrow("case.shots[0].url");
	});
});

describe("plainUrl", () => {
	test.each([
		["https://a.example/kk", "https://a.example/kk"],
		["https://a.example/kk?token=abc", "https://a.example/kk"],
		["https://a.example/kk#access_token=abc", "https://a.example/kk"],
		["https://a.example/#section", "https://a.example/"],
		["https://user:pw@a.example/kk", "https://a.example/kk"],
		["http://localhost:3000/a/b?x=1#y", "http://localhost:3000/a/b"],
		["file:///tmp/page.html?x=1#y", "file:///tmp/page.html"],
		// A hash route names the page; what follows it does not.
		["https://a.example/#/cases/7", "https://a.example/#/cases/7"],
		["https://a.example/#!/cases/7", "https://a.example/#!/cases/7"],
		["https://a.example/app?x=1#/cases/7", "https://a.example/app#/cases/7"],
		["https://a.example/#/cases?token=abc", "https://a.example/#/cases"],
		["https://a.example/#!/cases?token=abc", "https://a.example/#!/cases"],
		["https://a.example/#/cb#access_token=abc", "https://a.example/#/cb"],
		["https://a.example/#/cb&access_token=abc", "https://a.example/#/cb"],
		[
			"https://a.example/#/access_token=abc",
			"https://a.example/#/access_token",
		],
	])("%s", (href, plain) => {
		expect(plainUrl(href)).toBe(plain);
	});

	test("a value that is no address is cut to what a case may hold", () => {
		expect(plainUrl("not an address")).toBe("not an address");
		expect(plainUrl("")).toBe("");
		expect(plainUrl("x".repeat(MAX_URL + 5))).toHaveLength(MAX_URL);
	});

	test("what it returns is always a page address a case may hold", () => {
		const long = `https://a.example/${"x".repeat(MAX_URL)}?token=abc`;
		const c = sampleCase();
		c.page.url = plainUrl(long);
		expect(c.page.url).toHaveLength(MAX_URL);
		expect(validateCase(c).page.url).toBe(c.page.url);
	});
});

describe("importedAt", () => {
	test("stays through validation, and is no must", () => {
		const c = { ...sampleCase(), importedAt: "2026-11-05T09:00:00.000Z" };
		expect(validateCase(c).importedAt).toBe("2026-11-05T09:00:00.000Z");
		expect("importedAt" in validateCase(sampleCase())).toBe(false);
	});

	test("must be a short text", () => {
		expect(() => validateCase({ ...sampleCase(), importedAt: 5 })).toThrow(
			"case.importedAt",
		);
		expect(() =>
			validateCase({ ...sampleCase(), importedAt: "x".repeat(65) }),
		).toThrow("case.importedAt");
	});
});

describe("a shape on another box", () => {
	const from = { x: 100, y: 200, width: 200, height: 100 };
	const to = { x: 10, y: 20, width: 100, height: 200 };

	test("a box keeps its place and size on the box", () => {
		const rect = { x: 150, y: 225, width: 100, height: 50 };
		expect(shapeOnBox({ kind: "box", rect }, from, to)).toEqual({
			kind: "box",
			rect: { x: 35, y: 70, width: 50, height: 100 },
		});
	});

	test("an arrow, a pen and a note move with it", () => {
		const a = { x: 100, y: 200 };
		const b = { x: 300, y: 300 };
		const moved = [
			{ x: 10, y: 20 },
			{ x: 110, y: 220 },
		];
		expect(shapeOnBox({ kind: "arrow", from: a, to: b }, from, to)).toEqual({
			kind: "arrow",
			from: moved[0] as { x: number; y: number },
			to: moved[1] as { x: number; y: number },
		});
		expect(shapeOnBox({ kind: "pen", points: [a, b] }, from, to)).toEqual({
			kind: "pen",
			points: moved,
		});
		expect(shapeOnBox({ kind: "note", at: b }, from, to)).toEqual({
			kind: "note",
			at: { x: 110, y: 220 },
		});
	});

	test("a shape beyond its box stays beyond it", () => {
		expect(
			shapeOnBox({ kind: "note", at: { x: 50, y: 350 } }, from, to),
		).toEqual({ kind: "note", at: { x: -40, y: 270 } });
	});

	test("a small element that grew does not throw a far point away", () => {
		const icon = { x: 100, y: 100, width: 16, height: 16 };
		const grown = { x: 100, y: 100, width: 32, height: 32 };
		const arrow = {
			kind: "arrow",
			from: { x: -200, y: 108 },
			to: { x: 108, y: 108 },
		} as const;
		expect(shapeOnBox(arrow, icon, grown)).toEqual({
			kind: "arrow",
			from: { x: -200, y: 116 },
			to: { x: 116, y: 116 },
		});
	});

	test("a box across the edge stays in one piece", () => {
		const rect = { x: 50, y: 225, width: 150, height: 50 };
		expect(shapeOnBox({ kind: "box", rect }, from, to)).toEqual({
			kind: "box",
			rect: { x: -40, y: 70, width: 100, height: 100 },
		});
	});

	test("an element's mark is the box itself", () => {
		expect(shapeOnBox({ kind: "element", rect: from }, from, to)).toEqual({
			kind: "element",
			rect: to,
		});
	});

	test("a box without size only moves it", () => {
		const flat = { x: 100, y: 200, width: 0, height: 0 };
		const rect = { x: 110, y: 210, width: 30, height: 40 };
		expect(shapeOnBox({ kind: "box", rect }, flat, to)).toEqual({
			kind: "box",
			rect: { x: 20, y: 30, width: 30, height: 40 },
		});
	});
});

describe("a case for a page", () => {
	const on = (url: string): Case => {
		const c = sampleCase();
		return { ...c, page: { ...c.page, url } };
	};

	test("another build of a page is that page", () => {
		expect(isPageOf(on("https://a.ch/kk"), "http://localhost:3000/kk")).toBe(
			true,
		);
	});

	test("the same site's home page is that page", () => {
		expect(isPageOf(on("https://a.ch/"), "https://a.ch/")).toBe(true);
	});

	test("another site's home page is not", () => {
		expect(isPageOf(on("https://a.ch/"), "https://b.ch/")).toBe(false);
	});
});

describe("the same path", () => {
	test("whatever the origin or a last slash", () => {
		expect(
			samePath("https://www.example.com/kk/", "http://localhost:3000/kk"),
		).toBe(true);
		expect(samePath("https://a.ch/kk", "https://a.ch/hypo")).toBe(false);
		expect(samePath("not an address", "https://a.ch/")).toBe(false);
	});

	test("a hash route is another page, a plain anchor is not", () => {
		expect(samePath("https://a.ch/#/orders", "https://b.ch/#/orders")).toBe(
			true,
		);
		expect(samePath("https://a.ch/#/orders", "https://a.ch/#/settings")).toBe(
			false,
		);
		expect(samePath("https://a.ch/kk#top", "https://a.ch/kk#bottom")).toBe(
			true,
		);
	});
});

describe("settling, editing and deleting a mark", () => {
	const NOW = "2026-11-08T16:00:00.000Z";
	/** Marks 1 and 2 on s1, mark 3 alone on s2. */
	function three(): Case {
		const c = withMarks();
		const [first] = c.annotations as [Annotation];
		c.annotations = [
			first,
			{ ...first, id: "a2", number: 2, crop: "crops/a2.webp" },
			{ ...first, id: "a3", number: 3, shot: "s2", crop: "crops/a3.webp" },
		];
		return c;
	}

	test("a resolution with a note, then open again", () => {
		const c = three();
		const done = withResolution(
			c,
			"a2",
			{ kind: "wontfix", note: "  Legal wants it  " },
			NOW,
		);
		expect(done.annotations[1]?.resolution).toEqual({
			kind: "wontfix",
			note: "Legal wants it",
			at: NOW,
		});
		expect(done.updatedAt).toBe(NOW);
		expect(validateCase(JSON.parse(JSON.stringify(done)))).toEqual(done);
		const open = withReopen(done, "a2", {}, NOW);
		expect("resolution" in (open.annotations[1] as object)).toBe(false);
	});

	test("an empty note is no note", () => {
		const done = withResolution(
			three(),
			"a1",
			{ kind: "fixed", note: " " },
			NOW,
		);
		expect(done.annotations[0]?.resolution).toEqual({ kind: "fixed", at: NOW });
	});

	test("a resolution of another kind is refused on import", () => {
		const c = three();
		const bad = JSON.parse(JSON.stringify(c));
		bad.annotations[0].resolution = { kind: "duplicate", at: NOW };
		expect(() => validateCase(bad)).toThrow(
			"case.annotations[0].resolution.kind",
		);
	});

	test("a comment edited is the user's", () => {
		const c = three();
		c.annotations[2] = { ...(c.annotations[2] as Annotation), author: "ai" };
		const edited = withComment(c, "a3", "  Shorter  ", NOW);
		expect(edited.annotations[2]?.comment).toBe("Shorter");
		expect(edited.annotations[2]?.author).toBe("user");
	});

	test("a mark gone: its crop goes, the shared screenshot stays", () => {
		const { value, images } = withoutAnnotation(three(), "a2", NOW);
		expect(value.annotations.map((a) => a.id)).toEqual(["a1", "a3"]);
		expect(value.shots.map((s) => s.id)).toEqual(["s1", "s2"]);
		expect(images).toEqual(["crops/a2.webp"]);
		expect(validateCase(JSON.parse(JSON.stringify(value)))).toEqual(value);
	});

	test("the last mark on a screenshot takes the screenshot with it", () => {
		const { value, images } = withoutAnnotation(three(), "a3", NOW);
		expect(value.shots.map((s) => s.id)).toEqual(["s1"]);
		expect(images).toEqual(["crops/a3.webp", "shots/s2.webp"]);
	});

	test("a deleted mark's number is not given again", () => {
		const { value } = withoutAnnotation(three(), "a3", NOW);
		expect(value.lastNumber).toBe(3);
		expect(nextNumbers(value).annotation).toBe(4);
		const bad = JSON.parse(JSON.stringify(three()));
		bad.lastNumber = 2;
		expect(() => validateCase(bad)).toThrow("case.lastNumber");
	});

	test("a mark that is gone already says so", () => {
		expect(() => withoutAnnotation(three(), "a9", NOW)).toThrow(
			"The mark no longer exists.",
		);
		expect(() => withComment(three(), "a9", "x", NOW)).toThrow(
			"The mark no longer exists.",
		);
	});
});

describe("Verify: statuses, reopens and their format (DEC-023)", () => {
	const T1 = "2026-11-13T11:00:00.000Z";
	const T2 = "2026-11-13T16:00:00.000Z";
	const T3 = "2026-11-14T09:00:00.000Z";
	const T4 = "2026-11-14T15:00:00.000Z";
	const CLAUDE = {
		id: "https://claude.ai/oauth",
		name: "Claude",
		host: "claude.ai",
	};
	const one = (): Case => withMarks();
	const statusOf = (c: Case) => markStatus(c.annotations[0] as Annotation);
	const roundTrip = (c: Case) => validateCase(JSON.parse(JSON.stringify(c)));

	test("each status from what is stored", () => {
		const c = one();
		expect(statusOf(c)).toBe("open");
		const fixed = withResolution(c, "a1", { kind: "fixed" }, T1);
		expect(statusOf(fixed)).toBe("fixed");
		expect(statusOf(withVerified(fixed, "a1", undefined, T2))).toBe("verified");
		expect(statusOf(withResolution(c, "a1", { kind: "wontfix" }, T1))).toBe(
			"wontfix",
		);
		expect(
			statusOf(withResolution(c, "a1", { kind: "cantreproduce" }, T1)),
		).toBe("cantreproduce");
	});

	test("every transition of the table", () => {
		const c = one();
		// open → fixed, and fixed → verified.
		const fixed = withResolution(
			c,
			"a1",
			{ kind: "fixed", note: "Darker text, 7:1 now" },
			T1,
		);
		expect(fixed.annotations[0]?.resolution).toEqual({
			kind: "fixed",
			note: "Darker text, 7:1 now",
			at: T1,
		});
		const verified = withVerified(fixed, "a1", undefined, T2);
		expect(verified.annotations[0]?.resolution?.verified).toEqual({ at: T2 });
		expect(verified.updatedAt).toBe(T2);
		// open → fixed and verified at once (the panel's choice).
		const atOnce = withResolution(
			c,
			"a1",
			{ kind: "fixed", verified: true },
			T1,
		);
		expect(atOnce.annotations[0]?.resolution).toEqual({
			kind: "fixed",
			at: T1,
			verified: { at: T1 },
		});
		// verified → open: the whole resolution moves into the reopen.
		const reopened = withReopen(verified, "a1", { note: "Still pale" }, T3);
		const a = reopened.annotations[0] as Annotation;
		expect(a.resolution).toBeUndefined();
		expect(a.reopens).toEqual([
			{
				note: "Still pale",
				at: T3,
				was: {
					kind: "fixed",
					note: "Darker text, 7:1 now",
					at: T1,
					verified: { at: T2 },
				},
			},
		]);
		expect(markStatus(a)).toBe("open");
		// wontfix and cantreproduce reopen the same way.
		for (const kind of ["wontfix", "cantreproduce"] as const) {
			const closed = withResolution(c, "a1", { kind }, T1);
			const back = withReopen(closed, "a1", { note: "Not so" }, T2);
			expect(back.annotations[0]?.reopens?.[0]?.was.kind).toBe(kind);
		}
		// Change: a verified fix stays verified as it was when chosen again...
		const kept = withResolution(
			verified,
			"a1",
			{ kind: "fixed", verified: true, note: "Hover too" },
			T3,
		);
		expect(kept.annotations[0]?.resolution).toEqual({
			kind: "fixed",
			note: "Hover too",
			at: T3,
			verified: { at: T2 },
		});
		// ...and is no longer verified as "Fixed, to verify" or another kind.
		expect(
			statusOf(withResolution(verified, "a1", { kind: "fixed" }, T3)),
		).toBe("fixed");
		const wontfix = withResolution(verified, "a1", { kind: "wontfix" }, T3);
		expect(wontfix.annotations[0]?.resolution).toEqual({
			kind: "wontfix",
			at: T3,
		});
		// A reopen stays when the mark is settled again.
		const again = withResolution(reopened, "a1", { kind: "fixed" }, T4);
		expect(again.annotations[0]?.reopens?.length).toBe(1);
		expect(roundTrip(again)).toEqual(again);
	});

	test("an open mark reopened, or a verified one verified, stays as it is", () => {
		const c = one();
		expect(withReopen(c, "a1", { note: "x" }, T1)).toBe(c);
		const verified = withVerified(
			withResolution(c, "a1", { kind: "fixed" }, T1),
			"a1",
			undefined,
			T2,
		);
		expect(withVerified(verified, "a1", undefined, T3)).toBe(verified);
	});

	test("only a fixed mark can be verified", () => {
		const c = one();
		expect(() => withVerified(c, "a1", undefined, T1)).toThrow(
			"Mark 1 is open: only a fixed mark can be verified.",
		);
		const closed = withResolution(c, "a1", { kind: "wontfix" }, T1);
		expect(() => withVerified(closed, "a1", undefined, T2)).toThrow(
			"only a fixed mark can be verified",
		);
		// "verified" on another kind is no verification.
		expect(
			withResolution(c, "a1", { kind: "wontfix", verified: true }, T1)
				.annotations[0]?.resolution,
		).toEqual({ kind: "wontfix", at: T1 });
	});

	test("an AI app's status records the app", () => {
		const c = one();
		const fixed = withResolution(
			c,
			"a1",
			{ kind: "fixed", note: "Hover state too", app: CLAUDE },
			T3,
		);
		const verified = withVerified(fixed, "a1", CLAUDE, T4);
		expect(verified.annotations[0]?.resolution).toEqual({
			kind: "fixed",
			note: "Hover state too",
			at: T3,
			app: CLAUDE,
			verified: { at: T4, app: CLAUDE },
		});
		const back = withReopen(verified, "a1", { app: CLAUDE }, T4);
		expect(back.annotations[0]?.reopens?.[0]).toEqual({
			at: T4,
			app: CLAUDE,
			was: verified.annotations[0]?.resolution as never,
		});
		expect(roundTrip(back)).toEqual(back);
		expect(roundTrip(verified)).toEqual(verified);
	});

	test("a note only: the rest of the resolution stays", () => {
		const verified = withVerified(
			withResolution(one(), "a1", { kind: "fixed", note: "Old" }, T1),
			"a1",
			undefined,
			T2,
		);
		const noted = withResolutionNote(verified, "a1", "  New  ", T3);
		expect(noted.annotations[0]?.resolution).toEqual({
			kind: "fixed",
			note: "New",
			at: T1,
			verified: { at: T2 },
		});
		expect(() => withResolutionNote(one(), "a1", "x", T1)).toThrow("is open");
	});

	test("reopens keep `was` whole and the newest 20; a long note is cut", () => {
		let c = one();
		for (let i = 0; i < MAX_REOPENS + 3; i++) {
			c = withResolution(c, "a1", { kind: "fixed", note: `Fix ${i}` }, T1);
			c = withReopen(c, "a1", { note: `Still ${i}` }, T2);
		}
		const reopens = c.annotations[0]?.reopens ?? [];
		expect(reopens.length).toBe(MAX_REOPENS);
		expect(reopens[0]?.note).toBe("Still 3");
		expect(reopens[0]?.was).toEqual({ kind: "fixed", note: "Fix 3", at: T1 });
		expect(reopens.at(-1)?.note).toBe(`Still ${MAX_REOPENS + 2}`);
		const long = withReopen(
			withResolution(one(), "a1", { kind: "fixed" }, T1),
			"a1",
			{ note: "x".repeat(MAX_REOPEN_NOTE + 50) },
			T2,
		);
		expect(long.annotations[0]?.reopens?.[0]?.note?.length).toBe(
			MAX_REOPEN_NOTE,
		);
		// A file with more keeps the newest; an empty list is none.
		const file = JSON.parse(JSON.stringify(c));
		file.annotations[0].reopens = [
			...file.annotations[0].reopens,
			...file.annotations[0].reopens.slice(0, 5),
		];
		const read = validateCase(file);
		expect(read.annotations[0]?.reopens?.length).toBe(MAX_REOPENS);
		expect(read.annotations[0]?.reopens?.at(-1)?.note).toBe("Still 7");
		file.annotations[0].reopens = [];
		expect("reopens" in (validateCase(file).annotations[0] as object)).toBe(
			false,
		);
	});

	test("a case without the new fields validates and serializes unchanged", () => {
		const c = withResolution(one(), "a1", { kind: "fixed", note: "n" }, T1);
		const json = JSON.stringify(c);
		expect(JSON.stringify(validateCase(JSON.parse(json)))).toBe(json);
		const plain = JSON.stringify(one());
		expect(JSON.stringify(validateCase(JSON.parse(plain)))).toBe(plain);
	});

	test("verified on wontfix is dropped, not refused; a bad one on a fix is", () => {
		const file = JSON.parse(JSON.stringify(one()));
		file.annotations[0].resolution = {
			kind: "wontfix",
			at: T1,
			verified: { at: T2 },
		};
		expect(validateCase(file).annotations[0]?.resolution).toEqual({
			kind: "wontfix",
			at: T1,
		});
		file.annotations[0].resolution = { kind: "fixed", at: T1, verified: 1 };
		expect(() => validateCase(file)).toThrow(
			"case.annotations[0].resolution.verified",
		);
		file.annotations[0].resolution = { kind: "fixed", at: T1 };
		file.annotations[0].reopens = [{ at: T2, was: { kind: "duplicate" } }];
		expect(() => validateCase(file)).toThrow(
			"case.annotations[0].reopens[0].was.kind",
		);
		file.annotations[0].reopens = [
			{
				at: T2,
				note: "x".repeat(MAX_REOPEN_NOTE + 1),
				was: { kind: "fixed", at: T1 },
			},
		];
		expect(() => validateCase(file)).toThrow(
			"case.annotations[0].reopens[0].note",
		);
	});

	test("caseCounts: open, to verify, verified, closed", () => {
		const c = withMarks();
		const [first] = c.annotations as [Annotation];
		c.annotations = [1, 2, 3, 4, 5].map((n) => ({
			...first,
			id: `a${n}`,
			number: n,
			crop: `crops/a${n}.webp`,
		}));
		let d = withResolution(c, "a2", { kind: "fixed" }, T1);
		d = withResolution(d, "a3", { kind: "fixed", verified: true }, T1);
		d = withResolution(d, "a4", { kind: "wontfix" }, T1);
		d = withResolution(d, "a5", { kind: "cantreproduce" }, T1);
		expect(caseCounts(d)).toEqual({
			open: 1,
			toVerify: 1,
			verified: 1,
			closed: 2,
		});
		expect(caseCounts({ ...c, annotations: [] })).toEqual({
			open: 0,
			toVerify: 0,
			verified: 0,
			closed: 0,
		});
	});
});
