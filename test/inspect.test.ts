import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
	attributeValue,
	cleanCssUrls,
	cleanUrl,
	inspectElement,
	LEFT_OUT_INPUT,
	markupOf,
	matchedRules,
	pickStyles,
	resolveSelector,
	splitSelectors,
} from "../src/lib/inspect.ts";

let doc: Document;

function page(html: string, head = ""): Document {
	const win = new Window({ url: "https://shop.example/kk" });
	win.document.write(
		`<!doctype html><html><head>${head}</head><body>${html}</body></html>`,
	);
	doc = win.document as unknown as Document;
	return doc;
}

const $ = (selector: string) => {
	const el = doc.querySelector(selector);
	if (el === null) throw new Error(`no ${selector}`);
	return el;
};

beforeEach(() => {
	page("");
});

describe("URLs", () => {
	test("lose their query string and fragment", () => {
		expect(cleanUrl("/search?q=me&token=abc")).toBe("/search?…");
		expect(cleanUrl("https://other.example/a#section")).toBe(
			"https://other.example/a#…",
		);
		expect(cleanUrl("#top")).toBe("#…");
		expect(cleanUrl("/plain/path")).toBe("/plain/path");
		expect(cleanUrl("data:image/png;base64,AAAA")).toBe("data:image/png…");
		expect(cleanUrl("javascript:alert(document.cookie)")).toBe("javascript:…");
	});

	test("in CSS too", () => {
		expect(
			cleanCssUrls(
				`background: url("https://cdn.example/a.png?sig=1") no-repeat, url(b.svg#icon)`,
			),
		).toBe(
			`background: url("https://cdn.example/a.png?…") no-repeat, url(b.svg#…)`,
		);
	});
});

describe("attributes", () => {
	test("form fields keep no value, and nothing else that could hold one", () => {
		page(
			`<input name="zip" value="8001" data-value="8001" aria-valuetext="8001" placeholder="PLZ" checked data-testid="zip" aria-label="Postleitzahl">`,
		);
		const input = $("input");
		const kept = [...input.attributes]
			.filter((a) => attributeValue(input, a.name, a.value) !== undefined)
			.map((a) => a.name);
		expect(kept).toEqual(["name", "placeholder", "data-testid", "aria-label"]);
	});

	test("handlers lose their code, long values are cut, other elements keep value", () => {
		page(`<button value="go" onclick="track('secret')">Go</button>`);
		const button = $("button");
		expect(attributeValue(button, "onclick", "track('secret')")).toBe("…");
		expect(attributeValue(button, "value", "go")).toBe("go");
		expect(attributeValue(button, "title", "t".repeat(400))?.length).toBe(201);
		expect(attributeValue(button, "nonce", "abc")).toBeUndefined();
		expect(attributeValue(button, "data-csrf-token", "abc")).toBe("…");
		expect(attributeValue(button, "data-session-id", "abc")).toBe("…");
		expect(attributeValue(button, "srcset", "a.png?x=1 1x, b.png?y=2 2x")).toBe(
			"a.png?… 1x, b.png?… 2x",
		);
		expect(attributeValue(button, "style", "background:url(/i.png?t=1)")).toBe(
			"background:url(/i.png?…)",
		);
	});
});

