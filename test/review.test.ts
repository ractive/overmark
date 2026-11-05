import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Overlay } from "../src/content/overlay.ts";
import { Reviewer } from "../src/content/review.ts";
import type { Annotation, Case } from "../src/lib/case.ts";
import { describeElement } from "../src/lib/element.ts";
import { sampleCase } from "./fixtures.ts";

let doc: Document;
let overlay: ReturnType<typeof stubOverlay>;
let reviewer: Reviewer;

interface Item {
	number: number;
	found: boolean;
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

function caseOf(el: Element): Case {
	const annotation = {
		id: "a1",
		number: 1,
		element: describeElement(el),
	} as Annotation;
	return { ...sampleCase(), annotations: [annotation] };
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
