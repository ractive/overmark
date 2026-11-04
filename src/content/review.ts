/**
 * Loading a case onto the page in front: each annotation's element is looked
 * for by its details (match.ts) and outlined with its number, green when
 * found, amber and dashed when only probable or tied.
 */

import type { Annotation, Case, ElementDetails } from "../lib/case.ts";
import {
	createContext,
	cssSelector,
	type DescribeContext,
	describeElement,
	summarize,
	TEST_ID_ATTRIBUTES,
} from "../lib/element.ts";
import { classify, PROBABLE, type Ranked, rank } from "../lib/match.ts";
import type {
	AnnotationMatch,
	CandidateInfo,
	LoadResult,
} from "../lib/messages.ts";
import type { Overlay } from "./overlay.ts";

/** More candidates than this are not scored when widening the search. */
const MAX_CANDIDATES = 8000;

interface Entry {
	annotation: Annotation;
	elements: Element[];
	ranked: Ranked[];
	match: AnnotationMatch;
}

function quote(value: string): string {
	return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

export class Reviewer {
	readonly overlay: Overlay;
	#case: Case | undefined;
	#entries: Entry[] = [];
	#focused: string | undefined;
	#frame = 0;

	constructor(overlay: Overlay) {
		this.overlay = overlay;
		const win = overlay.doc.defaultView;
		win?.addEventListener("scroll", () => this.#schedule(), { passive: true });
		win?.addEventListener("resize", () => this.#schedule());
	}

	get caseId(): string | undefined {
		return this.#case?.id;
	}

	load(c: Case): LoadResult {
		const doc = this.overlay.doc;
		const host = this.overlay.host;
		const context = createContext(doc);
		const cache = new Map<Element, ElementDetails>();
		const describe = (e: Element) => {
			let d = cache.get(e);
			if (d === undefined) {
				d = describeElement(e, context, { selector: false });
				cache.set(e, d);
			}
			return d;
		};
		const own = (e: Element) => e !== host && !host.contains(e);
		this.#case = c;
		this.#focused = undefined;
		this.#entries = [...c.annotations]
			.sort((a, b) => a.number - b.number)
			.map((annotation) => {
				const stored = annotation.element;
				if (stored === null)
					return {
						annotation,
						elements: [],
						ranked: [],
						match: {
							annotationId: annotation.id,
							number: annotation.number,
							status: "no-element",
							score: 0,
							current: 0,
							candidates: [],
						},
					};
				let elements = this.#likely(stored).filter(own);
				let ranked = rank(stored, elements.map(describe));
				if ((ranked[0]?.score ?? 0) < PROBABLE) {
					// The tag or role may have changed: score everything.
					elements = [...doc.body.querySelectorAll("*")]
						.filter(own)
						.slice(0, MAX_CANDIDATES);
					ranked = rank(stored, elements.map(describe));
				}
				const status = classify(ranked);
				const shown = status === "lost" ? [] : ranked;
				return {
					annotation,
					elements,
					ranked: shown,
					match: {
						annotationId: annotation.id,
						number: annotation.number,
						status,
						score: ranked[0]?.score ?? 0,
						current: 0,
						candidates: shown.map((r) =>
							this.#info(elements[r.index] as Element, r.score, context),
						),
					},
				};
			});
		this.overlay.setReviewing(true);
		this.#renderBar();
		this.#render();
		return {
			caseId: c.id,
			url: location.href,
			matches: this.#entries.map((e) => e.match),
		};
	}

	/** Elements likely to be the stored one: same tag, test id, id or role. */
	#likely(stored: ElementDetails): Element[] {
		const doc = this.overlay.doc;
		const found = new Set<Element>(doc.getElementsByTagName(stored.tag));
		const add = (selector: string) => {
			try {
				for (const e of doc.querySelectorAll(selector)) found.add(e);
			} catch {
				// An odd value that is no valid selector.
			}
		};
		if (stored.testId)
			for (const name of TEST_ID_ATTRIBUTES)
				add(`[${name}=${quote(stored.testId)}]`);
		if (stored.id) add(`[id=${quote(stored.id)}]`);
		if (stored.role) add(`[role=${quote(stored.role)}]`);
		return [...found];
	}

	#info(el: Element, score: number, context: DescribeContext): CandidateInfo {
		const rect = el.getBoundingClientRect();
		return {
			score: Math.round(score * 100) / 100,
			summary: summarize(describeElement(el, context, { selector: false })),
			selector: cssSelector(el),
			visible: rect.width > 0 && rect.height > 0,
		};
	}

	/** Scroll to an annotation's element (or another candidate) and focus it. */
	show(annotationId: string, candidate?: number): AnnotationMatch | undefined {
		const entry = this.#entries.find((e) => e.annotation.id === annotationId);
		if (entry === undefined) return undefined;
		if (candidate !== undefined && entry.ranked.length > 0)
			entry.match.current =
				((candidate % entry.ranked.length) + entry.ranked.length) %
				entry.ranked.length;
		this.#focused = annotationId;
		const el = this.#element(entry);
		el?.scrollIntoView({
			block: "center",
			inline: "nearest",
			behavior: "instant",
		});
		this.overlay.setReviewing(true);
		this.#render();
		return entry.match;
	}

	clear(): void {
		this.#case = undefined;
		this.#entries = [];
		this.#focused = undefined;
		this.overlay.renderReview([]);
		this.overlay.setReviewing(false);
	}

	#element(entry: Entry): Element | undefined {
		const r = entry.ranked[entry.match.current];
		return r === undefined ? undefined : entry.elements[r.index];
	}

	#schedule(): void {
		if (this.#frame !== 0 || !this.overlay.reviewing) return;
		this.#frame = requestAnimationFrame(() => {
			this.#frame = 0;
			this.#render();
		});
	}

	#render(): void {
		if (!this.overlay.reviewing) return;
		const items = [];
		for (const entry of this.#entries) {
			const el = this.#element(entry);
			if (el === undefined || !el.isConnected) continue;
			const r = el.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) continue;
			items.push({
				number: entry.annotation.number,
				rect: { x: r.x, y: r.y, width: r.width, height: r.height },
				found: entry.match.status === "found",
				focused: entry.annotation.id === this.#focused,
			});
		}
		this.overlay.renderReview(items);
	}

	#renderBar(): void {
		const doc = this.overlay.doc;
		const total = this.#entries.length;
		const found = this.#entries.filter(
			(e) => e.match.status !== "lost" && e.match.status !== "no-element",
		).length;
		const brand = doc.createElement("span");
		brand.className = "brand";
		brand.textContent = "Overmark";
		const text = doc.createElement("span");
		text.className = "text";
		text.dataset["role"] = "review-status";
		text.textContent = `“${this.#case?.title ?? ""}”: ${found} of ${total} found`;
		const hide = doc.createElement("button");
		hide.type = "button";
		hide.dataset["action"] = "review-hide";
		hide.textContent = "Hide";
		hide.addEventListener("click", () => this.clear());
		this.overlay.reviewBar.replaceChildren(brand, text, hide);
	}
}
