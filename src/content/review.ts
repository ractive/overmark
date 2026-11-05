/**
 * Loading a case onto the page in front: each annotation's element is looked
 * for by its details (match.ts) and outlined with its number, green when
 * found, amber and dashed when only probable or tied. An element that a
 * re-render replaced afterwards is looked for again.
 */

import {
	type Candidate,
	createSearch,
	findCandidates,
	type PageSearch,
} from "../lib/candidates.ts";
import type { Annotation, Case } from "../lib/case.ts";
import {
	cssSelector,
	type DescribeContext,
	describeElement,
	summarize,
} from "../lib/element.ts";
import { clearTextCache } from "../lib/match.ts";
import type {
	AnnotationMatch,
	CandidateInfo,
	LoadResult,
} from "../lib/messages.ts";
import type { Overlay } from "./overlay.ts";

interface Entry {
	annotation: Annotation;
	/** The best elements worth showing, best first. */
	candidates: Candidate[];
	match: AnnotationMatch;
}

/** Let the page run between annotations: loading a big case takes a while. */
const yieldToPage = () => new Promise<void>((r) => setTimeout(r, 0));

export class Reviewer {
	readonly overlay: Overlay;
	#case: Case | undefined;
	#entries: Entry[] = [];
	#focused: string | undefined;
	#frame = 0;
	#timer: ReturnType<typeof setInterval> | undefined;
	/** A newer load or a clear stops a load that is still running. */
	#generation = 0;

	constructor(overlay: Overlay) {
		this.overlay = overlay;
		const doc = overlay.doc;
		// Capture phase: scrolling inside a container moves elements too.
		doc.addEventListener("scroll", () => this.#schedule(), {
			capture: true,
			passive: true,
		});
		doc.defaultView?.addEventListener("resize", () => this.#schedule());
	}

	get caseId(): string | undefined {
		return this.#case?.id;
	}

	async load(c: Case): Promise<LoadResult> {
		const generation = ++this.#generation;
		clearTextCache(); // what an abandoned load left behind
		const search = this.#search();
		const entries: Entry[] = [];
		for (const annotation of [...c.annotations].sort(
			(a, b) => a.number - b.number,
		)) {
			await yieldToPage();
			if (generation !== this.#generation)
				throw new Error("Loading was replaced by another one.");
			entries.push(this.#find(search, annotation));
		}
		this.#case = c;
		this.#entries = entries;
		this.#focused = undefined;
		this.overlay.setReviewing(true);
		clearInterval(this.#timer);
		// Layout changes (lazy content, accordions) move elements without a scroll.
		this.#timer = setInterval(() => {
			// One search a tick: a new route replaces every element at once.
			const replaced = this.#entries.find((e) => this.#replaced(e));
			if (replaced !== undefined) this.#findAgain(replaced);
			this.#schedule();
		}, 500);
		this.#renderBar();
		this.#render();
		clearTextCache();
		return {
			caseId: c.id,
			url: location.href,
			matches: entries.map((e) => e.match),
		};
	}

	#search(): PageSearch {
		return createSearch(this.overlay.doc, { exclude: this.overlay.host });
	}

	#find(search: PageSearch, annotation: Annotation): Entry {
		const base = {
			annotationId: annotation.id,
			number: annotation.number,
			current: 0,
		};
		const stored = annotation.element;
		if (stored === null)
			return {
				annotation,
				candidates: [],
				match: { ...base, status: "no-element", score: 0, candidates: [] },
			};
		const found = findCandidates(search, stored);
		const { status, candidates, truncated } = found;
		return {
			annotation,
			candidates,
			match: {
				...base,
				status,
				score: found.score,
				candidates: candidates.map((k) =>
					this.#info(k.element, k.score, search.context),
				),
				...(truncated ? { truncated: true } : {}),
			},
		};
	}

	/** The shown element left the page: a re-render, or it is gone. */
	#replaced(entry: Entry): boolean {
		return this.#element(entry)?.isConnected === false;
	}

	#findAgain(entry: Entry): void {
		const fresh = this.#find(this.#search(), entry.annotation);
		entry.candidates = fresh.candidates;
		entry.match = fresh.match;
		clearTextCache();
		this.#renderBar();
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
		const count = entry.candidates.length;
		if (candidate !== undefined && count > 0)
			entry.match.current = ((candidate % count) + count) % count;
		if (this.#replaced(entry)) this.#findAgain(entry);
		entry.match.score = entry.candidates[entry.match.current]?.score ?? 0;
		this.#focused = annotationId;
		this.#element(entry)?.scrollIntoView({
			block: "center",
			inline: "nearest",
			behavior: "instant",
		});
		this.overlay.setReviewing(true);
		this.#render();
		return entry.match;
	}

	clear(): void {
		this.#generation++;
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#case = undefined;
		this.#entries = [];
		this.#focused = undefined;
		this.overlay.renderReview([]);
		this.overlay.setReviewing(false);
	}

	#element(entry: Entry): Element | undefined {
		return entry.candidates[entry.match.current]?.element;
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
				// The shown candidate itself decides the colour.
				found:
					entry.match.status !== "ambiguous" &&
					entry.candidates[entry.match.current]?.found === true,
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
