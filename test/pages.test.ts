/**
 * A case spans several pages (DEC-038): the list of its pages in the format,
 * a mark on another page adding that page, and what is judged per page (which
 * case is "this page's", what a draw found, the window a mark was made in).
 */

import { describe, expect, test } from "bun:test";
import {
	type Annotation,
	type Case,
	casePages,
	isPageOf,
	MAX_PAGES,
	marksOnPage,
	markUrl,
	pageAt,
	pendingImage,
	type Shot,
	samePage,
	validateCase,
	viewportAt,
	withoutAnnotation,
	withPagesOfShots,
} from "../src/lib/case.ts";
import { exportCase, readExport, storeImport } from "../src/lib/export.ts";
import { caseMarkdown } from "../src/lib/markdown.ts";
import type { AnnotationMatch } from "../src/lib/messages.ts";
import {
	type AnnotationDraft,
	type Crop,
	saveCase,
	undoAdd,
} from "../src/lib/save.ts";
import { MemoryStore } from "../src/lib/store.ts";
import { foundLine, matchesHere, noneFound } from "../src/sidepanel/follow.ts";
import { newCase } from "../src/sidepanel/fresh.ts";
import { putCase, sampleCase } from "./fixtures.ts";

const CART = "https://shop.example/cart";
const PAY = "https://shop.example/checkout/pay";
const NOW = "2026-11-19T10:00:00.000Z";

const shot = (id: string, url?: string, width = 1280): Shot => ({
	id,
	image: `shots/${id}.webp`,
	scrollX: 0,
	scrollY: 0,
	viewport: { width, height: 800, dpr: 2 },
	capturedAt: "2026-11-19T09:00:00.000Z",
	...(url === undefined ? {} : { url }),
});

const mark = (n: number, shotId: string, element = false): Annotation => ({
	id: `a${n}`,
	number: n,
	shot: shotId,
	comment: `comment ${n}`,
	author: "user",
	shape: { kind: "box", rect: { x: 1, y: 2, width: 30, height: 40 } },
	crop: `crops/a${n}.webp`,
	element: element
		? {
				tag: "button",
				classes: [],
				attributes: {},
				ancestors: [],
				rect: { x: 1, y: 2, width: 30, height: 40 },
				page: { width: 1280, height: 2000 },
				selector: "button",
			}
		: null,
});

/** A flow through a shop: two marks on the cart, one on the payment page. */
function flow(): Case {
	return {
		...sampleCase("c_flow"),
		page: {
			url: CART,
			title: "Your cart",
			lang: "en",
			viewport: { width: 1280, height: 800, dpr: 2 },
			userAgent: "test",
		},
		pages: [
			{ url: CART, title: "Your cart", lang: "en" },
			{ url: PAY, title: "Payment", lang: "en" },
		],
		shots: [shot("s1", CART), shot("s2", PAY, 390)],
		annotations: [mark(1, "s1", true), mark(2, "s1"), mark(3, "s2", true)],
	};
}

