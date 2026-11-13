import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Overlay } from "../src/content/overlay.ts";
import { LoadReplaced, Reviewer } from "../src/content/review.ts";
import type { Annotation, Case, Shape } from "../src/lib/case.ts";
import { describeElement } from "../src/lib/element.ts";
import { sampleCase } from "./fixtures.ts";

let doc: Document;
/** Puts happy-dom's own `getBoundingClientRect` back. */
let restoreLayout: () => void = () => undefined;
let overlay: ReturnType<typeof stubOverlay>;
let reviewer: Reviewer;

interface Item {
	number: number;
	shape: Shape;
	found: boolean;
	focused: boolean;
}

/** What the reviewer uses of the overlay. */
function stubOverlay(document: Document) {
	return {
		doc: document,
		host: document.createElement("div"),
		reviewBar: document.createElement("div"),
		reviewing: false,
		items: [] as readonly Item[],
		setReviewing(on: boolean) {
			this.reviewing = on;
		},
		renderReview(items: readonly Item[]) {
			this.items = items;
		},
	};
}

beforeEach(() => {
	const window = new Window({ url: "https://www.example.com/kk" });
	doc = window.document as unknown as Document;
	// happy-dom lays nothing out. Its windows share one Element class, so
	// what is put on the prototype here is taken off again after each test:
	// left there, every element of a test file that runs later has a size.
	const proto = window.Element.prototype;
	const layout = proto.getBoundingClientRect;
	restoreLayout = () => {
		proto.getBoundingClientRect = layout;
	};
	proto.getBoundingClientRect = () =>
		({ x: 0, y: 0, width: 100, height: 20 }) as never;
	Object.assign(globalThis, {
		location: window.location,
		requestAnimationFrame: (run: () => void) => setTimeout(run, 0),
	});
	overlay = stubOverlay(doc);
	reviewer = new Reviewer(overlay as unknown as Overlay);
});

afterEach(() => {
	reviewer.clear();
	restoreLayout();
});

const $ = (s: string) => doc.querySelector(s) as Element;
const bar = () =>
	overlay.reviewBar.querySelector("[data-role=review-status]")?.textContent;

const shot = (id: string, scrollY = 0, url?: string) => ({
	id,
	image: `shots/${id}.webp`,
	scrollX: 0,
	scrollY,
	viewport: { width: 1280, height: 800, dpr: 2 },
	capturedAt: "2026-11-04T10:00:00Z",
	...(url ? { url } : {}),
});

function caseOf(el: Element): Case {
	const element = describeElement(el);
	const annotation = {
		id: "a1",
		number: 1,
		shot: "s1",
		shape: { kind: "element", rect: element.rect },
		element,
	} as Annotation;
	return { ...sampleCase(), shots: [shot("s1")], annotations: [annotation] };
}

describe("elements replaced after loading", () => {
	const PAGE = `<main><h1>Prämien</h1><button>Berechnen</button></main>`;

	test("a re-render: showing finds the new element and outlines it", async () => {
		doc.body.innerHTML = PAGE;
		await reviewer.load(caseOf($("button")));
		expect(overlay.items.length).toBe(1);
		const old = $("button");
		$("main").innerHTML = `<h1>Prämien</h1><button>Berechnen</button>`;
		expect(old.isConnected).toBe(false);
		const match = reviewer.show("a1");
		expect(match?.status).toBe("found");
		expect(overlay.items.length).toBe(1);
		expect(bar()).toContain("1 of 1 found");
	});

	test("gone for good: showing says so", async () => {
		doc.body.innerHTML = PAGE;
		await reviewer.load(caseOf($("button")));
		$("button").remove();
		const match = reviewer.show("a1");
		expect(match?.status).toBe("lost");
		expect(match?.candidates).toEqual([]);
		expect(overlay.items.length).toBe(0);
		expect(bar()).toContain("0 of 1 found");
	});

	test("the review bar and the outlines follow without a click", async () => {
		doc.body.innerHTML = PAGE;
		await reviewer.load(caseOf($("button")));
		const old = $("button");
		$("main").innerHTML = `<h1>Prämien</h1><button>Berechnen</button>`;
		await Bun.sleep(700);
		expect(old.isConnected).toBe(false);
		expect(overlay.items.length).toBe(1);
		$("button").remove();
		await Bun.sleep(700);
		expect(bar()).toContain("0 of 1 found");
		expect(overlay.items.length).toBe(0);
	});

	test("an element still on the page is not searched for again", async () => {
		doc.body.innerHTML = PAGE;
		await reviewer.load(caseOf($("button")));
		$("button").textContent = "Jetzt berechnen und vergleichen";
		expect(reviewer.show("a1")?.score).toBe(1);
	});
});

