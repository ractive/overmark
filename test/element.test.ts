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

	test("keeps data URLs and long URLs short", () => {
		const svg = `data:image/svg+xml,${encodeURIComponent(`<svg>${"<rect/>".repeat(800)}</svg>`)}`;
		doc.body.insertAdjacentHTML(
			"beforeend",
			`<img id="inline" src="${svg}" alt="x" /><a id="far" href="https://other.example/${"a".repeat(5000)}">x</a>`,
		);
		expect(describeElement($("#inline")).attributes["src"]).toBe(
			"data:image/svg+xml",
		);
		const href = describeElement($("#far")).attributes["href"] ?? "";
		expect(href.length).toBe(300);
		expect(href.startsWith("other.example/aaa")).toBe(true);
	});

	test("never records what was typed into an editor", () => {
		doc.body.insertAdjacentHTML(
			"beforeend",
			`<div id="editor" contenteditable="true" aria-label="Message"><h3>Private heading</h3><p id="typed">Secret draft text</p></div>
			<div id="custom" role="textbox" title="Notes">typed notes</div>
			<p id="after">After the editor</p>`,
		);
		const editor = describeElement($("#editor"));
		expect(editor.text).toBeUndefined();
		expect(editor.name).toBe("Message");
		const typed = describeElement($("#typed"));
		expect(typed.text).toBeUndefined();
		expect(typed.name).toBeUndefined();
		const custom = describeElement($("#custom"));
		expect(custom.text).toBeUndefined();
		expect(custom.name).toBe("Notes");
		expect(describeElement($("#after")).heading).toBe("Tipps zum Sparen");
	});

	test("never records typed text through an element around an editor", () => {
		doc.body.insertAdjacentHTML(
			"beforeend",
			`<div id="box" class="comment-box"><div class="toolbar">B I U</div><div contenteditable>my unsent private reply</div></div>
			<label id="wrap" role="button">Reply <textarea>typed answer</textarea> <input value="typed value" /></label>
			<h4 id="heading">Title <span contenteditable="true">typed heading</span></h4>
			<p id="below">Below</p>
			<div id="scripted">Visible<script>var secret = 1;</script><style>.x{}</style></div>`,
		);
		const textarea = doc.querySelector("#wrap textarea") as HTMLTextAreaElement;
		// React sets the value through defaultValue, which becomes the text.
		textarea.defaultValue = "typed through React";
		const box = describeElement($("#box"));
		expect(box.text).toBe("B I U");
		expect(JSON.stringify(box)).not.toContain("private reply");
		const wrap = describeElement($("#wrap"));
		expect(wrap.name).toBe("Reply");
		expect(JSON.stringify(wrap)).not.toContain("typed");
		const area = describeElement(textarea);
		expect(area.text).toBeUndefined();
		expect(JSON.stringify(area)).not.toContain("React");
		expect(describeElement($("#below")).heading).toBe("Title");
		expect(describeElement($("#scripted")).text).toBe("Visible");
	});

	test("records the allow-listed details and nothing else", () => {
		doc.body.insertAdjacentHTML(
			"beforeend",
			`<a id="link" href="/konto?token=secret-token&email=a%40b.ch#private" data-foo="secret-data" onclick="secret()" aria-describedby="x" style="color: red" title="Konto">Mein Konto</a>
			<input id="field" name="email" type="email" value="secret-value" placeholder="E-Mail" />
			<a id="mail" href="mailto:a@b.ch?subject=secret">Mail</a>`,
		);
		(doc.getElementById("field") as HTMLInputElement).value = "typed-secret";
		const allowed = new Set([
			"tag",
			"id",
			"testId",
			"role",
			"name",
			"text",
			"classes",
			"attributes",
			"heading",
			"landmark",
			"ancestors",
			"rect",
			"page",
			"selector",
		]);
		for (const id of ["link", "field", "mail"]) {
			const d = describeElement($(`#${id}`));
			for (const key of Object.keys(d)) expect(allowed.has(key)).toBe(true);
			for (const key of Object.keys(d.attributes))
				expect([
					"name",
					"type",
					"href",
					"src",
					"placeholder",
					"alt",
					"title",
				]).toContain(key);
			expect(JSON.stringify(d)).not.toContain("secret");
		}
		expect(describeElement($("#link")).attributes["href"]).toBe("/konto");
		expect(describeElement($("#mail")).attributes["href"]).toBe("mailto:");
		expect(describeElement($("#field")).attributes).toEqual({
			name: "email",
			type: "email",
			placeholder: "E-Mail",
		});
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
