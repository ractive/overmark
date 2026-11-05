/**
 * Pages built from web components keep their content in shadow roots, which
 * `querySelectorAll`, `closest` and `elementsFromPoint` do not enter.
 */

/** An element's shadow root, open or (from an extension) closed. */
export function shadowOf(el: Element): ShadowRoot | null {
	try {
		const closed =
			typeof chrome === "undefined"
				? undefined
				: chrome.dom?.openOrClosedShadowRoot?.(el as HTMLElement);
		return closed ?? el.shadowRoot;
	} catch {
		// Not an element that can have one.
		return el.shadowRoot;
	}
}

/** `top` and every shadow root under it, without the one of `skip`. */
export function shadowTrees(top: ParentNode, skip?: Element): ParentNode[] {
	const out: ParentNode[] = [top];
	for (let i = 0; i < out.length; i++) {
		for (const el of (out[i] as ParentNode).querySelectorAll("*")) {
			const root = el === skip ? null : shadowOf(el);
			if (root !== null) out.push(root);
		}
	}
	return out;
}

/** The element whose shadow root `el` is in, if any. */
export function hostOf(el: Element): Element | null {
	const root = el.getRootNode();
	// By type: a detached link is its own root, and has a `host` of its own.
	return root.nodeType === 11 ? ((root as ShadowRoot).host ?? null) : null;
}

/** The element around `el`, also across a shadow root. */
export function parentOf(el: Element): Element | null {
	return el.parentElement ?? hostOf(el);
}

/** The outermost host around `el`: where it sits in the document. */
export function inDocument(el: Element): Element {
	let at = el;
	for (let host = hostOf(at); host !== null; host = hostOf(at)) at = host;
	return at;
}

/** `el.closest(selector)`, going on outside the shadow roots around it. */
export function closestAcross(el: Element, selector: string): Element | null {
	for (let at: Element | null = el; at !== null; at = hostOf(at)) {
		const found = at.closest(selector);
		if (found !== null) return found;
	}
	return null;
}