describe("a drawn mark", () => {
	/** A case of one mark drawn on an element, which was at `rect`. */
	function drawnOn(el: Element, shape: Shape, scrollY = 0): Case {
		const c = caseOf(el);
		const a = c.annotations[0] as Annotation;
		const element = a.element as NonNullable<Annotation["element"]>;
		const rect = { x: 500, y: 1000, width: 200, height: 40 };
		return {
			...c,
			shots: [shot("s1", scrollY)],
			annotations: [{ ...a, shape, element: { ...element, rect } }],
		};
	}

	test("goes on its element, moved and scaled with it", async () => {
		doc.body.innerHTML = `<button>Berechnen</button>`;
		// In the shot, scrolled by 900: y 110 is 1010 on the page.
		const rect = { x: 550, y: 110, width: 100, height: 20 };
		await reviewer.load(drawnOn($("button"), { kind: "box", rect }, 900));
		// The element is at 0, 0 and 100×20 now: half as wide and high.
		expect(overlay.items[0]?.shape).toEqual({
			kind: "box",
			rect: { x: 25, y: 5, width: 50, height: 10 },
		});
	});

	test("an element's mark stays the element's box", async () => {
		doc.body.innerHTML = `<button>Berechnen</button>`;
		await reviewer.load(caseOf($("button")));
		expect(overlay.items[0]?.shape).toEqual({
			kind: "element",
			rect: { x: 0, y: 0, width: 100, height: 20 },
		});
	});

	/** A case of one mark without an element, on a shot of `url`. */
	function withoutElement(url?: string): Case {
		const shape = { kind: "note", at: { x: 40, y: 50 } } as const;
		const annotation = {
			id: "a1",
			number: 1,
			shot: "s1",
			shape,
			element: null,
		} as Annotation;
		return {
			...sampleCase(),
			shots: [shot("s1", 100, url)],
			annotations: [annotation],
		};
	}

	test("without an element goes where it was, unconfirmed", async () => {
		await reviewer.load(withoutElement());
		expect(overlay.items[0]?.shape).toEqual({
			kind: "note",
			at: { x: 40, y: 150 },
		});
		expect(overlay.items[0]?.found).toBe(false);
	});

	test("without an element Show scrolls to it", async () => {
		const win = doc.defaultView as unknown as Window;
		const scrolled: ScrollToOptions[] = [];
		win.scrollTo = ((to: ScrollToOptions) => {
			scrolled.push(to);
		}) as typeof win.scrollTo;
		await reviewer.load(withoutElement());
		reviewer.show("a1");
		expect(scrolled[0]?.top).toBe(150 - win.innerHeight / 2);
		await Bun.sleep(10);
		expect(overlay.items[0]?.focused).toBe(true);
	});

	test("without an element stays off another route's page", async () => {
		await reviewer.load(withoutElement("https://www.example.com/hypo"));
		expect(overlay.items.length).toBe(0);
	});
});

describe("the outline", () => {
	test("is not green for an element without identity", async () => {
		doc.body.innerHTML = `<main><img src="/a.png" /><img src="/b.png" /></main>`;
		const c = caseOf($("img"));
		$("img").remove();
		await reviewer.load(c);
		expect(overlay.items.length).toBe(1);
		expect(overlay.items[0]?.found).toBe(false);
	});

	test("is green for a found element", async () => {
		doc.body.innerHTML = `<main><button>Berechnen</button></main>`;
		await reviewer.load(caseOf($("button")));
		expect(overlay.items[0]?.found).toBe(true);
	});
});

