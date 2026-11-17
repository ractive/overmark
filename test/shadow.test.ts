import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { firefoxShadowOf, shadowOf } from "../src/lib/shadow.ts";

function page(html: string): Document {
	const window = new Window({ url: "https://www.example.com/" });
	const doc = window.document as unknown as Document;
	doc.body.innerHTML = html;
	return doc;
}

describe("an element's shadow root", () => {
	test("a form whose control is named openOrClosedShadowRoot has none", () => {
		const doc = page(
			'<form><input name="openOrClosedShadowRoot"><input name="shadowRoot"></form>',
		);
		const form = doc.querySelector("form") as HTMLFormElement;
		// The page's control answers for the property, as in a browser.
		Object.defineProperty(form, "openOrClosedShadowRoot", {
			value: form.querySelector("input"),
		});
		expect(firefoxShadowOf(form)).toBeNull();
		// Chrome's way, without chrome.dom here: the open root, none.
		expect(shadowOf(form)).toBeNull();
	});

	test("Firefox's openOrClosedShadowRoot, else the open root", () => {
		const doc = page('<div id="closed"></div><div id="open"></div>');
		const closedHost = doc.getElementById("closed") as HTMLElement;
		const closed = closedHost.attachShadow({ mode: "closed" });
		Object.defineProperty(closedHost, "openOrClosedShadowRoot", {
			value: closed,
		});
		expect(firefoxShadowOf(closedHost)).toBe(closed);
		const openHost = doc.getElementById("open") as HTMLElement;
		const open = openHost.attachShadow({ mode: "open" });
		expect(firefoxShadowOf(openHost)).toBe(open);
		expect(shadowOf(openHost)).toBe(open);
		expect(firefoxShadowOf(doc.body)).toBeNull();
	});
});