describe("the pages of a case", () => {
	test("a case stored before the list reads as before: its page, and the pages of its screenshots", () => {
		const old: Case = {
			...sampleCase("c_old"),
			shots: [
				shot("s1"),
				shot("s2", "https://www.example.com/kk/step-2"),
				shot("s3", "https://www.example.com/kk/step-2"),
			],
			annotations: [mark(1, "s1"), mark(2, "s2"), mark(3, "s3")],
		};
		expect(old.pages).toBeUndefined();
		expect(casePages(old)).toEqual([
			{ url: "https://www.example.com/kk", title: "KK", lang: "de" },
			{ url: "https://www.example.com/kk/step-2", title: "", lang: "" },
		]);
		// A screenshot without an address is the first page's.
		expect(markUrl(old, old.annotations[0] as Annotation)).toBe(
			"https://www.example.com/kk",
		);
		expect(marksOnPage(old, "https://www.example.com/kk/step-2")).toBe(2);
		// Nothing is written for it: validating it adds no list.
		expect(validateCase(old).pages).toBeUndefined();
	});

	test("the stored list is the list, each page once; a page only a screenshot names comes after", () => {
		const c = flow();
		expect(casePages(c).map((p) => p.url)).toEqual([CART, PAY]);
		const more: Case = {
			...c,
			pages: [...(c.pages ?? []), { url: `${CART}/`, title: "", lang: "" }],
			shots: [...c.shots, shot("s3", "https://shop.example/done")],
		};
		expect(casePages(more).map((p) => p.url)).toEqual([
			CART,
			PAY,
			"https://shop.example/done",
		]);
	});

	test("the same page: the same path, in whatever environment; two sites' home pages are two", () => {
		expect(samePage(CART, `${CART}/`)).toBe(true);
		expect(samePage(CART, "https://shop.example/cart#top")).toBe(true);
		// A mark added on localhost to a case from production: the same page.
		expect(samePage(CART, "http://localhost:3000/cart")).toBe(true);
		expect(samePage(CART, PAY)).toBe(false);
		expect(samePage("https://shop.example/", "https://pay.example/")).toBe(
			false,
		);
		expect(samePage("https://shop.example/", "https://shop.example")).toBe(
			true,
		);
		// What is no address at all (a file's) is itself only.
		expect(samePage("somewhere", "somewhere")).toBe(true);
		expect(samePage("somewhere", "elsewhere")).toBe(false);
	});

	test("a case is this page's for any of its pages, in whatever environment", () => {
		const c = flow();
		expect(pageAt(c, "http://localhost:3000/checkout/pay?step=2")?.url).toBe(
			PAY,
		);
		expect(pageAt(c, "http://localhost:3000/cart")?.url).toBe(CART);
		expect(pageAt(c, "http://localhost:3000/account")).toBeUndefined();
		expect(isPageOf(c, "http://localhost:3000/checkout/pay")).toBe(true);
		expect(isPageOf(c, "http://localhost:3000/account")).toBe(false);
	});

	test("the window a mark was made in is that of its page's screenshot", () => {
		const c = flow();
		expect(viewportAt(c, "http://localhost:3000/cart").width).toBe(1280);
		expect(viewportAt(c, "http://localhost:3000/checkout/pay").width).toBe(390);
		// A page that is none of the case's, or no page: the first page's.
		expect(viewportAt(c, "http://localhost:3000/account").width).toBe(1280);
		expect(viewportAt(c, undefined).width).toBe(1280);
	});

	test("the format takes the list, and a list without languages; it refuses what is none", () => {
		const c = flow();
		expect(validateCase(c).pages).toEqual(c.pages as never);
		const noLang = { ...c, pages: [{ url: CART, title: "Your cart" }] };
		expect(validateCase(noLang).pages).toEqual([
			{ url: CART, title: "Your cart", lang: "" },
		]);
		expect(() => validateCase({ ...c, pages: "all" })).toThrow(
			"case.pages: must be an array",
		);
		expect(() =>
			validateCase({ ...c, pages: [{ url: 1, title: "" }] }),
		).toThrow("case.pages[0].url: must be a string");
		expect(() =>
			validateCase({
				...c,
				pages: Array.from({ length: MAX_PAGES + 1 }, (_, i) => ({
					url: `${CART}/${i}`,
					title: "",
				})),
			}),
		).toThrow(`more than ${MAX_PAGES} items`);
	});

	test("a build before the list reads a new file: what it does not know is left out, not refused", () => {
		// `validateCase` builds its result from the fields it knows, so the
		// older build's reading of a new export is the case without `pages`
		// (and with every screenshot's address, which it knew). Here: a field
		// this build does not know either.
		const later = { ...flow(), somethingNew: { a: 1 }, format: "sitegloss/1" };
		const read = validateCase(later) as unknown as Record<string, unknown>;
		expect(read["somethingNew"]).toBeUndefined();
		expect(read["page"]).toEqual(flow().page);
		expect((read["shots"] as Shot[]).map((s) => s.url)).toEqual([CART, PAY]);
	});

	test("deleting a page's last mark takes the page off the list; the first page follows the first one left", () => {
		const c = flow();
		const { value } = withoutAnnotation(c, "a3", NOW);
		expect(casePages(value).map((p) => p.url)).toEqual([CART]);
		expect(value.page.url).toBe(CART);
		// The cart's marks go: the payment page is the case's first page now.
		let rest = withoutAnnotation(c, "a1", NOW).value;
		expect(casePages(rest).map((p) => p.url)).toEqual([CART, PAY]);
		rest = withoutAnnotation(rest, "a2", NOW).value;
		expect(rest.pages).toEqual([{ url: PAY, title: "Payment", lang: "en" }]);
		expect(rest.page).toEqual({
			...c.page,
			url: PAY,
			title: "Payment",
			lang: "en",
		});
		expect(() => validateCase(rest)).not.toThrow();
		// The last mark of all: the case stays its page's.
		const none = withoutAnnotation(rest, "a3", NOW).value;
		expect(none.pages).toEqual([{ url: PAY, title: "Payment", lang: "en" }]);
		expect(none.page.url).toBe(PAY);
	});

	test("a case from before the list stays without one when a mark goes", () => {
		const old: Case = {
			...sampleCase("c_old"),
			shots: [shot("s1"), shot("s2", "https://www.example.com/other")],
			annotations: [mark(1, "s1"), mark(2, "s2")],
		};
		const { value } = withoutAnnotation(old, "a2", NOW);
		expect(value.pages).toBeUndefined();
		expect(withPagesOfShots(old)).toBe(old);
		expect(casePages(value).map((p) => p.url)).toEqual([
			"https://www.example.com/kk",
		]);
	});
});

