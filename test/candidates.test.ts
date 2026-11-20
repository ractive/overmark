import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
	createSearch,
	findCandidates,
	MAX_CANDIDATES,
} from "../src/lib/candidates.ts";
import type { ElementDetails } from "../src/lib/case.ts";
import {
	createContext,
	describeElement,
	headingsOf,
	legacyHeading,
} from "../src/lib/element.ts";

let doc: Document;

beforeEach(() => {
	const window = new Window({ url: "https://www.example.com/kk" });
	doc = window.document as unknown as Document;
});

const $ = (s: string) => doc.querySelector(s) as Element;

/** Compare elements without printing them: a happy-dom element is huge. */
const same = (a: unknown, b: unknown) => expect(a === b).toBe(true);

/** Give an element a size: happy-dom lays nothing out. */
function rendered(el: Element): void {
	el.getBoundingClientRect = () =>
		({ x: 0, y: 0, width: 100, height: 20 }) as DOMRect;
}

const find = (stored: ElementDetails, budgetMs?: number) =>
	findCandidates(
		createSearch(doc, budgetMs === undefined ? {} : { budgetMs }),
		stored,
	);

describe("findCandidates", () => {
	test("finds the element itself", () => {
		doc.body.innerHTML = `<main><h1>Prämien</h1><button>Berechnen</button></main>`;
		const found = find(describeElement($("button")));
		expect(found.status).toBe("found");
		same(found.candidates[0]?.element, $("button"));
		expect(found.truncated).toBe(false);
	});

	test("a lost element has no candidates", () => {
		doc.body.innerHTML = `<main><button>Berechnen</button><a href="/kontakt">Kontakt</a></main>`;
		const stored = describeElement($("button"));
		$("button").remove();
		const found = find(stored);
		expect(found.status).toBe("lost");
		expect(found.candidates).toEqual([]);
	});

	describe("two tied elements", () => {
		const PAGE = `<main><section><p>Bis zu 1500 Franken sparen</p></section><section><p>Bis zu 1500 Franken sparen</p></section></main>`;
		const copies = () => {
			const [first, second] = doc.querySelectorAll("p");
			return [first, second] as [Element, Element];
		};

		test.each([0, 1])("the only visible one wins (copy %d)", (visible) => {
			doc.body.innerHTML = PAGE;
			const stored = describeElement(copies()[0]);
			const shown = copies()[visible] as Element;
			rendered(shown);
			const found = find(stored);
			expect(found.status).toBe("found");
			same(found.candidates[0]?.element, shown);
		});

		test("the visible one stays probable when its score is", () => {
			doc.body.innerHTML = PAGE;
			const stored: ElementDetails = {
				...describeElement(copies()[0]),
				classes: ["Tip_text"],
				attributes: { title: "Tipp" },
				heading: "Sparen",
			};
			rendered(copies()[1]);
			const found = find(stored);
			expect(found.status).toBe("probable");
			same(found.candidates[0]?.element, copies()[1]);
		});

		test("both visible or both hidden stay ambiguous", () => {
			doc.body.innerHTML = PAGE;
			const stored = describeElement(copies()[0]);
			expect(find(stored).status).toBe("ambiguous");
			for (const copy of copies()) rendered(copy);
			const found = find(stored);
			expect(found.status).toBe("ambiguous");
			same(found.candidates[0]?.element, copies()[0]);
			same(found.candidates[1]?.element, copies()[1]);
		});
	});

	describe("the whole page", () => {
		function changedTag(): ElementDetails {
			doc.body.innerHTML = `<main><aside class="Tip_box">Mit einer Franchise sparen</aside></main>`;
			const stored = describeElement($("aside"));
			doc.body.innerHTML = `<main><div class="Tip_box">Mit einer Franchise sparen</div></main>`;
			return stored;
		}

		test("is searched when no likely element is even probable", () => {
			const found = find(changedTag());
			expect(found.status).toBe("probable");
			same(found.candidates[0]?.element, $(".Tip_box"));
			expect(found.truncated).toBe(false);
		});

		test("is not searched out of time, and that is reported", () => {
			const found = find(changedTag(), 0);
			expect(found.status).toBe("lost");
			expect(found.truncated).toBe(true);
		});

		test("reports when it had too many elements to score them all", () => {
			const stored = changedTag();
			doc.body.innerHTML = "<i></i>".repeat(MAX_CANDIDATES + 1);
			const found = find(stored);
			expect(found.status).toBe("lost");
			expect(found.truncated).toBe(true);
		});
	});

	test("the cut to MAX_CANDIDATES keeps a test id's element", () => {
		doc.body.innerHTML = `<div data-testid="save-button">Speichern</div>`;
		const stored = describeElement($("div"));
		doc.body.innerHTML = `${"<div></div>".repeat(MAX_CANDIDATES + 200)}<div data-testid="save-button">Speichern</div>`;
		const found = find(stored);
		expect(found.status).toBe("found");
		same(found.candidates[0]?.element, $("[data-testid=save-button]"));
		expect(found.truncated).toBe(true);
	});

	test("the cut to MAX_CANDIDATES keeps a role's element", () => {
		doc.body.innerHTML = `<div role="alert">Abgelaufen</div>`;
		const stored = describeElement($("div"));
		doc.body.innerHTML = `${"<div></div>".repeat(MAX_CANDIDATES + 200)}<div role="alert">Abgelaufen</div>`;
		same(find(stored).candidates[0]?.element, $("[role=alert]"));
	});

	describe("a repeated test id or id", () => {
		const row = (name: string) =>
			`<li data-testid="result-row" class="Row_root">${name}</li>`;

		test("is no identity: the neighbour of a removed row is lost", () => {
			doc.body.innerHTML = `<ul>${row("Helsana Basis")}${row("Sanitas Compact")}${row("CSS Standard")}</ul>`;
			const stored = describeElement($("li"));
			$("li").remove();
			expect(find(stored).status).toBe("lost");
		});

		test("still finds its own row by its text", () => {
			doc.body.innerHTML = `<ul>${row("Helsana Basis")}${row("Sanitas Compact")}</ul>`;
			const stored = describeElement($("li:nth-of-type(2)"));
			const found = find(stored);
			expect(found.status).toBe("found");
			same(found.candidates[0]?.element, $("li:nth-of-type(2)"));
		});

		test("the same goes for an id", () => {
			doc.body.innerHTML = `<main><p id="note">Prämien steigen</p><p id="note">Kontakt aufnehmen</p></main>`;
			const stored = describeElement($("p"));
			$("p").remove();
			doc.body.insertAdjacentHTML("beforeend", `<p id="note">Lieferzeiten</p>`);
			expect(find(stored).status).toBe("lost");
		});

		test("a unique one outweighs rewritten text", () => {
			doc.body.innerHTML = `<main><button data-testid="calc">Berechnen</button><button>Abbrechen</button></main>`;
			const stored = describeElement($("button"));
			$("button").textContent = "Jetzt rechnen";
			const found = find(stored);
			expect(found.status).toBe("found");
			same(found.candidates[0]?.element, $("[data-testid=calc]"));
		});
	});

	describe("an element without identity", () => {
		test("another image is no more than probable", () => {
			doc.body.innerHTML = `<main><section><img src="/a.png" /><img src="/b.png" /></section></main>`;
			const stored = describeElement($("img"));
			$("img").remove();
			const found = find(stored);
			expect(found.status).not.toBe("found");
			expect(found.candidates[0]?.found).toBe(false);
		});

		test("an icon's path is no more than probable", () => {
			doc.body.innerHTML = `<header><svg><path d="M0 0"></path></svg></header>`;
			const stored = describeElement($("path"));
			expect(find(stored).status).toBe("probable");
		});

		test("an image's own file identifies it", () => {
			doc.body.innerHTML = `<main><img src="/a.png" /><img src="/b.png" /></main>`;
			const stored = describeElement($("img"));
			const found = find(stored);
			expect(found.status).toBe("found");
			same(found.candidates[0]?.element, $("img"));
		});

		test("a repeated file does not", () => {
			doc.body.innerHTML = `<main><img src="/star.png" /><img src="/star.png" /><img src="/star.png" /></main>`;
			const stored = describeElement($("img"));
			$("img").remove();
			const found = find(stored);
			expect(found.status).not.toBe("found");
			expect(found.candidates[0]?.found).toBe(false);
		});

		test("a link's own address identifies it", () => {
			doc.body.innerHTML = `<nav><a href="/konto"><svg></svg></a><a href="/hilfe"><svg></svg></a></nav>`;
			const stored = describeElement($("a"));
			const found = find(stored);
			expect(found.status).toBe("found");
			same(found.candidates[0]?.element, $("a"));
		});
	});

	describe("a test id past the limit", () => {
		const long = "t".repeat(350);

		test("is found by its cut value, even for another tag", () => {
			doc.body.innerHTML = `<main><a data-testid="${long}" href="/go">Weiter</a></main>`;
			const stored = describeElement($("a"));
			expect(stored.testId).toBe(long.slice(0, 300));
			doc.body.innerHTML = `<main><button data-testid="${long}">Weiter</button></main>`;
			same(find(stored, 0).candidates[0]?.element, $("button"));
		});

		test("stored whole in an older case, it meets the cut one", () => {
			doc.body.innerHTML = `<main><button data-testid="${long}">Weiter</button></main>`;
			const stored = { ...describeElement($("button")), testId: long };
			const found = find(stored);
			expect(found.status).toBe("found");
			expect(found.score).toBe(1);
		});
	});

	describe("shadow roots", () => {
		const closed = new Map<Element, ShadowRoot>();

		beforeEach(() => {
			closed.clear();
			Object.assign(globalThis, {
				chrome: {
					dom: {
						openOrClosedShadowRoot: (el: Element) => closed.get(el) ?? null,
					},
				},
			});
		});

		afterEach(() => {
			delete (globalThis as { chrome?: unknown }).chrome;
		});

		const component = (mode: ShadowRootMode, inner: string) => {
			const host = doc.createElement("app-card");
			(doc.querySelector("main") ?? doc.body).append(host);
			const root = host.attachShadow({ mode });
			root.innerHTML = inner;
			if (mode === "closed") closed.set(host, root);
			return root;
		};

		test.each<ShadowRootMode>(["open", "closed"])(
			"an element in a shadow root is found there (%s)",
			(mode) => {
				const root = component(
					mode,
					`<section><button class="Save_root">Speichern</button></section>`,
				);
				const stored = describeElement(root.querySelector("button") as Element);
				const found = find(stored);
				expect(found.status).toBe("found");
				same(
					found.candidates[0]?.element,
					root.querySelector("button") as Element,
				);
			},
		);

		test("a root inside a root is walked too", () => {
			const root = component("open", `<app-inner></app-inner>`);
			const inner = (root.querySelector("app-inner") as Element).attachShadow({
				mode: "open",
			});
			inner.innerHTML = `<button>Speichern</button>`;
			const stored = describeElement(inner.querySelector("button") as Element);
			same(
				find(stored).candidates[0]?.element,
				inner.querySelector("button") as Element,
			);
		});

		test("the whole-page search goes in as well", () => {
			doc.body.innerHTML = `<main><aside class="Tip_box" title="Tipp">Mit einer Franchise sparen</aside></main>`;
			const stored = describeElement($("aside"));
			doc.body.innerHTML = "<main></main>";
			const root = component(
				"open",
				`<div class="Tip_box" title="Tipp">Mit einer Franchise sparen</div>`,
			);
			same(
				find(stored).candidates[0]?.element,
				root.querySelector("div") as Element,
			);
		});

		test("Sitegloss's own shadow root is left out", () => {
			const root = component("open", `<button>Speichern</button>`);
			const stored = describeElement(root.querySelector("button") as Element);
			const search = createSearch(doc, { exclude: root.host });
			expect(findCandidates(search, stored).status).toBe("lost");
		});
	});
});

