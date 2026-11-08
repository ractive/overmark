/** A tiny element builder for the side panel. */

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<Record<string, string | boolean | ((e: Event) => void)>> = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value === undefined || value === false) continue;
		if (typeof value === "function") {
			el.addEventListener(key.replace(/^on/, ""), value as EventListener);
		} else if (key === "class") {
			el.className = String(value);
		} else if (value === true) {
			el.setAttribute(key, "");
		} else {
			el.setAttribute(key, value);
		}
	}
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		el.append(child);
	}
	return el;
}

export function byId<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (found === null) throw new Error(`#${id} missing`);
	return found as T;
}

/** "4 Nov 2026, 17:05" in the browser's language. */
export function formatDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime())
		? iso
		: date.toLocaleString(undefined, {
				day: "numeric",
				month: "short",
				year: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
}

/** A web page's address, one a click may open (an imported case's is anyone's). */
export function isWebPage(url: string): boolean {
	try {
		const { protocol } = new URL(url);
		return protocol === "https:" || protocol === "http:";
	} catch {
		return false;
	}
}

/** `www.example.com/kk` from a URL. */

export function shortUrl(url: string): string {
	try {
		const u = new URL(url);
		return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
	} catch {
		return url;
	}
}
