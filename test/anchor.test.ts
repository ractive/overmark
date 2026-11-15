import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
	elementAt,
	elementForRect,
	pageElementsAt,
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