// --- saving marks ----------------------------------------------------------------

const crop: Crop = async (_image, rects) =>
	rects.map(() => ({ blob: new Blob(["crop"]), width: 280, height: 160 }));

const draft = (n: number, shotId: string): AnnotationDraft => ({
	id: `a${n}`,
	number: n,
	shot: shotId,
	comment: `comment ${n}`,
	author: "user",
	shape: { kind: "box", rect: { x: 10, y: 10, width: 100, height: 40 } },
	element: null,
	cropRect: { x: 0, y: 0, width: 140, height: 80 },
});

const pageInfo = (url: string, title: string) => ({
	url,
	title,
	lang: "en",
	viewport: { width: 1280, height: 800, dpr: 2 },
	userAgent: "test",
});

/** Add mark `n` to `caseId` from the page at `url`, as the toolbar does. */
async function add(
	store: MemoryStore,
	caseId: string,
	n: number,
	url: string,
	title: string,
	at = "2026-11-19T10:00:00.000Z",
): Promise<Case> {
	const id = `p_${n}`;
	await store.putImage(caseId, pendingImage(id), {
		blob: new Blob([`shot ${id}`]),
		width: 2560,
		height: 1600,
	});
	return saveCase(
		store,
		{
			caseId,
			isNew: false,
			title: "",
			page: pageInfo(url, title),
			shots: [
				{
					id,
					image: pendingImage(id),
					scrollX: 0,
					scrollY: 0,
					viewport: { width: 1280, height: 800, dpr: 2 },
					capturedAt: at,
					url,
				},
			],
			annotations: [draft(n, id)],
		},
		crop,
		new Date(at),
	);
}

