/**
 * Describing an element: the details a case stores for each annotation, and
 * that matching (match.ts) compares on another build. Values typed into form
 * fields are never read.
 */

import type { ElementDetails, Rect } from "./case.ts";
import { isGeneratedId, readableClass, readableClasses } from "./classes.ts";

export const TEST_ID_ATTRIBUTES = [
	"data-testid",
	"data-test-id",
	"data-test",
	"data-qa",
	"data-cy",
] as const;

const KEPT_ATTRIBUTES = [
	"name",
	"type",
	"href",
	"src",
	"placeholder",
	"alt",
	"title",
] as const;

const HEADINGS = "h1, h2, h3, h4, h5, h6, [role='heading']";

const LANDMARKS =
	"nav, main, header, footer, aside, form, section[aria-label], section[aria-labelledby], [role='banner'], [role='navigation'], [role='main'], [role='contentinfo'], [role='complementary'], [role='search'], [role='form'], [role='region']";

/** Collapse whitespace and cut to `max` characters. */
export function normalizeText(
	text: string | null | undefined,
	max = 200,
): string {
	return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** What describing needs from the document; build it once for many elements. */
export interface DescribeContext {
	/** All headings, in document order. */
	headings: Element[];
	page: { width: number; height: number };
	scroll: { x: number; y: number };
}

export function createContext(doc: Document): DescribeContext {
	const root = doc.documentElement;
	const win = doc.defaultView;
	return {
		headings: [...doc.querySelectorAll(HEADINGS)],
		page: {
			width: Math.max(root.scrollWidth, root.clientWidth),
			height: Math.max(root.scrollHeight, root.clientHeight),
		},
		scroll: { x: win?.scrollX ?? 0, y: win?.scrollY ?? 0 },
	};
}

export function testIdOf(el: Element): string | undefined {
	for (const name of TEST_ID_ATTRIBUTES) {
		const value = el.getAttribute(name);
		if (value) return value;
	}
	return undefined;
}

function implicitRole(el: Element): string | undefined {
	const tag = el.localName;
	switch (tag) {
		case "a":
		case "area":
			return el.hasAttribute("href") ? "link" : undefined;
		case "button":
		case "summary":
			return "button";
		case "input": {
			const type = (el.getAttribute("type") ?? "text").toLowerCase();
			if (["button", "submit", "reset", "image"].includes(type))
				return "button";
			if (type === "checkbox" || type === "radio") return type;
			if (type === "range") return "slider";
			if (type === "number") return "spinbutton";
			if (type === "search") return "searchbox";
			if (type === "hidden") return undefined;
			return "textbox";
		}
		case "select":
			return el.hasAttribute("multiple") ? "listbox" : "combobox";
		case "textarea":
			return "textbox";
		case "h1":
		case "h2":
		case "h3":
		case "h4":
		case "h5":
		case "h6":
			return "heading";
		case "img":
			return el.getAttribute("alt") === "" ? "presentation" : "img";
		case "nav":
			return "navigation";
		case "main":
			return "main";
		case "aside":
			return "complementary";
		case "form":
			return "form";
		case "header":
		case "footer":
			return el.closest("article, aside, main, nav, section") === null
				? tag === "header"
					? "banner"
					: "contentinfo"
				: undefined;
		case "section":
			return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")
				? "region"
				: undefined;
		case "ul":
		case "ol":
			return "list";
		case "li":
			return "listitem";
		case "table":
			return "table";
		case "dialog":
			return "dialog";
		case "p":
			return "paragraph";
		default:
			return undefined;
	}
}

export function roleOf(el: Element): string | undefined {
	const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
	return explicit || implicitRole(el);
}

const NAMED_BY_CONTENT = new Set([
	"a",
	"button",
	"summary",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"label",
	"option",
	"legend",
	"caption",
	"th",
	"td",
	"li",
]);

export function accessibleName(el: Element): string | undefined {
	const label = el.getAttribute("aria-label");
	if (label?.trim()) return normalizeText(label);
	const labelledBy = el.getAttribute("aria-labelledby");
	if (labelledBy) {
		const doc = el.ownerDocument;
		const text = labelledBy
			.split(/\s+/)
			.map((id) => doc.getElementById(id)?.textContent ?? "")
			.join(" ");
		if (text.trim()) return normalizeText(text);
	}
	const tag = el.localName;
	if (tag === "img" || (tag === "input" && el.getAttribute("type") === "image"))
		return normalizeText(el.getAttribute("alt")) || undefined;
	if (tag === "input" || tag === "select" || tag === "textarea") {
		const labels = (el as HTMLInputElement).labels;
		const fromLabel = labels?.[0] ? labelText(labels[0], el) : "";
		if (fromLabel) return fromLabel;
		const type = el.getAttribute("type")?.toLowerCase();
		if (type === "submit" || type === "button" || type === "reset")
			return normalizeText(el.getAttribute("value")) || undefined;
		const placeholder = el.getAttribute("placeholder");
		if (placeholder?.trim()) return normalizeText(placeholder);
	}
	if (NAMED_BY_CONTENT.has(tag) || el.getAttribute("role") === "button") {
		const text = normalizeText(el.textContent);
		if (text) return text;
	}
	const title = el.getAttribute("title");
	return title?.trim() ? normalizeText(title) : undefined;
}

/** A label's text without the text of the control inside it. */
function labelText(label: Element, control: Element): string {
	let text = "";
	const walk = (node: Node) => {
		if (node === control) return;
		if (node.nodeType === 3) text += node.textContent ?? "";
		for (const child of node.childNodes) walk(child);
	};
	walk(label);
	return normalizeText(text);
}

/** The nearest heading before `el` in document order (not `el` or one around it). */
export function headingAbove(
	el: Element,
	headings: readonly Element[],
): string | undefined {
	let lo = 0;
	let hi = headings.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const h = headings[mid] as Element;
		const precedes =
			h !== el &&
			!h.contains(el) &&
			(h.compareDocumentPosition(el) & 4) /* FOLLOWING */ !== 0;
		if (precedes) {
			found = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	const h = headings[found];
	return h === undefined
		? undefined
		: normalizeText(h.textContent) || undefined;
}

export function landmarkOf(el: Element): string | undefined {
	const landmark = el.closest(LANDMARKS);
	if (landmark === null) return undefined;
	const role = roleOf(landmark) ?? landmark.localName;
	const name =
		landmark.localName === "form" ? undefined : accessibleName(landmark);
	return name ? `${role}: ${name}` : role;
}

function step(el: Element): string {
	const testId = testIdOf(el);
	if (testId) return `${el.localName}[${testId}]`;
	const cls = readableClasses(el.getAttribute("class") ?? "")[0];
	return cls ? `${el.localName}.${cls}` : el.localName;
}

export function ancestorsOf(el: Element, depth = 6): string[] {
	const out: string[] = [];
	let at = el.parentElement;
	while (at !== null && out.length < depth) {
		if (at.localName === "body" || at.localName === "html") break;
		out.push(step(at));
		at = at.parentElement;
	}
	return out;
}

function attributesOf(el: Element): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of KEPT_ATTRIBUTES) {
		const value = el.getAttribute(name);
		if (value === null || value === "") continue;
		if (name === "href" || name === "src") {
			try {
				const url = new URL(value, el.ownerDocument.baseURI);
				out[name] =
					name === "src"
						? (url.pathname.split("/").pop() ?? "")
						: url.origin === new URL(el.ownerDocument.baseURI).origin
							? url.pathname + url.search
							: `${url.host}${url.pathname}`;
			} catch {
				out[name] = value.slice(0, 300);
			}
			continue;
		}
		out[name] = value.slice(0, 300);
	}
	return out;
}

