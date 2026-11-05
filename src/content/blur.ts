/**
 * Blurring form fields while a screenshot is taken: password fields always,
 * every form field when the user turned on "Blur form fields in screenshots".
 * Inline style through the CSSOM, which a page's CSP does not block.
 *
 * One `PageBlur` per page serves the user's saves and an AI app's screenshots
 * alike: each holds the blur while it captures, and the fields get their own
 * style back only when the last holder lets go, whatever the order.
 */

import { shadowTrees } from "../lib/shadow.ts";

const PASSWORDS = "input[type=password]";

const FORM_FIELDS =
	"input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], .monaco-editor, .CodeMirror, .ace_editor";

/** Blur the fields of a document now; the returned function restores them. */
export function blurFields(doc: Document, allForms: boolean): () => void {
	const selector = allForms ? FORM_FIELDS : PASSWORDS;
	const fields = shadowTrees(doc).flatMap((root) => [
		...root.querySelectorAll<HTMLElement>(selector),
	]);
	const inline = (f: HTMLElement, name: string) => ({
		name,
		value: f.style.getPropertyValue(name),
		priority: f.style.getPropertyPriority(name),
	});
	const before = fields.map((f) => ({
		f,
		styles: [inline(f, "filter"), inline(f, "transition")],
	}));
	for (const { f } of before) {
		// A page's `transition: all` would fade the blur in after the screenshot.
		f.style.setProperty("transition", "none", "important");
		f.style.setProperty("filter", "blur(6px)", "important");
	}
	return () => {
		for (const { f, styles } of before) {
			for (const { name, value, priority } of styles) {
				if (value) f.style.setProperty(name, value, priority);
				else f.style.removeProperty(name);
			}
		}
	};
}

/** The page's one blur, held by whoever is taking a screenshot. */
export class PageBlur {
	readonly #doc: Document;
	readonly #holders = new Map<symbol, boolean>();
	#restore: (() => void) | undefined;

	constructor(doc: Document) {
		this.#doc = doc;
	}

	/** How many screenshots are being taken. */
	get held(): number {
		return this.#holders.size;
	}

	/** Blur (all form fields when `allForms`); call the result when done. */
	hold(allForms: boolean): () => void {
		const token = Symbol("blur");
		this.#holders.set(token, allForms);
		this.#apply();
		return () => {
			if (this.#holders.delete(token)) this.#apply();
		};
	}

	#apply(): void {
		// Back to the page's own styles first, so the next blur records those.
		this.#restore?.();
		this.#restore = undefined;
		if (this.#holders.size === 0) return;
		const allForms = [...this.#holders.values()].some(Boolean);
		this.#restore = blurFields(this.#doc, allForms);
	}
}