describe("marks on another page go into the open case", () => {
	test("the first mark's page is the case's; a mark on another page adds that page", async () => {
		const store = new MemoryStore();
		// Started on the product page, first marked on the cart.
		await putCase(
			store,
			newCase(
				"c_1",
				pageInfo("https://shop.example/product/7?ref=x", "A bike"),
				NOW,
			),
		);
		expect((await store.getCase("c_1"))?.pages).toEqual([
			{ url: "https://shop.example/product/7", title: "A bike", lang: "en" },
		]);
		let c = await add(store, "c_1", 1, `${CART}?session=1#top`, "Your cart");
		expect(c.page.url).toBe(CART);
		expect(c.pages).toEqual([{ url: CART, title: "Your cart", lang: "en" }]);
		expect(c.shots.map((s) => s.url)).toEqual([CART]);
		// The next page of the flow: the same case, one more page.
		c = await add(store, "c_1", 2, `${PAY}?token=secret`, "Payment");
		expect(c.page.url).toBe(CART);
		expect(c.pages).toEqual([
			{ url: CART, title: "Your cart", lang: "en" },
			{ url: PAY, title: "Payment", lang: "en" },
		]);
		expect(c.shots.map((s) => s.url)).toEqual([CART, PAY]);
		// Back on the cart: no page twice.
		c = await add(store, "c_1", 3, `${CART}/`, "Your cart");
		expect(c.pages?.map((p) => p.url)).toEqual([CART, PAY]);
		expect(marksOnPage(c, CART)).toBe(2);
		expect(marksOnPage(c, PAY)).toBe(1);
	});

	test("a page of another site is a page of the case like any other (DEC-038)", async () => {
		const store = new MemoryStore();
		await putCase(store, newCase("c_1", pageInfo(CART, "Your cart"), NOW));
		await add(store, "c_1", 1, CART, "Your cart");
		const c = await add(
			store,
			"c_1",
			2,
			"https://pay.example/session/abc",
			"Pay",
		);
		expect(c.pages?.map((p) => p.url)).toEqual([
			CART,
			"https://pay.example/session/abc",
		]);
	});

	test("a screenshot sent without an address is the sending page's", async () => {
		const store = new MemoryStore();
		await putCase(store, newCase("c_1", pageInfo(CART, "Your cart"), NOW));
		await store.putImage("c_1", pendingImage("p_1"), {
			blob: new Blob(["shot"]),
			width: 10,
			height: 10,
		});
		const c = await saveCase(
			store,
			{
				caseId: "c_1",
				isNew: false,
				title: "",
				page: pageInfo(`${CART}?x=1`, "Your cart"),
				shots: [
					{
						id: "p_1",
						image: pendingImage("p_1"),
						scrollX: 0,
						scrollY: 0,
						viewport: { width: 1280, height: 800, dpr: 2 },
						capturedAt: NOW,
					},
				],
				annotations: [draft(1, "p_1")],
			},
			crop,
		);
		expect(c.shots[0]?.url).toBe(CART);
	});

	test("a case from before the list gets it with its next mark", async () => {
		const store = new MemoryStore();
		await putCase(store, {
			...sampleCase("c_old"),
			shots: [shot("s1")],
			annotations: [mark(1, "s1")],
		});
		const c = await add(
			store,
			"c_old",
			2,
			"https://www.example.com/kk/step-2",
			"Step 2",
		);
		expect(c.pages).toEqual([
			{ url: "https://www.example.com/kk", title: "KK", lang: "de" },
			{ url: "https://www.example.com/kk/step-2", title: "Step 2", lang: "en" },
		]);
	});

	test("Undo of the only mark of a page takes the page off again", async () => {
		const store = new MemoryStore();
		await putCase(store, newCase("c_1", pageInfo(CART, "Your cart"), NOW));
		await add(store, "c_1", 1, CART, "Your cart");
		const at = new Date().toISOString();
		const c = await add(store, "c_1", 2, PAY, "Payment", at);
		const added = c.annotations.find((a) => a.number === 2) as Annotation;
		await undoAdd(store, "c_1", "a2", {
			shot: added.shot,
			comment: added.comment,
		});
		expect((await store.getCase("c_1"))?.pages).toEqual([
			{ url: CART, title: "Your cart", lang: "en" },
		]);
	});
});