function escapeCss(value: string): string {
	return typeof CSS !== "undefined" && typeof CSS.escape === "function"
		? CSS.escape(value)
		: value.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`);
}

function unique(doc: Document, selector: string): boolean {
	try {
		return doc.querySelectorAll(selector).length === 1;
	} catch {
		return false;
	}
}

/** A selector for one element: stable attributes first, a path as the last resort. */
function ownSelector(el: Element): string[] {
	const out: string[] = [];
	for (const name of TEST_ID_ATTRIBUTES) {
		const value = el.getAttribute(name);
		if (value) out.push(`[${name}="${value.replace(/["\\]/g, "\\$&")}"]`);
	}
	const id = el.getAttribute("id");
	if (id && !isGeneratedId(id)) out.push(`#${escapeCss(id)}`);
	const classes = (el.getAttribute("class") ?? "")
		.split(/\s+/)
		.map((name) => ({ name, readable: readableClass(name) }))
		.filter((c) => c.readable !== undefined);
	if (classes.length > 0) {
		const parts = classes
			.slice(0, 2)
			.map((c) =>
				c.readable === c.name
					? `.${escapeCss(c.name)}`
					: `[class*="${(c.readable as string).replace(/["\\]/g, "\\$&")}"]`,
			)
			.join("");
		out.push(`${el.localName}${parts}`);
	}
	return out;
}

