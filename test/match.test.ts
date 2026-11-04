import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Window } from "happy-dom";
import type { ElementDetails } from "../src/lib/case.ts";
import { createContext, describeElement } from "../src/lib/element.ts";
import { classify, rank, score, textSimilarity } from "../src/lib/match.ts";

async function load(page: string): Promise<Document> {
	const html = await Bun.file(join(import.meta.dir, "e2e/pages", page)).text();
	const window = new Window({ url: "https://www.example.com/kk" });
	const doc = window.document as unknown as Document;
	doc.write(html);
	return doc;
}

function details(doc: Document): {
	elements: Element[];
	all: ElementDetails[];
} {
	const context = createContext(doc);
	const elements = [...doc.body.querySelectorAll("*")];
	return { elements, all: elements.map((e) => describeElement(e, context)) };
}

describe("textSimilarity", () => {
	test("is 1 for the same text and lower for changed text", () => {
		expect(textSimilarity("Prämien  berechnen", "prämien berechnen")).toBe(1);
		const changed = textSimilarity(
			"Prämien berechnen",
			"Prämien jetzt berechnen",
		);
		expect(changed).toBeGreaterThan(0.7);
		expect(changed).toBeLessThan(1);
		expect(textSimilarity("Kontakt", "Hypotheken")).toBeLessThan(0.3);
		expect(textSimilarity("", "a")).toBe(0);
	});
});

describe("matching v1 marks on v2", () => {
	test.each([
		["submit", "the button whose text the fix changed"],
		["tip", "the tip that moved above the form"],
		["contact", "the contact paragraph next to a new one"],
	])("%s: %s", async (truth) => {
		const v1 = await load("v1.html");
		const v2 = await load("v2.html");
		const stored = describeElement(
			v1.querySelector(`[data-truth=${truth}]`) as Element,
		);
		const { elements, all } = details(v2);
		const ranked = rank(stored, all);
		const best = ranked[0];
		expect(best).toBeDefined();
		expect(elements[best?.index ?? -1]?.getAttribute("data-truth")).toBe(truth);
		expect(classify(ranked)).not.toBe("lost");
		expect(classify(ranked)).not.toBe("ambiguous");
	});

	test("an element that is gone is lost", async () => {
		const v1 = await load("v1.html");
		const stored = describeElement(v1.querySelector("footer") as Element);
		const v2 = await load("v2.html");
		v2.querySelector("footer")?.remove();
		const ranked = rank(stored, details(v2).all);
		expect(classify(ranked)).toBe("lost");
	});

	test.each([
		[
			"a paragraph",
			`<main><h2>Prices</h2><p data-gone>Prices rise by 3% in 2027.</p><p>Compare them with last year to see the change.</p></main>`,
			"p[data-gone]",
		],
		[
			"a list item",
			`<main><ul><li data-gone>Free cancellation</li><li>Online support around the clock</li></ul></main>`,
			"li[data-gone]",
		],
		[
			"a button",
			`<main><form><button data-gone type="button">Delete account</button><button type="button">Edit profile</button></form></main>`,
			"button[data-gone]",
		],
	])("%s removed by the fix is lost, not its sibling", (_name, html, gone) => {
		const window = new Window({ url: "https://www.example.com/kk" });
		const v1 = window.document as unknown as Document;
		v1.body.innerHTML = html;
		const stored = describeElement(v1.querySelector(gone) as Element);
		v1.querySelector(gone)?.remove();
		expect(classify(rank(stored, details(v1).all))).toBe("lost");
	});

	test("two identical elements are a tie", () => {
		const base: ElementDetails = {
			tag: "p",
			text: "Hallo",
			classes: [],
			attributes: {},
			ancestors: ["main"],
			rect: { x: 0, y: 0, width: 0, height: 0 },
			page: { width: 0, height: 0 },
			selector: "p",
		};
		const ranked = rank(base, [base, { ...base }]);
		expect(ranked[0]?.score).toBe(1);
		expect(classify(ranked)).toBe("ambiguous");
	});

	test("a test id outweighs changed text and classes", () => {
		const stored: ElementDetails = {
			tag: "button",
			testId: "calc",
			text: "Berechnen",
			classes: ["Button_primary"],
			attributes: { type: "submit" },
			ancestors: ["form"],
			rect: { x: 0, y: 0, width: 0, height: 0 },
			page: { width: 0, height: 0 },
			selector: '[data-testid="calc"]',
		};
		const moved = {
			...stored,
			text: "Jetzt rechnen",
			classes: ["Cta_root"],
			ancestors: ["div", "form"],
		};
		const other = { ...stored, testId: "reset", text: "Berechnen" };
		expect(score(stored, moved)).toBeGreaterThan(score(stored, other));
	});
});