describe("a loaded case that changes", () => {
	const PAGE = `<main><h1>Prämien</h1><button>Berechnen</button><p>Kontakt</p></main>`;
	function twoMarks(): Case {
		const mark = (id: string, n: number, el: Element): Annotation => {
			const element = describeElement(el);
			return {
				id,
				number: n,
				shot: "s1",
				comment: "",
				author: "user",
				shape: { kind: "element", rect: element.rect },
				crop: `crops/${id}.webp`,
				element,
			};
		};
		return {
			...sampleCase(),
			shots: [shot("s1")],
			annotations: [mark("a1", 1, $("button")), mark("a2", 2, $("p"))],
		};
	}

	test("a closed mark is drawn settled, no longer counted, its candidate kept", async () => {
		doc.body.innerHTML = PAGE;
		const c = twoMarks();
		await reviewer.load(c);
		reviewer.show("a1", 0);
		const settled = {
			...c,
			annotations: c.annotations.map((a) =>
				a.id === "a2"
					? { ...a, resolution: { kind: "wontfix" as const, at: "now" } }
					: a,
			),
		};
		const result = await reviewer.update(settled);
		expect(result?.matches.map((m) => m.annotationId)).toEqual(["a1", "a2"]);
		expect(
			(overlay.items as unknown as { status: string }[]).map((i) => i.status),
		).toEqual(["open", "wontfix"]);
		expect(bar()).toContain("1 of 1 found");
		expect(bar()).not.toContain("to verify");
	});

	test("a mark to verify is counted and said; all settled says so", async () => {
		doc.body.innerHTML = PAGE;
		const c = twoMarks();
		await reviewer.load(c);
		const fixed = {
			...c,
			annotations: c.annotations.map((a) =>
				a.id === "a2"
					? { ...a, resolution: { kind: "fixed" as const, at: "now" } }
					: a,
			),
		};
		await reviewer.update(fixed);
		expect(
			(overlay.items as unknown as { status: string }[]).map((i) => i.status),
		).toEqual(["open", "fixed"]);
		expect(bar()).toBe(`${c.title}·2 of 2 found · 1 to verify`);
		const done = {
			...c,
			annotations: c.annotations.map((a) => ({
				...a,
				resolution: {
					kind: "fixed" as const,
					at: "now",
					verified: { at: "now" },
				},
			})),
		};
		await reviewer.update(done);
		expect(
			(overlay.items as unknown as { status: string }[]).map((i) => i.status),
		).toEqual(["verified", "verified"]);
		expect(bar()).toContain("all verified or closed");
	});

	test("a deleted mark leaves; another case is not touched", async () => {
		doc.body.innerHTML = PAGE;
		const c = twoMarks();
		await reviewer.load(c);
		const result = await reviewer.update({
			...c,
			annotations: [c.annotations[0] as Annotation],
		});
		expect(result?.matches.length).toBe(1);
		expect(overlay.items.length).toBe(1);
		expect(await reviewer.update({ ...c, id: "c_other" })).toBeNull();
	});

	test("a replaced copy giving an id to another mark: that one is looked for anew", async () => {
		doc.body.innerHTML = PAGE;
		const c = twoMarks();
		await reviewer.load(c);
		const [first, second] = c.annotations as [Annotation, Annotation];
		// a2 now marks the heading, as a file imported over it says.
		const h1 = describeElement($("h1"));
		const replaced = {
			...c,
			annotations: [
				first,
				{
					...second,
					element: h1,
					shape: { kind: "element" as const, rect: h1.rect },
				},
			],
		};
		const result = await reviewer.update(replaced);
		expect(result?.matches[1]?.candidates[0]?.selector).toBe(
			describeElement($("h1")).selector,
		);
	});

	test("a change while the case still loads is drawn once the load ends", async () => {
		doc.body.innerHTML = PAGE;
		const c = twoMarks();
		const loading = reviewer.load(c);
		expect(
			await reviewer.update({
				...c,
				annotations: [c.annotations[0] as Annotation],
			}),
		).toBeNull();
		const result = await loading;
		expect(result.matches.length).toBe(1);
		expect(overlay.items.length).toBe(1);
	});
});

