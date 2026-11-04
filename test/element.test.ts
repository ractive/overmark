import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
	accessibleName,
	cssSelector,
	describeElement,
	headingAbove,
	landmarkOf,
	roleOf,
	summarize,
} from "../src/lib/element.ts";

let doc: Document;

const PAGE = `
<header class="Header_root__a1B2c">
	<nav aria-label="Hauptmenü">
		<a class="Nav_link__x9Y8z" href="/versicherungen">Versicherungen</a>
		<a class="Nav_link__x9Y8z" href="https://example.com/login?x=1">Anmelden</a>
	</nav>
</header>
<main>
	<h1 class="Hero_title__Q7r2s">Krankenkassen vergleichen</h1>
	<form id=":r3:" class="Form_root__k3L9m">
		<label>Postleitzahl <input name="zip" placeholder="z.B. 8000" value="8001" /></label>
		<input id="year" name="year" aria-label="Jahrgang" />
		<button class="Button_primary__p4T6u sc-bdVaJa" type="submit">Prämien   berechnen</button>
		<button data-testid="reset" type="reset">Zurücksetzen</button>
	</form>
	<section aria-label="Tipps">
		<h2>Tipps zum Sparen</h2>
		<p>Mit einer höheren Franchise sparen Sie.</p>
		<p>Mit einer höheren Franchise sparen Sie.</p>
		<img src="/img/tip.png?v=2" alt="Sparschwein" />
	</section>
</main>`;

beforeEach(() => {
	const window = new Window({ url: "https://www.example.com/kk" });
	doc = window.document as unknown as Document;
	doc.body.innerHTML = PAGE;
});

const $ = (s: string) => doc.querySelector(s) as Element;

describe("roles and names", () => {
	test("implicit roles", () => {
		expect(roleOf($("nav"))).toBe("navigation");
		expect(roleOf($("header"))).toBe("banner");
		expect(roleOf($("a"))).toBe("link");
		expect(roleOf($("button"))).toBe("button");
		expect(roleOf($("input[name=zip]"))).toBe("textbox");
		expect(roleOf($("h1"))).toBe("heading");
		expect(roleOf($("section"))).toBe("region");
	});

	test("accessible names, never a typed value", () => {
		expect(accessibleName($("input[name=zip]"))).toBe("Postleitzahl");
		expect(accessibleName($("#year"))).toBe("Jahrgang");
		expect(accessibleName($("button"))).toBe("Prämien berechnen");
		expect(accessibleName($("img"))).toBe("Sparschwein");
		expect(accessibleName($("nav"))).toBe("Hauptmenü");
	});

	test("landmarks and headings", () => {
		expect(landmarkOf($("a"))).toBe("navigation: Hauptmenü");
		expect(landmarkOf($("button"))).toBe("form");
		const headings = [...doc.querySelectorAll("h1, h2")];
		expect(headingAbove($("button"), headings)).toBe(
			"Krankenkassen vergleichen",
		);
		expect(headingAbove($("section p"), headings)).toBe("Tipps zum Sparen");
		expect(headingAbove($("h1"), headings)).toBeUndefined();
		expect(headingAbove($("h2"), headings)).toBe("Krankenkassen vergleichen");
	});
});

describe("describeElement", () => {
	test("records readable classes, attributes and ancestors", () => {
		const d = describeElement($("form button"));
		expect(d.tag).toBe("button");
		expect(d.role).toBe("button");
		expect(d.name).toBe("Prämien berechnen");
		expect(d.text).toBe("Prämien berechnen");
		expect(d.classes).toEqual(["Button_primary"]);
		expect(d.attributes).toEqual({ type: "submit" });
		expect(d.heading).toBe("Krankenkassen vergleichen");
		expect(d.ancestors).toEqual(["form.Form_root", "main"]);
		expect(d.id).toBeUndefined();
		expect(d.testId).toBeUndefined();
	});

	test("keeps hand-written ids and test ids, drops generated ids", () => {
		expect(describeElement($("#year")).id).toBe("year");
		expect(describeElement($("form")).id).toBeUndefined();
		expect(describeElement($("[data-testid=reset]")).testId).toBe("reset");
	});

	test("shortens links and images", () => {
		expect(describeElement($("nav a")).attributes["href"]).toBe(
			"/versicherungen",
		);
		expect(describeElement($("nav a:nth-of-type(2)")).attributes["href"]).toBe(
			"example.com/login",
		);
		expect(describeElement($("img")).attributes["src"]).toBe("tip.png");
	});

	test("summary", () => {
		expect(summarize(describeElement($("form button")))).toBe(
			'button "Prämien berechnen" · Button_primary · under "Krankenkassen vergleichen"',
		);
	});
});

describe("cssSelector", () => {
	test("prefers test ids, ids and readable classes, and is unique", () => {
		expect(cssSelector($("[data-testid=reset]"))).toBe('[data-testid="reset"]');
		expect(cssSelector($("#year"))).toBe("#year");
		expect(cssSelector($("h1"))).toBe('h1[class*="Hero_title"]');
		for (const el of doc.querySelectorAll("body *")) {
			const selector = cssSelector(el);
			expect(doc.querySelectorAll(selector).length).toBe(1);
			expect(doc.querySelector(selector)).toBe(el);
		}
	});
});
