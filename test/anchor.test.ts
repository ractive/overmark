import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
	elementAt,
	elementForRect,
	isOpenStroke,
	pageElementsAt,
	usefulElement,
} from "../src/content/anchor.ts";

let doc: Document;
let overlay: HTMLElement;
const closed = new Map<Element, ShadowRoot>();

/** What a browser's hit test returns; happy-dom has none. */
function hits(root: Document | ShadowRoot, elements: () => Element[]): void {
	root.elementsFromPoint = elements;
}

beforeEach(() => {
	const window = new Window({ url: "https://www.example.com/kk" });
	doc = window.document as unknown as Document;
	doc.body.innerHTML = `<main><app-shell></app-shell><p>Text</p></main><div id="sitegloss-root"></div>`;
	overlay = doc.getElementById("sitegloss-root") as HTMLElement;
	closed.clear();
	Object.assign(globalThis, {
		chrome: {
			dom: { openOrClosedShadowRoot: (el: Element) => closed.get(el) ?? null },
		},
	});
});

afterEach(() => {
	delete (globalThis as { chrome?: unknown }).chrome;
});

const $ = (s: string) => doc.querySelector(s) as Element;

/** Compare elements without printing them: a happy-dom element is huge. */
function same(found: readonly unknown[], wanted: readonly unknown[]): void {
	expect(found.length).toBe(wanted.length);
	expect(found.every((e, i) => e === wanted[i])).toBe(true);
}
const page = () => [$("main"), doc.body, doc.documentElement];

function shadowHost(mode: ShadowRootMode): {
	host: Element;
	root: ShadowRoot;
	button: Element;
} {
	const host = $("app-shell");
	const root = host.attachShadow({ mode });
	root.innerHTML = `<section><button>Speichern</button></section>`;
	if (mode === "closed") closed.set(host, root);
	return { host, root, button: root.querySelector("button") as Element };
}

describe("pageElementsAt", () => {
	test("leaves out Sitegloss's own, the body and the root", () => {
		hits(doc, () => [overlay, $("p"), ...page()]);
		same(pageElementsAt(0, 0, overlay, doc), [$("p"), $("main")]);
	});

	test.each<ShadowRootMode>(["open", "closed"])(
		"goes into a shadow root, deepest first (%s)",
		(mode) => {
			const { host, root, button } = shadowHost(mode);
			const section = root.querySelector("section") as Element;
			hits(doc, () => [overlay, host, ...page()]);
			// Chromium also returns the elements around the root from a root.
			hits(root, () => [button, section, host, ...page()]);
			same(pageElementsAt(0, 0, overlay, doc), [
				button,
				section,
				host,
				$("main"),
			]);
			same([elementAt(0, 0, overlay, doc)], [button]);
		},
	);

	test("goes through a root inside a root", () => {
		const { host, root, button } = shadowHost("open");
		const inner = button.attachShadow({ mode: "open" });
		inner.innerHTML = `<span>Speichern</span>`;
		const span = inner.querySelector("span") as Element;
		hits(doc, () => [host, ...page()]);
		hits(root, () => [button, host, ...page()]);
		hits(inner, () => [span, button, host, ...page()]);
		same([elementAt(0, 0, overlay, doc)], [span]);
	});

	test("does not go into Sitegloss's own shadow root", () => {
		const root = overlay.attachShadow({ mode: "open" });
		root.innerHTML = `<button>Save</button>`;
		hits(doc, () => [overlay, $("p"), ...page()]);
		hits(root, () => [root.querySelector("button") as Element, overlay]);
		same([elementAt(0, 0, overlay, doc)], [$("p")]);
	});
});

describe("elementForRect", () => {
	test("picks an element inside a shadow root by its overlap", () => {
		const { host, root, button } = shadowHost("open");
		host.getBoundingClientRect = () =>
			({ x: 0, y: 0, width: 800, height: 600 }) as DOMRect;
		button.getBoundingClientRect = () =>
			({ x: 100, y: 100, width: 100, height: 40 }) as DOMRect;
		hits(doc, () => [host, ...page()]);
		hits(root, () => [button, host, ...page()]);
		same(
			[
				elementForRect(
					{ x: 100, y: 100, width: 100, height: 40 },
					overlay,
					doc,
				),
			],
			[button],
		);
	});
});

describe("the element a drawn mark is about (DEC-047)", () => {
	test("the picture, the link or button, the text: not a piece of it", () => {
		doc.body.innerHTML = `<article class="pp-card">
			<span class="pp-badge">New</span>
			<svg class="pp-bike"><g><circle id="wheel"></circle><path></path></g></svg>
			<p class="pp-price" data-testid="card-price"><strong>CHF 25</strong> per day</p>
			<a class="pp-btn" href="#book"><span>Book</span></a>
			<p>Pay <strong data-testid="total">CHF 60</strong></p>
		</article>`;
		const $ = (s: string) => doc.querySelector(s) as Element;
		expect(usefulElement($("circle")).localName).toBe("svg");
		expect(usefulElement($("path")).localName).toBe("svg");
		expect(usefulElement($(".pp-price strong"))).toBe($(".pp-price"));
		expect(usefulElement($(".pp-btn span"))).toBe($(".pp-btn"));
		// A piece with a test id of its own is what it is.
		expect(usefulElement($("[data-testid=total]"))).toBe(
			$("[data-testid=total]"),
		);
		// A badge with a class of its own is a thing of its own.
		expect(usefulElement($(".pp-badge"))).toBe($(".pp-badge"));
		// Anything else stays.
		expect(usefulElement($("article"))).toBe($("article"));
	});

	test("an icon component's picture inside a link: the link, across the shadow root", () => {
		doc.body.innerHTML = `<a id="cart" href="/cart"><shop-icon></shop-icon> Cart</a><p id="note">See <x-word></x-word></p>`;
		const icon = doc.querySelector("shop-icon") as Element;
		const root = icon.attachShadow({ mode: "open" });
		root.innerHTML = `<svg><g><path></path></g></svg>`;
		expect(usefulElement(root.querySelector("path") as Element)).toBe(
			doc.getElementById("cart") as Element,
		);
		// A bare span in a component's root is the text around it, outside.
		const word = doc.querySelector("x-word") as Element;
		const inner = word.attachShadow({ mode: "open" });
		inner.innerHTML = `<span>bold</span>`;
		expect(usefulElement(inner.querySelector("span") as Element)).toBe(word);
	});

	test("a line from one place to another is open; a circle round something is not", () => {
		expect(
			isOpenStroke([
				{ x: 0, y: 0 },
				{ x: 50, y: 5 },
				{ x: 100, y: 10 },
			]),
		).toBe(true);
		const circle = Array.from({ length: 13 }, (_, i) => ({
			x: 50 + 40 * Math.cos((i / 12) * 2 * Math.PI),
			y: 50 + 40 * Math.sin((i / 12) * 2 * Math.PI),
		}));
		expect(isOpenStroke(circle)).toBe(false);
	});
});