describe("loads close together", () => {
	const PAGE = `<main><h1>Prämien</h1><button>Berechnen</button></main>`;

	test("two loads of one case both end with the newer one's result", async () => {
		doc.body.innerHTML = PAGE;
		const c = caseOf($("button"));
		const first = reviewer.load(c);
		const second = reviewer.load(c);
		const [a, b] = await Promise.all([first, second]);
		expect(b.matches.map((m) => m.status)).toEqual(["found"]);
		// The older one's is the newer's, and says so: its marks are that
		// load's, not this caller's to take off.
		expect(a).toEqual({ ...b, adopted: true });
		expect(b.adopted).toBeUndefined();
		expect(reviewer.caseId).toBe(c.id);
	});

	test("a clear during a load stops it: replaced, no failure", async () => {
		doc.body.innerHTML = PAGE;
		const c = caseOf($("button"));
		const loading = reviewer.load(c);
		reviewer.clear();
		await expect(loading).rejects.toBeInstanceOf(LoadReplaced);
		expect(reviewer.caseId).toBeUndefined();
	});

	test("another case's load stops the one before: replaced", async () => {
		doc.body.innerHTML = PAGE;
		const c = caseOf($("button"));
		const other = { ...caseOf($("h1")), id: "c_other" };
		const first = reviewer.load(c);
		const second = reviewer.load(other);
		await expect(first).rejects.toBeInstanceOf(LoadReplaced);
		expect((await second).caseId).toBe("c_other");
	});

	test("a change during the second of two loads is drawn once it ends", async () => {
		doc.body.innerHTML = PAGE;
		const one = caseOf($("button"));
		const c: Case = {
			...one,
			annotations: [
				...one.annotations,
				{ ...(one.annotations[0] as Annotation), id: "a2", number: 2 },
			],
		};
		const first = reviewer.load(c);
		const second = reviewer.load(c);
		expect(
			await reviewer.update({
				...c,
				annotations: [c.annotations[0] as Annotation],
			}),
		).toBeNull();
		expect((await second).matches.length).toBe(1);
		expect((await first).matches.length).toBe(1);
	});
});

describe("a load that draws a newer copy at its end", () => {
	const PAGE = `<main><h1>Prämien</h1><button>Berechnen</button><a href="#">Link</a><p>Text hier</p></main>`;
	const withMarks = (base: Case, ...selectors: string[]): Case => ({
		...base,
		annotations: [
			...base.annotations,
			...selectors.map((sel, i) => ({
				...(base.annotations[0] as Annotation),
				id: `a${i + 2}`,
				number: i + 2,
				element: describeElement($(sel)),
			})),
		],
	});
	/** Until the load has found its marks and turns to the newer copy. */
	const found = async () => {
		while (reviewer.caseId === undefined)
			await new Promise((r) => setTimeout(r, 0));
	};

	test("a clear while it draws the newer copy: replaced, not its first result", async () => {
		doc.body.innerHTML = PAGE;
		const c = caseOf($("button"));
		const loading = reviewer.load(c);
		expect(await reviewer.update(withMarks(c, "a", "p"))).toBeNull();
		await found();
		reviewer.clear();
		await expect(loading).rejects.toBeInstanceOf(LoadReplaced);
	});

	test("a newer load while it draws the newer copy: both end with the newest", async () => {
		doc.body.innerHTML = PAGE;
		const c = caseOf($("button"));
		const newer = withMarks(c, "a", "p");
		const loading = reviewer.load(c);
		expect(await reviewer.update(newer)).toBeNull();
		await found();
		const again = reviewer.load(newer);
		expect((await again).matches.length).toBe(3);
		expect((await loading).matches.length).toBe(3);
	});
});
