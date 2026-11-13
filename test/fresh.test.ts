import { describe, expect, test } from "bun:test";
import { MAX_TITLE, type PageInfo, withTitle } from "../src/lib/case.ts";
import { firstTitle, isUntouched, newCase } from "../src/sidepanel/fresh.ts";
import { withOneMark } from "./fixtures.ts";

const NOW = "2026-11-13T10:00:00.000Z";

const page = (change: Partial<PageInfo> = {}): PageInfo => ({
	url: "https://shop.example/cart?session=abc#top",
	title: "Your cart",
	lang: "en",
	viewport: { width: 1280, height: 800, dpr: 2 },
	userAgent: "test",
	...change,
});

describe("a case created by Annotate this page (DEC-026)", () => {
	test("has the page's title, the page's info, and nothing else yet", () => {
		const c = newCase("c_new", page(), NOW);
		expect(c).toEqual({
			format: "overmark/1",
			id: "c_new",
			title: "Your cart",
			createdAt: NOW,
			updatedAt: NOW,
			// Kept as a mark's page is: no query, no fragment (DEC-009).
			page: { ...page(), url: "https://shop.example/cart" },
			shots: [],
			annotations: [],
			verdict: null,
		});
	});

	test("a page without a title gives its short address", () => {
		expect(firstTitle(page({ title: "   " }))).toBe("shop.example/cart");
		expect(newCase("c_new", page({ title: "" }), NOW).title).toBe(
			"shop.example/cart",
		);
		expect(firstTitle({ url: "https://shop.example/", title: "" })).toBe(
			"shop.example",
		);
		expect(firstTitle({ url: "", title: "" })).toBe("Untitled case");
	});

	test("a long page title is cut to a case title's length", () => {
		const long = "x".repeat(MAX_TITLE + 20);
		expect(newCase("c_new", page({ title: long }), NOW).title).toBe(
			"x".repeat(MAX_TITLE),
		);
	});
});

describe("an untouched case goes when it is left (DEC-026)", () => {
	const fresh = () => newCase("c_new", page(), NOW);

	test("as it was made: untouched, a long title cut too", () => {
		expect(isUntouched(fresh())).toBe(true);
		const long = newCase("c_long", page({ title: "y".repeat(600) }), NOW);
		expect(isUntouched(long)).toBe(true);
		const untitled = newCase("c_bare", page({ title: "" }), NOW);
		expect(isUntouched(untitled)).toBe(true);
	});

	test("a mark in it: the user's", () => {
		expect(isUntouched(withOneMark(fresh()))).toBe(false);
	});

	test("its only mark taken out by the toolbar's Undo: untouched again", () => {
		// Undo frees the number: the case is as it was made.
		const undone = { ...withOneMark(fresh()), annotations: [], shots: [] };
		expect(isUntouched(undone)).toBe(true);
	});

	test("its marks deleted in the side panel: the user's, it stays", () => {
		expect(
			isUntouched({ ...fresh(), lastNumber: 2, annotations: [], shots: [] }),
		).toBe(false);
	});

	test("renamed, given a summary, or one typed and not saved: the user's", () => {
		expect(isUntouched(withTitle(fresh(), "Login", NOW))).toBe(false);
		expect(isUntouched({ ...fresh(), verdict: "Make it darker" })).toBe(false);
		expect(isUntouched(fresh(), "Make it")).toBe(false);
		// Blank text is nothing typed.
		expect(isUntouched({ ...fresh(), verdict: "  " }, " ")).toBe(true);
	});

	test("imported from a file: someone's case, it stays", () => {
		expect(isUntouched({ ...fresh(), importedAt: NOW })).toBe(false);
	});
});