describe("a case of several pages in a file", () => {
	async function stored(): Promise<{ store: MemoryStore; c: Case }> {
		const store = new MemoryStore();
		const c = flow();
		await putCase(store, c);
		const webp = new Uint8Array(30);
		webp.set(new TextEncoder().encode("RIFF\x00\x00\x00\x00WEBPVP8X"), 0);
		webp[16] = 10;
		webp[24] = 9;
		webp[27] = 9;
		for (const path of [
			...c.shots.map((s) => s.image),
			...c.annotations.map((a) => a.crop),
		])
			await store.putImage(c.id, path, {
				blob: new Blob([webp], { type: "image/webp" }),
				width: 10,
				height: 10,
			});
		return { store, c };
	}

	test("an export and its import keep the pages and every screenshot's address", async () => {
		const { store, c } = await stored();
		const parsed = await readExport(await exportCase(store, c));
		expect(parsed.case.pages).toEqual(c.pages as never);
		const other = new MemoryStore();
		const imported = await storeImport(other, parsed);
		expect(imported.pages).toEqual(c.pages as never);
		expect(imported.shots.map((s) => s.url)).toEqual([CART, PAY]);
	});

	test("an import keeps no more of any page's address than a saved case does", async () => {
		const { store, c } = await stored();
		const leaky: Case = {
			...c,
			pages: [
				{ url: `${CART}?session=1`, title: "Your cart", lang: "en" },
				{ url: `${PAY}?token=secret#frag`, title: "Payment", lang: "en" },
			],
			shots: [
				shot("s1", `https://user:pw@shop.example/cart?session=1`),
				shot("s2", `${PAY}?token=secret`, 390),
			],
		};
		await putCase(store, leaky);
		const parsed = await readExport(await exportCase(store, leaky));
		const imported = await storeImport(new MemoryStore(), parsed);
		expect(imported.pages?.map((p) => p.url)).toEqual([CART, PAY]);
		expect(imported.shots.map((s) => s.url)).toEqual([CART, PAY]);
	});

	test("case.md lists the pages, says each mark's page and each screenshot's", () => {
		const md = caseMarkdown(flow());
		expect(md).toContain(
			[
				"- Pages (2):",
				`  - <${CART}>, Your cart (2 marks)`,
				`  - <${PAY}>, Payment (1 mark)`,
			].join("\n"),
		);
		expect(md).not.toContain("- Page title:");
		expect(md.match(new RegExp(`- Page: <${PAY}>`, "g"))).toHaveLength(1);
		expect(md.match(new RegExp(`- Page: <${CART}>`, "g"))).toHaveLength(2);
		expect(md).toContain(
			`Screenshot s2 is of <${PAY}>, in a window of 390×800 CSS pixels.`,
		);
	});

	test("case.md of a case of one page is as it was", () => {
		const one: Case = {
			...flow(),
			pages: [{ url: CART, title: "Your cart", lang: "en" }],
			shots: [shot("s1", CART)],
			annotations: [mark(1, "s1")],
		};
		const md = caseMarkdown(one);
		expect(md).toContain(`- Page: <${CART}>\n- Page title: Your cart`);
		expect(md).not.toContain("- Pages");
		expect(md).not.toContain("is of");
		// No page under a mark: the first lines say it.
		expect(md.match(/- Page: /g)).toHaveLength(1);
	});
});

