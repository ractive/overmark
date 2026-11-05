import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { PageBlur } from "../src/content/blur.ts";

let doc: Document;

beforeEach(() => {
	const window = new Window({ url: "https://www.example.com/kk" });
	doc = window.document as unknown as Document;
	doc.body.innerHTML = `
		<input id="name" />
		<input id="pw" type="password" style="filter: grayscale(1)" />
		<div id="plain" contenteditable="plaintext-only">typed</div>
		<div id="box" role="textbox">typed</div>
		<button id="go">Go</button>
		<div id="host"></div>`;
	const shadow = (doc.getElementById("host") as HTMLElement).attachShadow({
		mode: "open",
	});
	shadow.innerHTML = `<input id="inner" /><input id="inner-pw" type="password" />`;
});

const filter = (el: Element | null | undefined) =>
	(el as HTMLElement | null)?.style.getPropertyValue("filter") ?? "";
const $ = (id: string) => doc.getElementById(id);
const inner = (id: string) =>
	($("host") as HTMLElement).shadowRoot?.getElementById(id);

describe("PageBlur", () => {
	test("passwords only, unless all form fields; into shadow roots", () => {
		const blur = new PageBlur(doc);
		const release = blur.hold(false);
		expect(filter($("pw"))).toBe("blur(6px)");
		expect(filter(inner("inner-pw"))).toBe("blur(6px)");
		expect(filter($("name"))).toBe("");
		release();
		const all = blur.hold(true);
		for (const el of [$("name"), $("plain"), $("box"), inner("inner")])
			expect(filter(el)).toBe("blur(6px)");
		expect(filter($("go"))).toBe("");
		all();
		expect(filter($("name"))).toBe("");
		expect(filter(inner("inner"))).toBe("");
	});

	test("two holders: the page's own style comes back whatever the order", () => {
		for (const order of ["first-first", "last-first"]) {
			const blur = new PageBlur(doc);
			const a = blur.hold(false);
			const b = blur.hold(true);
			expect(filter($("name"))).toBe("blur(6px)");
			if (order === "first-first") {
				a();
				expect(filter($("name"))).toBe("blur(6px)");
				b();
			} else {
				b();
				// Only passwords stay blurred while the first holder still holds.
				expect(filter($("name"))).toBe("");
				expect(filter($("pw"))).toBe("blur(6px)");
				a();
			}
			expect(blur.held).toBe(0);
			expect(filter($("pw"))).toBe("grayscale(1)");
			expect(filter($("name"))).toBe("");
		}
	});

	test("releasing twice does nothing", () => {
		const blur = new PageBlur(doc);
		const a = blur.hold(true);
		const b = blur.hold(true);
		a();
		a();
		expect(blur.held).toBe(1);
		expect(filter($("name"))).toBe("blur(6px)");
		b();
		expect(filter($("name"))).toBe("");
	});
});

test("a field's own transition cannot fade the blur in late, and comes back", () => {
	const field = doc.getElementById("name") as HTMLElement;
	field.style.setProperty("transition", "all 2s");
	const blur = new PageBlur(doc);
	const release = blur.hold(true);
	expect(field.style.getPropertyValue("transition")).toBe("none");
	expect(field.style.getPropertyPriority("transition")).toBe("important");
	release();
	expect(field.style.getPropertyValue("transition")).toBe("all 2s");
	expect(field.style.getPropertyPriority("transition")).toBe("");
});

test("code editors count as form fields: what they show was typed", () => {
	doc.body.insertAdjacentHTML(
		"beforeend",
		`<div id="editor" class="monaco-editor">typed</div>`,
	);
	const release = new PageBlur(doc).hold(true);
	expect(filter(doc.getElementById("editor"))).toBe("blur(6px)");
	release();
	expect(filter(doc.getElementById("editor"))).toBe("");
});