describe("markup", () => {
	test("leaves out values, typed text, scripts, styles and comments", () => {
		page(`<form class="Form_root">
			<!-- a comment -->
			<label>PLZ <input name="zip" value="8001"></label>
			<textarea name="note">my secret note</textarea>
			<select name="kk"><option value="a" selected>Helsana</option></select>
			<div contenteditable="true"><p>typed <b>text</b></p></div>
			<script>window.secret = 1</script>
			<style>.x { color: red }</style>
			<a href="/next?session=1">Weiter</a>
			<button type="submit" class="Button_primary">Prämien  berechnen</button>
		</form>`);
		const { html, leftOut } = markupOf($("form"));
		expect(leftOut).toBe(0);
		expect(html.startsWith('<form class="Form_root">')).toBe(true);
		expect(html.endsWith("</form>")).toBe(true);
		for (const gone of [
			"8001",
			"my secret note",
			"Helsana",
			"typed",
			"window.secret",
			"color: red",
			"a comment",
			"session",
		])
			expect(html).not.toContain(gone);
		expect(html).toContain('<input name="zip">');
		expect(html).toContain(
			`<textarea name="note">${LEFT_OUT_INPUT}</textarea>`,
		);
		expect(html).toContain("<script></script>");
		expect(html).toContain('<a href="/next?…">Weiter</a>');
		expect(html).toContain(
			'<button type="submit" class="Button_primary">Prämien berechnen</button>',
		);
	});

	test("an element inside an editable region is typed content as a whole", () => {
		page(`<div contenteditable="true"><p id="typed">my <b>words</b></p></div>`);
		const { html } = markupOf($("#typed"));
		expect(html).toBe(`<p id="typed">${LEFT_OUT_INPUT}</p>`);
	});

	test("is cut at the limit, stays well formed and says how much is left out", () => {
		const items = Array.from(
			{ length: 50 },
			(_, i) => `<li class="item">Item number ${i}</li>`,
		).join("");
		page(`<ul id="list">${items}</ul>`);
		const { html, leftOut } = markupOf($("#list"), { max: 400 });
		expect(html.length).toBeLessThan(520);
		expect(html.endsWith("</ul>")).toBe(true);
		expect(leftOut).toBeGreaterThan(30);
		expect(html).toContain(`${leftOut} more elements left out`);
		const opened = html.match(/<li /g)?.length ?? 0;
		expect(html.match(/<\/li>/g)?.length).toBe(opened);
		expect(opened + leftOut).toBe(50);
	});

	test("the head's content stays out", () => {
		page(
			"<p>x</p>",
			`<meta name="csrf-token" content="s3cret"><title>T</title>`,
		);
		const { html } = markupOf(doc.documentElement);
		expect(html).not.toContain("s3cret");
		expect(html).toContain("<head></head><body><p>x</p></body>");
	});

	test("leaves out Overmark's own overlay", () => {
		page(`<main><p>Text</p><div id="overmark-root">toolbar</div></main>`);
		const { html } = markupOf($("main"), { skip: $("#overmark-root") });
		expect(html).toBe("<main><p>Text</p></main>");
	});

	test("long texts are cut", () => {
		page(`<p>${"word ".repeat(200)}</p>`);
		expect(markupOf($("p")).html.length).toBeLessThan(320);
	});
});

describe("styles", () => {
	const computed = (values: Record<string, string>) => (p: string) =>
		values[p] ??
		{
			display: "block",
			position: "static",
			"box-sizing": "content-box",
			width: "100px",
			height: "20px",
			"font-family": "sans-serif",
			"font-size": "16px",
			"font-weight": "400",
			"line-height": "normal",
			color: "rgb(0, 0, 0)",
			"min-width": "auto",
			"max-width": "none",
			"overflow-x": "visible",
			"overflow-y": "visible",
			opacity: "1",
			"z-index": "auto",
			transform: "none",
			visibility: "visible",
			"background-color": "rgba(0, 0, 0, 0)",
			"background-image": "none",
			"flex-grow": "0",
			"flex-shrink": "1",
			"flex-basis": "auto",
			"row-gap": "normal",
			"column-gap": "normal",
			"text-align": "start",
		}[p] ??
		(/^(margin|padding)-|-width$|-radius$/.test(p)
			? "0px"
			: /-style$/.test(p)
				? "none"
				: "");

	test("initial values are left out; sides come together", () => {
		const styles = pickStyles(
			computed({
				"margin-top": "8px",
				"margin-right": "16px",
				"margin-bottom": "8px",
				"margin-left": "16px",
				"padding-top": "4px",
				"padding-right": "4px",
				"padding-bottom": "4px",
				"padding-left": "4px",
				"border-top-width": "1px",
				"border-top-style": "solid",
				"border-top-color": "rgb(204, 204, 204)",
			}),
		);
		expect(styles).toEqual({
			display: "block",
			position: "static",
			"box-sizing": "content-box",
			width: "100px",
			height: "20px",
			margin: "8px 16px",
			padding: "4px",
			"border-top": "1px solid rgb(204, 204, 204)",
			"font-family": "sans-serif",
			"font-size": "16px",
			"font-weight": "400",
			"line-height": "normal",
			color: "rgb(0, 0, 0)",
		});
	});

	test("flex and grid containers and items, overflow and stacking", () => {
		const styles = pickStyles(
			computed({
				display: "flex",
				position: "relative",
				top: "4px",
				"row-gap": "8px",
				"column-gap": "8px",
				"flex-direction": "column",
				"flex-wrap": "nowrap",
				"justify-content": "space-between",
				"align-items": "normal",
				"align-content": "normal",
				"flex-grow": "1",
				"overflow-x": "hidden",
				"overflow-y": "auto",
				"z-index": "3",
			}),
			{ parentDisplay: "inline-flex" },
		);
		expect(styles["gap"]).toBe("8px");
		expect(styles["flex-direction"]).toBe("column");
		expect(styles["flex-wrap"]).toBeUndefined();
		expect(styles["justify-content"]).toBe("space-between");
		expect(styles["align-items"]).toBeUndefined();
		expect(styles["flex-grow"]).toBe("1");
		expect(styles["flex-shrink"]).toBeUndefined();
		expect(styles["top"]).toBe("4px");
		expect(styles["left"]).toBeUndefined();
		expect(styles["overflow"]).toBe("hidden auto");
		expect(styles["z-index"]).toBe("3");
	});

	test("the layout set has no fonts or colours; a child's is shorter", () => {
		const get = computed({ "background-color": "rgb(255, 0, 0)" });
		const layout = pickStyles(get, { set: "layout" });
		expect(layout["width"]).toBe("100px");
		expect(layout["font-size"]).toBeUndefined();
		expect(layout["background-color"]).toBeUndefined();
		expect(pickStyles(get)["background-color"]).toBe("rgb(255, 0, 0)");
		expect(pickStyles(get, { set: "child" })).toEqual({ display: "block" });
	});
});