describe("who did something, in a case synced with a team (DEC-039)", () => {
	const app = {
		id: "https://claude.ai/oauth",
		name: "Claude",
		host: "claude.ai",
	};
	const dana = { id: "u_dana", name: "Dana *Developer*" };
	const tess = { id: "u_tess", name: "Tess Tester" };
	const c: Case = {
		...flow(),
		annotations: [
			{
				...mark(1, "s1"),
				createdBy: tess,
				resolution: {
					kind: "fixed",
					at: "2026-11-19T10:00:00.000Z",
					app,
					user: dana,
					verified: { at: "2026-11-19T11:00:00.000Z", user: tess },
				},
				reopens: [
					{
						at: "2026-11-19T09:30:00.000Z",
						user: tess,
						note: "Still cut off",
						was: { kind: "fixed", at: "2026-11-19T09:00:00.000Z", user: dana },
					},
				],
				findings: [
					{
						id: "f_1",
						text: "The total wraps",
						app,
						at: "2026-11-19T09:10:00.000Z",
						user: dana,
					},
				],
			},
		],
	};

	test("the format keeps it through a file, and a build before it leaves it out without refusing", () => {
		const read = validateCase(JSON.parse(JSON.stringify(c)));
		expect(read.annotations[0]).toEqual(c.annotations[0] as Annotation);
		expect(() =>
			validateCase({
				...c,
				annotations: [{ ...c.annotations[0], createdBy: { id: 1 } }],
			}),
		).toThrow("case.annotations[0].createdBy.id: must be a string");
	});

	test("case.md says it, as text", () => {
		const md = caseMarkdown(c);
		expect(md).toContain("- Added by: Tess Tester");
		expect(md).toContain(
			"- Fixed: 2026-11-19T10:00:00.000Z, by Claude (claude.ai) for Dana \\*Developer\\*",
		);
		expect(md).toContain(
			"- Verified: 2026-11-19T11:00:00.000Z, by Tess Tester",
		);
		expect(md).toContain(
			"- Reopened 2026-11-19T09:30:00.000Z by Tess Tester, was Fixed:",
		);
		expect(md).toContain("By Claude (claude.ai) for Dana \\*Developer\\*, ");
	});
});

describe("what a draw found, judged for the page in front", () => {
	const match = (
		n: number,
		status: AnnotationMatch["status"],
	): AnnotationMatch => ({
		annotationId: `a${n}`,
		number: n,
		status,
		score: status === "found" ? 0.9 : 0,
		current: 0,
		candidates:
			status === "found"
				? [
						{
							score: 0.9,
							summary: "button",
							selector: "button",
							visible: true,
							found: true,
						},
					]
				: [],
	});
	const loaded = (url: string, matches: AnnotationMatch[]) => ({
		url,
		matches: new Map(matches.map((m) => [m.annotationId, m])),
	});

	test("on one of the case's pages, the marks of its other pages are not expected", () => {
		const c = flow();
		const all = [match(1, "found"), match(2, "no-element"), match(3, "lost")];
		const here = matchesHere(c, all, "http://localhost:3000/cart");
		expect(here.map((m) => m.number)).toEqual([1, 2]);
		expect(foundLine(c, loaded("http://localhost:3000/cart", all))).toBe(
			"1 of 2 marks found on localhost:3000/cart. Dashed: unsure. 1 more is on other pages of the case.",
		);
	});

	test("a mark of another page that is here all the same (a shared header) counts", () => {
		const c = flow();
		const all = [match(1, "found"), match(2, "no-element"), match(3, "found")];
		expect(
			matchesHere(c, all, "http://localhost:3000/cart").map((m) => m.number),
		).toEqual([1, 2, 3]);
	});

	test("none found is said of the page's own marks", () => {
		const c = flow();
		// On the payment page its mark is lost: none found there.
		const pay = [match(1, "lost"), match(2, "no-element"), match(3, "lost")];
		expect(
			noneFound(matchesHere(c, pay, "http://localhost:3000/checkout/pay")),
		).toBe(true);
		// Its mark is found: the cart's lost marks say nothing against the page.
		const found = [match(1, "lost"), match(2, "no-element"), match(3, "found")];
		expect(
			noneFound(matchesHere(c, found, "http://localhost:3000/checkout/pay")),
		).toBe(false);
		expect(
			foundLine(c, loaded("http://localhost:3000/checkout/pay", found)),
		).toBe(
			"1 of 1 marks found on localhost:3000/checkout/pay. 2 more are on other pages of the case.",
		);
	});

	test("on a page that is none of the case's, every mark is looked for", () => {
		const c = flow();
		const all = [match(1, "lost"), match(2, "no-element"), match(3, "lost")];
		const url = "http://localhost:3000/account";
		expect(matchesHere(c, all, url)).toHaveLength(3);
		expect(noneFound(matchesHere(c, all, url))).toBe(true);
	});
});
