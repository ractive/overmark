import { describe, expect, test } from "bun:test";
import {
	type Annotation,
	type Case,
	isPageOf,
	MAX_URL,
	newId,
	nextNumbers,
	plainUrl,
	samePath,
	shapeOnBox,
	validateCase,
	withComment,
	withoutAnnotation,
	withResolution,
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
		const open = withResolution(done, "a2", null, NOW);
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

	test("a comment edited", () => {
		const edited = withComment(three(), "a3", "  Shorter  ", NOW);
		expect(edited.annotations[2]?.comment).toBe("Shorter");
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
