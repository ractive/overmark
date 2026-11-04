import { describe, expect, test } from "bun:test";
import { type Case, CaseError, validateCase } from "../src/lib/case.ts";
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
		expect(() => validateCase(c)).toThrow("case.shots: an id is used twice");
	});

	test("refuses more than 50 element attributes", () => {
		const c = withMarks();
		const element = c.annotations[0]?.element;
		if (element)
			element.attributes = Object.fromEntries(
				Array.from({ length: 51 }, (_, i) => [`a${i}`, "x"]),
			);
		expect(() => validateCase(c)).toThrow(CaseError);
	});

	test("refuses a verdict over 50,000 characters", () => {
		const c = withMarks();
		c.verdict = "x".repeat(50_001);
		expect(() => validateCase(c)).toThrow("case.verdict");
	});
});
