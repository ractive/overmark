import { describe, expect, test } from "bun:test";
import {
	type Annotation,
	type Case,
	MAX_URL,
	newId,
	nextNumbers,
	plainUrl,
	validateCase,
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
