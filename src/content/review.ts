/**
 * Loading a case onto the page in front: each annotation's element is looked
 * for by its details (match.ts) and its mark drawn again on that element, moved
 * and scaled with it: green when found, amber and dashed when only probable or
 * tied. A mark without an element goes where it was. An element that a
 * re-render replaced afterwards is looked for again.
 */

import {
	type Candidate,
	createSearch,
	findCandidates,
	type PageSearch,
} from "../lib/candidates.ts";
import {
	type Annotation,
	type Case,
	type Rect,
	type Shape,
	samePath,
	shapeBounds,
	shapeOnBox,
	translateShape,
} from "../lib/case.ts";
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
import { type Overlay, type ReviewItem, ring } from "./overlay.ts";

interface Entry {
	annotation: Annotation;
	/** The best elements worth showing, best first. */
	candidates: Candidate[];
	match: AnnotationMatch;
}

/** Let the page run between annotations: loading a big case takes a while. */
const yieldToPage = () => new Promise<void>((r) => setTimeout(r, 0));

/** The same mark, as far as the page is concerned: where and on what. */
function sameMark(a: Annotation, b: Annotation): boolean {
	return (
		a.shot === b.shot &&
		JSON.stringify(a.shape) === JSON.stringify(b.shape) &&
		JSON.stringify(a.element) === JSON.stringify(b.element)
	);
}

export class Reviewer {
	readonly overlay: Overlay;
	#case: Case | undefined;
	#entries: Entry[] = [];
	#focused: string | undefined;
	#frame = 0;
	#timer: ReturnType<typeof setInterval> | undefined;
	/** A newer load or a clear stops a load that is still running. */
	#generation = 0;
	/** The case a load is finding marks for now, and a newer version of it. */
	#loading: string | undefined;
	#newer: Case | undefined;

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
		this.#loading = c.id;
		this.#newer = undefined;
		try {
			const result = await this.#load(c);
			const newer = this.#newer;
			this.#newer = undefined;
			this.#loading = undefined;
			return newer === undefined
				? result
				: ((await this.update(newer)) ?? result);
		} finally {
			if (this.#loading === c.id) this.#loading = undefined;
		}
	}

	async #load(c: Case): Promise<LoadResult> {
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