describe("a large page (DEC-047)", () => {
	test("hundreds of headings in one card and a long list without any: the heading costs no more than the old rule's search", () => {
		// Each part's heading is inside a section the list is not in: the
		// search for the card's title has to pass them all, and gives up.
		const sections = Array.from(
			{ length: 300 },
			(_, i) => `<section><h3>Part ${i}</h3><p>Text ${i}</p></section>`,
		).join("");
		const items = Array.from(
			{ length: 600 },
			(_, i) => `<li><span>Item ${i}</span></li>`,
		).join("");
		doc.body.innerHTML = `<article class="card">${sections}<ul>${items}</ul><h2>Everything</h2></article>`;
		const all = [...doc.body.querySelectorAll("*")];
		const context = createContext(doc);
		let started = performance.now();
		for (const el of all) legacyHeading(el, context.headings);
		const old = performance.now() - started;
		started = performance.now();
		for (const el of all) headingsOf(el, context.headings, context.containers);
		const now = performance.now() - started;
		// The old rule is a binary search; the walk on top of it is bounded.
		expect(now).toBeLessThan(old * 2 + 100);
		// And it gave up on the list, with the nearest heading before.
		expect(headingsOf($("li span"), context.headings).heading).toBe("Part 299");
	});

	test("the deadline stops a scan while it describes, not only before it", () => {
		doc.body.innerHTML = `<main>${Array.from({ length: 4000 }, (_, i) => `<p>Text ${i}</p>`).join("")}</main>`;
		const stored: ElementDetails = {
			...describeElement($("p")),
			tag: "x-gone",
			text: "Nowhere at all",
		};
		const search = createSearch(doc, { budgetMs: 5 });
		const started = performance.now();
		const found = findCandidates(search, stored);
		expect(found.truncated).toBe(true);
		expect(performance.now() - started).toBeLessThan(1500);
	});
});
