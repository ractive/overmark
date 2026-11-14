import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Overlay } from "../src/content/overlay.ts";
import { LoadReplaced, NO_PANEL, Reviewer } from "../src/content/review.ts";
import type { Annotation, Case, Shape } from "../src/lib/case.ts";
import { describeElement } from "../src/lib/element.ts";
import type { MarkAnswer, MarkRequest } from "../src/lib/messages.ts";
import { isMarkRequest } from "../src/lib/messages.ts";
import { sampleCase } from "./fixtures.ts";

let doc: Document;
/** Puts happy-dom's own `getBoundingClientRect` back. */
let restoreLayout: () => void = () => undefined;
let overlay: ReturnType<typeof stubOverlay>;
let reviewer: Reviewer;
/** What the page asked of the side panel, and what the panel answers. */
let asked: MarkRequest[];
let answer: MarkAnswer;

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
		// The one popover, as the overlay keeps it.
		popover: document.createElement("div"),
		onPick: undefined as ((number: number) => void) | undefined,
		dismissed: undefined as (() => void) | undefined,
		placed: 0,
		openPopover(content: Node[], dismissed: () => void) {
			this.dismissPopover();
			this.dismissed = dismissed;
			this.popover.replaceChildren(...content);
			this.popover.hidden = false;
		},
		closePopover() {
			this.dismissed = undefined;
			this.popover.hidden = true;
			this.popover.replaceChildren();
		},
		dismissPopover() {
			const dismissed = this.dismissed;
			if (dismissed === undefined) return false;
			this.dismissed = undefined;
			dismissed();
			this.closePopover();
			return true;
		},
		placePopover() {
			this.placed++;
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
	asked = [];
	answer = { ok: true };
	reviewer = new Reviewer(overlay as unknown as Overlay, async (request) => {
		asked.push(request);
		return answer;
	});
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

	test("the bar's Hide stays the same element when the case is drawn again", async () => {
		doc.body.innerHTML = PAGE;
		const c = caseOf($("button"));
		await reviewer.load(c);
		const hide = overlay.reviewBar.querySelector('[data-action="review-hide"]');
		expect(hide).not.toBeNull();
		await reviewer.update({ ...c, title: "Renamed" });
		await reviewer.load(c);
		expect(overlay.reviewBar.querySelector('[data-action="review-hide"]')).toBe(
			hide,
		);
		expect(bar()).toContain("1 of 1 found");
		expect(
			overlay.reviewBar.querySelectorAll('[data-role="review-status"]'),
		).toHaveLength(1);
	});

	test("a clear while the case is loading stops the load: nothing is drawn after it", async () => {
		doc.body.innerHTML = PAGE;
		const c = caseOf($("button"));
		const loading = reviewer.load(c);
		// What case:clear for this case looks at while the load runs.
		expect(reviewer.caseId).toBeUndefined();
		expect(reviewer.loadingCaseId).toBe(c.id);
		reviewer.clear();
		await expect(loading).rejects.toBeInstanceOf(LoadReplaced);
		expect(overlay.reviewing).toBe(false);
		expect(overlay.items).toEqual([]);
		expect(reviewer.loadingCaseId).toBeUndefined();
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

describe("a loaded mark's pin clicked on the page (DEC-027)", () => {
	const PAGE = `<main><h1>Prämien</h1><button>Berechnen</button><p>Tipp</p></main>`;
	const field = () =>
		overlay.popover.querySelector("textarea") as HTMLTextAreaElement;
	const button = (action: string) =>
		overlay.popover.querySelector(
			`[data-action="${action}"]`,
		) as HTMLButtonElement;
	const settled = () => new Promise<void>((r) => setTimeout(r, 0));

	async function loaded(comment = "Too pale"): Promise<Case> {
		doc.body.innerHTML = PAGE;
		const c = caseOf($("button"));
		const marked = {
			...c,
			annotations: c.annotations.map((a) => ({ ...a, comment })),
		};
		await reviewer.load(marked);
		return marked;
	}

	test("its comment opens in the popover, its element is outlined, the panel is told", async () => {
		const c = await loaded();
		expect(overlay.onPick).toBeDefined();
		overlay.onPick?.(1);
		expect(overlay.popover.hidden).toBe(false);
		expect(field().value).toBe("Too pale");
		expect(field().getAttribute("aria-label")).toBe("Comment of mark 1");
		expect(overlay.popover.querySelector(".pin")?.textContent).toBe("1");
		expect(button("mark-delete").textContent).toBe("Delete mark");
		expect(button("mark-done").textContent).toBe("Done");
		expect(overlay.items[0]?.focused).toBe(true);
		expect(overlay.placed).toBeGreaterThan(0);
		expect(asked).toEqual([
			{ type: "mark:picked", caseId: c.id, annotationId: "a1" },
		]);
		// A second click on the same pin leaves what is being typed.
		field().value = "Typing";
		overlay.onPick?.(1);
		expect(field().value).toBe("Typing");
		expect(asked.length).toBe(1);
		// A number the case has no mark for opens nothing.
		reviewer.clear();
		overlay.onPick?.(1);
		expect(overlay.popover.hidden).toBe(true);
	});

	test("a mark that is not open says its status beside the label", async () => {
		const c = await loaded();
		const fixed = {
			...c,
			annotations: c.annotations.map((a) => ({
				...a,
				resolution: { kind: "fixed" as const, at: "2026-11-14T10:00:00Z" },
			})),
		};
		await reviewer.update(fixed);
		overlay.onPick?.(1);
		expect(overlay.popover.querySelector(".state")?.textContent).toBe(
			"Fixed, to verify",
		);
	});

	test("Done with the comment as it was asks nothing; a changed one is stored, then the popover goes", async () => {
		const c = await loaded();
		overlay.onPick?.(1);
		button("mark-done").click();
		await settled();
		expect(overlay.popover.hidden).toBe(true);
		expect(asked.length).toBe(1);

		overlay.onPick?.(1);
		field().value = "  Much too pale ";
		button("mark-done").click();
		// Off while the panel is asked: no second request.
		expect(button("mark-done").disabled).toBe(true);
		button("mark-done").click();
		await settled();
		expect(asked.at(-1)).toEqual({
			type: "mark:comment",
			caseId: c.id,
			annotationId: "a1",
			text: "Much too pale",
		});
		expect(asked.filter((r) => r.type === "mark:comment").length).toBe(1);
		expect(overlay.popover.hidden).toBe(true);
	});

	test("what could not be stored is said in the popover, which stays with the text", async () => {
		await loaded();
		overlay.onPick?.(1);
		answer = { ok: false, error: NO_PANEL };
		field().value = "Changed";
		button("mark-done").click();
		await settled();
		expect(overlay.popover.hidden).toBe(false);
		const problem = overlay.popover.querySelector(".problem") as HTMLElement;
		expect(problem.hidden).toBe(false);
		expect(problem.textContent).toBe(NO_PANEL);
		expect(problem.getAttribute("role")).toBe("alert");
		expect(field().value).toBe("Changed");
		expect(button("mark-done").disabled).toBe(false);
	});

	test("Delete mark asks twice, and not on a double click", async () => {
		const c = await loaded();
		overlay.onPick?.(1);
		const realNow = Date.now;
		let now = 1_000_000;
		Date.now = () => now;
		try {
			button("mark-delete").click();
			expect(button("mark-delete").textContent).toBe("Really delete?");
			expect(button("mark-delete").hasAttribute("data-armed")).toBe(true);
			// The second half of a double click.
			now += 100;
			button("mark-delete").click();
			await settled();
			expect(asked.some((r) => r.type === "mark:delete")).toBe(false);
			now += 1000;
			button("mark-delete").click();
			await settled();
		} finally {
			Date.now = realNow;
		}
		expect(asked.at(-1)).toEqual({
			type: "mark:delete",
			caseId: c.id,
			annotationId: "a1",
		});
		expect(overlay.popover.hidden).toBe(true);
	});

	test("Escape drops what was typed; a click beside it, or another popover, keeps it", async () => {
		const c = await loaded();
		overlay.onPick?.(1);
		field().value = "Dropped";
		field().dispatchEvent(
			new (doc.defaultView as unknown as Window).KeyboardEvent("keydown", {
				key: "Escape",
			}) as never,
		);
		expect(overlay.popover.hidden).toBe(true);
		expect(asked.some((r) => r.type === "mark:comment")).toBe(false);

		overlay.onPick?.(1);
		field().value = "Kept";
		// What the annotator does at a press beside the popover, or as it opens
		// a new mark's comment.
		expect(overlay.dismissPopover()).toBe(true);
		expect(overlay.popover.hidden).toBe(true);
		expect(asked.at(-1)).toEqual({
			type: "mark:comment",
			caseId: c.id,
			annotationId: "a1",
			text: "Kept",
		});
	});

	test("the popover goes with its mark, and with the case", async () => {
		const c = await loaded();
		overlay.onPick?.(1);
		// Another change of the case leaves it open.
		await reviewer.update({ ...c, title: "Renamed" });
		expect(overlay.popover.hidden).toBe(false);
		await reviewer.update({ ...c, annotations: [] });
		expect(overlay.popover.hidden).toBe(true);
		await reviewer.load(c);
		overlay.onPick?.(1);
		expect(overlay.popover.hidden).toBe(false);
		reviewer.clear();
		expect(overlay.popover.hidden).toBe(true);
	});

	test("only a mark's request with its fields is one", () => {
		const base = { caseId: "c_1", annotationId: "a1" };
		expect(isMarkRequest({ type: "mark:picked", ...base })).toBe(true);
		expect(isMarkRequest({ type: "mark:delete", ...base })).toBe(true);
		expect(isMarkRequest({ type: "mark:comment", ...base, text: "" })).toBe(
			true,
		);
		expect(isMarkRequest({ type: "mark:comment", ...base })).toBe(false);
		expect(isMarkRequest({ type: "mark:comment", ...base, text: 1 })).toBe(
			false,
		);
		expect(isMarkRequest({ type: "mark:delete", caseId: "c_1" })).toBe(false);
		expect(isMarkRequest({ type: "cases:changed", caseId: "c_1" })).toBe(false);
		expect(isMarkRequest(null)).toBe(false);
	});
});