	/**
	 * The loaded case changed (a mark settled, edited, deleted or added): its
	 * marks follow, and the candidates chosen stay for marks still the same.
	 * `null` when another case, or none, is loaded. A load of the case still
	 * running takes the newer version when it is done.
	 */
	async update(c: Case): Promise<LoadResult | null> {
		if (this.#loading === c.id) {
			this.#newer = c;
			return null;
		}
		if (this.#case?.id !== c.id) return null;
		const generation = this.#generation;
		const byId = new Map(c.annotations.map((a) => [a.id, a]));
		const kept: Entry[] = [];
		const search: Annotation[] = [];
		for (const e of this.#entries) {
			const annotation = byId.get(e.annotation.id);
			if (annotation === undefined) continue;
			// A replaced copy (an import) may give the id to another mark.
			if (sameMark(annotation, e.annotation)) kept.push({ ...e, annotation });
			else search.push(annotation);
		}
		const known = new Set(this.#entries.map((e) => e.annotation.id));
		search.push(...c.annotations.filter((a) => !known.has(a.id)));
		if (search.length > 0) {
			const page = this.#search();
			for (const annotation of search) {
				await yieldToPage();
				if (generation !== this.#generation || this.#case?.id !== c.id)
					return null;
				kept.push(this.#find(page, annotation));
			}
			kept.sort((a, b) => a.annotation.number - b.annotation.number);
			clearTextCache();
		}
		this.#case = c;
		this.#entries = kept;
		if (this.#focused !== undefined && !byId.has(this.#focused))
			this.#focused = undefined;
		this.#renderBar();
		this.#render();
		return {
			caseId: c.id,
			url: location.href,
			matches: kept.map((e) => e.match),
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
				candidates: candidates.map((k) => this.#info(k, search.context)),
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

	#info(candidate: Candidate, context: DescribeContext): CandidateInfo {
		const { element, score, found } = candidate;
		const rect = element.getBoundingClientRect();
		return {
			score: Math.round(score * 100) / 100,
			summary: summarize(
				describeElement(element, context, { selector: false }),
			),
			selector: cssSelector(element),
			visible: rect.width > 0 && rect.height > 0,
			found,
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
		const element = this.#element(entry);
		if (element !== undefined)
			element.scrollIntoView({
				block: "center",
				inline: "nearest",
				behavior: "instant",
			});
		else if (entry.match.status === "no-element")
			this.#scrollTo(entry.annotation);
		this.overlay.setReviewing(true);
		this.#render();
		return entry.match;
	}

	/** Bring a mark without an element to the middle of the window. */
	#scrollTo(annotation: Annotation): void {
		const win = this.overlay.doc.defaultView;
		if (win === null || this.#whereItWas(annotation) === undefined) return;
		const b = shapeBounds(this.#stored(annotation));
		win.scrollTo({
			left: b.x + b.width / 2 - win.innerWidth / 2,
			top: b.y + b.height / 2 - win.innerHeight / 2,
			behavior: "instant",
		});
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

	/** A mark in document coordinates, as it was on its shot. */
	#stored(annotation: Annotation): Shape {
		const shot = this.#case?.shots.find((s) => s.id === annotation.shot);
		return translateShape(
			annotation.shape,
			shot?.scrollX ?? 0,
			shot?.scrollY ?? 0,
		);
	}

	/** A mark on its element, whose box is `rect` now. */
	#onElement(entry: Entry, rect: Rect): ReviewItem {
		const { annotation } = entry;
		const details = annotation.element;
		return {
			number: annotation.number,
			shape: details
				? shapeOnBox(this.#stored(annotation), details.rect, rect)
				: annotation.shape,
			rect,
			// The shown candidate itself decides the colour.
			found:
				entry.match.status !== "ambiguous" &&
				entry.candidates[entry.match.current]?.found === true,
			focused: annotation.id === this.#focused,
			resolved: annotation.resolution !== undefined,
		};
	}

	/** A mark without an element, where it was; its page may be another route. */
	#whereItWas(annotation: Annotation): ReviewItem | undefined {
		const shot = this.#case?.shots.find((s) => s.id === annotation.shot);
		const url = shot?.url ?? this.#case?.page.url ?? "";
		if (!samePath(url, location.href)) return undefined;
		const win = this.overlay.doc.defaultView;
		return {
			number: annotation.number,
			shape: translateShape(
				this.#stored(annotation),
				-(win?.scrollX ?? 0),
				-(win?.scrollY ?? 0),
			),
			rect: null,
			found: false,
			focused: annotation.id === this.#focused,
			resolved: annotation.resolution !== undefined,
		};
	}

	#render(): void {
		if (!this.overlay.reviewing) return;
		const items: ReviewItem[] = [];
		for (const entry of this.#entries) {
			if (entry.match.status === "no-element") {
				const item = this.#whereItWas(entry.annotation);
				if (item !== undefined) items.push(item);
				continue;
			}
			const el = this.#element(entry);
			if (el === undefined || !el.isConnected) continue;
			const r = el.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) continue;
			items.push(
				this.#onElement(entry, {
					x: r.x,
					y: r.y,
					width: r.width,
					height: r.height,
				}),
			);
		}
		this.overlay.renderReview(items);
	}

	#renderBar(): void {
		const doc = this.overlay.doc;
		// Resolved marks are drawn, faded, but no longer counted.
		const open = this.#entries.filter((e) => !e.annotation.resolution);
		const total = open.length;
		const resolved = this.#entries.length - total;
		const found = open.filter(
			(e) => e.match.status !== "lost" && e.match.status !== "no-element",
		).length;
		const title = doc.createElement("span");
		title.className = "title";
		title.textContent = this.#case?.title ?? "";
		const count = doc.createElement("span");
		count.className = "count";
		count.textContent =
			resolved === 0
				? `${found} of ${total} found`
				: `${found} of ${total} open found, ${resolved} resolved`;
		const text = doc.createElement("span");
		text.className = "text";
		text.dataset["role"] = "review-status";
		text.append(title, count);
		const hide = doc.createElement("button");
		hide.type = "button";
		hide.dataset["action"] = "review-hide";
		hide.textContent = "Hide";
		hide.addEventListener("click", () => this.clear());
		this.overlay.reviewBar.replaceChildren(ring(doc), text, hide);
	}
}
