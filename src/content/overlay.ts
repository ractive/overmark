/**
 * The overlay: a fixed, full-window layer in a shadow DOM on top of the page,
 * with Overmark's toolbar. Page styles cannot reach into it, and its styles do
 * not leak into the page.
 */

export const HOST_ID = "overmark-root";

const STYLE = `
:host { all: initial; }
.layer {
	position: fixed; inset: 0; z-index: 2147483647;
	pointer-events: none;
	font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
	color: #1d2433;
}
.toolbar {
	position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
	display: flex; gap: 4px; align-items: center;
	padding: 6px; border-radius: 10px;
	background: #1d2433; color: #fff;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
	pointer-events: auto;
}
.toolbar .brand { padding: 0 8px; font-weight: 600; color: #ffb000; }
.toolbar button {
	all: unset; cursor: pointer; padding: 6px 10px; border-radius: 6px;
	color: #fff; font: inherit;
}
.toolbar button:hover, .toolbar button:focus-visible { background: #34405a; }
[hidden] { display: none !important; }
`;

export class Overlay {
	readonly host: HTMLElement;
	readonly root: ShadowRoot;
	readonly layer: HTMLDivElement;
	readonly toolbar: HTMLDivElement;
	/** Called after `show()` and `hide()`, including the toolbar's Close. */
	onChange: ((visible: boolean) => void) | undefined;
	#visible = false;

	constructor(doc: Document = document) {
		this.host = doc.createElement("div");
		this.host.id = HOST_ID;
		// Open, so tests can reach in; the page could anyway, through the DOM.
		this.root = this.host.attachShadow({ mode: "open" });
		const style = doc.createElement("style");
		style.textContent = STYLE;
		this.layer = doc.createElement("div");
		this.layer.className = "layer";
		this.layer.hidden = true;
		this.toolbar = doc.createElement("div");
		this.toolbar.className = "toolbar";
		this.toolbar.setAttribute("role", "toolbar");
		this.toolbar.setAttribute("aria-label", "Overmark");
		const brand = doc.createElement("span");
		brand.className = "brand";
		brand.textContent = "Overmark";
		const close = doc.createElement("button");
		close.type = "button";
		close.dataset["action"] = "close";
		close.textContent = "Close";
		close.addEventListener("click", () => this.hide());
		this.toolbar.append(brand, close);
		this.layer.append(this.toolbar);
		this.root.append(style, this.layer);
		doc.documentElement.append(this.host);
	}

	get visible(): boolean {
		return this.#visible;
	}

	show(): void {
		this.#visible = true;
		this.layer.hidden = false;
		// Stay on top of elements the page appends later.
		if (this.host.nextElementSibling !== null)
			this.host.ownerDocument.documentElement.append(this.host);
		this.onChange?.(true);
	}

	hide(): void {
		this.#visible = false;
		this.layer.hidden = true;
		this.onChange?.(false);
	}
}
