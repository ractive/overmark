import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Overlay } from "../src/content/overlay.ts";
import { Reviewer } from "../src/content/review.ts";
import type { Annotation, Case, Shape } from "../src/lib/case.ts";
import { describeElement } from "../src/lib/element.ts";
import { sampleCase } from "./fixtures.ts";

let doc: Document;
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
	// happy-dom lays nothing out.
	window.Element.prototype.getBoundingClientRect = () =>
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