describe("rules", () => {
	test("selectors split at top-level commas", () => {
		expect(splitSelectors(`a, b:is(c, d), [title="x, y"]`)).toEqual([
			"a",
			"b:is(c, d)",
			`[title="x, y"]`,
		]);
	});

	test("the rules that match, with sheet and media, in cascade order", () => {
		page(
			`<div class="Card"><button class="Button_primary">Go</button></div>`,
			`<style>
				.Button_primary { padding: 8px 16px; background: url(/b.png?v=3); }
				.Other { color: red; }
				@media (min-width: 1px) { .Card .Button_primary { margin: 4px; } }
				.Button_primary::before { content: "→"; }
			</style>`,
		);
		const { rules, leftOut, unreadable } = matchedRules($("button"));
		expect(leftOut).toBe(0);
		expect(unreadable).toEqual([]);
		expect(rules.map((r) => r.selector)).toEqual([
			".Button_primary",
			".Card .Button_primary",
			".Button_primary::before",
		]);
		expect(rules[0]?.sheet).toBe("<style> 1");
		expect(rules[0]?.declarations).toContain("padding");
		expect(rules[0]?.declarations).not.toContain("v=3");
		expect(rules[1]?.conditions).toEqual(["@media (min-width: 1px)"]);
		expect(rules[2]?.pseudo).toBe("::before");
	});

	test("are capped, keeping the later ones", () => {
		const css = Array.from(
			{ length: 45 },
			(_, i) => `.b { --n${i}: ${i}; }`,
		).join("\n");
		page(`<b class="b">x</b>`, `<style>${css}</style>`);
		const { rules, leftOut } = matchedRules($("b"));
		expect(rules).toHaveLength(30);
		expect(leftOut).toBe(15);
		expect(rules.at(-1)?.declarations).toContain("--n44");
	});
});

describe("the element on the page", () => {
	test("its box, the window, ancestors and children", () => {
		page(
			`<main class="Page"><section id="s" class="Card big"><h2>Title</h2><p>Body text</p><input value="secret"></section></main>`,
		);
		const inspected = inspectElement($("#s"));
		expect(inspected.tag).toBe("section");
		expect(inspected.html).toContain('<section id="s" class="Card big">');
		expect(inspected.html).not.toContain("secret");
		expect(inspected.viewport.width).toBeGreaterThan(0);
		expect(inspected.styles["display"]).toBeDefined();
		expect(inspected.ancestors.map((a) => a.tag)).toEqual([
			"main",
			"body",
			"html",
		]);
		expect(inspected.ancestors[0]?.classes).toEqual(["Page"]);
		expect(inspected.children.map((c) => [c.tag, c.text])).toEqual([
			["h2", "Title"],
			["p", "Body text"],
			["input", undefined],
		]);
	});

	test("a selector looks around the mark's element first", () => {
		page(
			`<form class="f"><div class="row"><button class="b">Go</button></div></form><div class="row">other</div>`,
		);
		const button = $("button");
		const up = resolveSelector(doc, button, ".row");
		expect("element" in up && up.relation).toBe("ancestor");
		expect("element" in up && up.element).toBe(button.parentElement as Element);
		const self = resolveSelector(doc, button, ".b");
		expect("element" in self && self.relation).toBe("mark");
		const down = resolveSelector(doc, $("form"), "button");
		expect("element" in down && down.relation).toBe("descendant");
		const elsewhere = resolveSelector(doc, button, "body > div.row");
		expect("element" in elsewhere && elsewhere.relation).toBe("page");
		expect(resolveSelector(doc, button, "[[")).toEqual({
			error: "Not a valid CSS selector: [[",
		});
		expect(resolveSelector(doc, button, ".none")).toEqual({
			error: "No element on this page matches .none",
		});
	});
});
