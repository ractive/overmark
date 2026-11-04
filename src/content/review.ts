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
import { classify, FOUND, PROBABLE, rank } from "../lib/match.ts";
import type {
	AnnotationMatch,
	CandidateInfo,
	LoadResult,
} from "../lib/messages.ts";
import type { Overlay } from "./overlay.ts";

/** More candidates than this are not scored for one annotation. */
const MAX_CANDIDATES = 8000;
/** After this long, annotations are not searched for in the whole page. */
const FULL_SCAN_BUDGET_MS = 4000;

interface Candidate {
	element: Element;
	score: number;
}

interface Entry {
	annotation: Annotation;
	/** The best elements worth showing, best first. */
	candidates: Candidate[];
	match: AnnotationMatch;
}

function quote(value: string): string {
	return `"${value.replace(/["\\]/g, "\\$&")}"`;
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
		let everything: { elements: Element[]; truncated: boolean } | undefined;
		const all = () => {
			if (everything === undefined) {
				const list = [...doc.body.querySelectorAll("*")].filter(own);
				everything = {
					elements: list.slice(0, MAX_CANDIDATES),
					truncated: list.length > MAX_CANDIDATES,
				};
			}
			return everything;
		};
		const deadline = performance.now() + FULL_SCAN_BUDGET_MS;
		const entries: Entry[] = [];
		for (const annotation of [...c.annotations].sort(
			(a, b) => a.number - b.number,
		)) {
			await yieldToPage();
			if (generation !== this.#generation)
				throw new Error("Loading was replaced by another one.");
			const base = {
				annotationId: annotation.id,
				number: annotation.number,
				current: 0,
			};
			const stored = annotation.element;
			if (stored === null) {
				entries.push({
					annotation,
					candidates: [],
					match: { ...base, status: "no-element", score: 0, candidates: [] },
				});
				continue;
			}
			let elements = this.#likely(stored).filter(own);
			let truncated = elements.length > MAX_CANDIDATES;
			elements = elements.slice(0, MAX_CANDIDATES);
			let ranked = rank(stored, elements.map(describe));
			if ((ranked[0]?.score ?? 0) < PROBABLE) {
				// The tag or role may have changed: score the whole page, while
				// there is time.
				if (performance.now() < deadline) {
					({ elements, truncated } = all());
					ranked = rank(stored, elements.map(describe));
				} else {
					truncated = true;
				}
			}
			const status = classify(ranked);
			const kept =
				status === "lost"
					? []
					: ranked.filter((r, i) => i === 0 || r.score >= PROBABLE);
			const candidates = kept.map((r) => ({
				element: elements[r.index] as Element,
				score: r.score,
			}));
			entries.push({
				annotation,
				candidates,
				match: {
					...base,
					status,
					score: ranked[0]?.score ?? 0,
					candidates: candidates.map((k) =>
						this.#info(k.element, k.score, context),
					),
					...(truncated ? { truncated: true } : {}),
				},
			});
		}
		this.#case = c;
		this.#entries = entries;
		this.#focused = undefined;
		this.overlay.setReviewing(true);
		clearInterval(this.#timer);
		// Layout changes (lazy content, accordions) move elements without a scroll.
		this.#timer = setInterval(() => this.#schedule(), 500);
		this.#renderBar();
		this.#render();
		return {
			caseId: c.id,
			url: location.href,
			matches: entries.map((e) => e.match),
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
		const count = entry.candidates.length;
		if (candidate !== undefined && count > 0)
			entry.match.current = ((candidate % count) + count) % count;
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
				// The shown candidate's own score decides the colour.
				found:
					entry.match.status !== "ambiguous" &&
					(entry.candidates[entry.match.current]?.score ?? 0) >= FOUND,
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