export function cssSelector(el: Element): string {
	const doc = el.ownerDocument;
	for (const candidate of ownSelector(el))
		if (unique(doc, candidate)) return candidate;
	const path: string[] = [];
	let at: Element | null = el;
	while (at !== null && at.localName !== "html" && path.length < 10) {
		const own = path.length === 0 ? [] : ownSelector(at);
		const anchor = own.find((s) => unique(doc, s));
		if (anchor !== undefined) {
			path.unshift(anchor);
			break;
		}
		const parent: Element | null = at.parentElement;
		const same = parent
			? [...parent.children].filter((c) => c.localName === at?.localName)
			: [];
		path.unshift(
			same.length > 1
				? `${at.localName}:nth-of-type(${same.indexOf(at) + 1})`
				: at.localName,
		);
		at = parent;
	}
	return path.join(" > ");
}

export function documentRect(
	el: Element,
	scroll: { x: number; y: number },
): Rect {
	const r = el.getBoundingClientRect();
	const round = (v: number) => Math.round(v * 10) / 10;
	return {
		x: round(r.x + scroll.x),
		y: round(r.y + scroll.y),
		width: round(r.width),
		height: round(r.height),
	};
}

/** Everything Overmark records about an element. */
export function describeElement(
	el: Element,
	context: DescribeContext = createContext(el.ownerDocument),
): ElementDetails {
	const details: ElementDetails = {
		tag: el.localName,
		classes: readableClasses(el.getAttribute("class") ?? ""),
		attributes: attributesOf(el),
		ancestors: ancestorsOf(el),
		rect: documentRect(el, context.scroll),
		page: context.page,
		selector: cssSelector(el),
	};
	const id = el.getAttribute("id");
	if (id && !isGeneratedId(id)) details.id = id;
	const testId = testIdOf(el);
	if (testId) details.testId = testId;
	const role = roleOf(el);
	if (role) details.role = role;
	const name = accessibleName(el);
	if (name) details.name = name;
	const text = normalizeText(el.textContent);
	if (text) details.text = text;
	const heading = headingAbove(el, context.headings);
	if (heading) details.heading = heading;
	const landmark = landmarkOf(el);
	if (landmark) details.landmark = landmark;
	return details;
}

/** A one-line summary, e.g. `button "Prämien berechnen" · Button_primary · under "Krankenkassen vergleichen"`. */
export function summarize(details: ElementDetails): string {
	const parts = [
		details.role && details.role !== details.tag
			? `${details.tag} (${details.role})`
			: details.tag,
	];
	if (details.name) parts[0] += ` "${details.name.slice(0, 60)}"`;
	else if (details.text) parts[0] += ` "${details.text.slice(0, 60)}"`;
	if (details.testId) parts.push(`test id ${details.testId}`);
	if (details.classes.length > 0)
		parts.push(details.classes.slice(0, 3).join(" "));
	if (details.heading) parts.push(`under "${details.heading.slice(0, 50)}"`);
	return parts.join(" · ");
}
