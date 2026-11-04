import { describe, expect, test } from "bun:test";
import {
	type Annotation,
	type Case,
	nextNumbers,
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
