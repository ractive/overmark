import { describe, expect, test } from "bun:test";
import type { AnnotationMatch } from "../src/lib/messages.ts";
import {
	canDrawOn,
	type FollowInput,
	followStep,
	noneFound,
} from "../src/sidepanel/follow.ts";

const web = { id: 1, url: "http://localhost:3000/kk", loading: false };

const input = (change: Partial<FollowInput> = {}): FollowInput => ({
	caseId: "c_1",
	tab: web,
	drawn: undefined,
	pageCase: undefined,
	hidden: new Set(),
	reloaded: false,
	...change,
});

describe("the open case's marks follow it to the tab in front", () => {
	test("opening a case draws it on the tab in front, whatever page that is", () => {
		for (const url of [
			"http://localhost:3000/kk",
			"https://dev.example.ch/other",
			"file:///Users/me/page.html",
		])
			expect(followStep(input({ tab: { ...web, url } }))).toEqual({
				clear: undefined,
				action: "draw",
			});
	});

	test("another tab in front: drawn there, taken off the one before", () => {
		const drawn = { tabId: 1, caseId: "c_1" };
		expect(followStep(input({ tab: { ...web, id: 2 }, drawn }))).toEqual({
			clear: drawn,
			action: "draw",
		});
	});

	test("drawn on the tab in front already: left as it is (candidates chosen stay)", () => {
		expect(followStep(input({ drawn: { tabId: 1, caseId: "c_1" } }))).toEqual({
			clear: undefined,
			action: "none",
		});
		// An AI app's load_case drew it there.
		expect(followStep(input({ pageCase: "c_1" }))).toEqual({
			clear: undefined,
			action: "none",
		});
	});

	test("the tab in front reloaded or navigated: drawn again", () => {
		expect(
			followStep(
				input({
					drawn: { tabId: 1, caseId: "c_1" },
					pageCase: "c_1",
					reloaded: true,
				}),
			),
		).toEqual({ clear: undefined, action: "draw" });
	});

	test("hidden on a tab: not drawn there again by itself", () => {
		expect(followStep(input({ hidden: new Set([1]), reloaded: true }))).toEqual(
			{ clear: undefined, action: "none" },
		);
		// Elsewhere it is.
		expect(followStep(input({ hidden: new Set([2]) })).action).toBe("draw");
		// Leaving for a hidden tab still takes the marks off the tab before.
		const drawn = { tabId: 2, caseId: "c_1" };
		expect(followStep(input({ hidden: new Set([1]), drawn }))).toEqual({
			clear: drawn,
			action: "none",
		});
	});

	test("a tab Overmark may not run on: wait for the icon or Allow on all sites", () => {
		expect(followStep(input({ tab: { ...web, url: "" } }))).toEqual({
			clear: undefined,
			action: "wait",
		});
	});

	test("a tab still loading: nothing yet, its load draws", () => {
		expect(
			followStep(input({ tab: { ...web, url: "", loading: true } })).action,
		).toBe("none");
		expect(followStep(input({ tab: { ...web, loading: true } })).action).toBe(
			"none",
		);
	});

	test("a page no content script runs on (an extension's own, the browser's): nothing", () => {
		for (const url of [
			"chrome-extension://abc/sidepanel/index.html",
			"chrome://settings",
			"about:blank",
		]) {
			expect(canDrawOn(url)).toBe(false);
			expect(followStep(input({ tab: { ...web, url } })).action).toBe("none");
		}
	});

	test("no case open: the panel's marks go, nothing is drawn", () => {
		const drawn = { tabId: 1, caseId: "c_1" };
		expect(followStep(input({ caseId: undefined, drawn }))).toEqual({
			clear: drawn,
			action: "none",
		});
		expect(followStep(input({ tab: undefined, drawn }))).toEqual({
			clear: drawn,
			action: "none",
		});
	});

	test("another case's marks on the tab in front: the draw replaces them", () => {
		const drawn = { tabId: 1, caseId: "c_old" };
		expect(followStep(input({ drawn }))).toEqual({
			clear: undefined,
			action: "draw",
		});
		// Not drawn here: they go all the same.
		expect(followStep(input({ drawn, hidden: new Set([1]) }))).toEqual({
			clear: drawn,
			action: "none",
		});
	});
});

describe("none of the case's marks found", () => {
	const match = (
		n: number,
		status: AnnotationMatch["status"],
	): AnnotationMatch => ({
		annotationId: `a${n}`,
		number: n,
		status,
		score: status === "lost" ? 0 : 0.9,
		current: 0,
		candidates: [],
	});

	test("every mark lost: none found", () => {
		expect(noneFound([match(1, "lost"), match(2, "lost")])).toBe(true);
	});

	test("lost and marks without an element: none found", () => {
		expect(noneFound([match(1, "lost"), match(2, "no-element")])).toBe(true);
	});

	test("one found, probable or unsure: some found", () => {
		for (const status of ["found", "probable", "ambiguous"] as const)
			expect(noneFound([match(1, "lost"), match(2, status)])).toBe(false);
	});

	test("only marks without an element, or none at all: nothing to tell by", () => {
		expect(noneFound([match(1, "no-element")])).toBe(false);
		expect(noneFound([])).toBe(false);
	});
});
