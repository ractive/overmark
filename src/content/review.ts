/**
 * Loading a case onto the page in front: each annotation's element is looked
 * for by its details (match.ts) and its mark drawn again on that element, moved
 * and scaled with it: solid when found, dashed when only probable or tied; its
 * colour is its status (DEC-024). A mark without an element goes where it was. An element that a
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
	caseCounts,
	MAX_COMMENT,
	markStatus,
	type Rect,
	type Shape,
	STATUS_LABEL,
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
	MarkAnswer,
	MarkRequest,
} from "../lib/messages.ts";
import {
	type Overlay,
	type ReviewItem,
	reviewColour,
	ring,
} from "./overlay.ts";

interface Entry {
	annotation: Annotation;
	/** The best elements worth showing, best first. */
	candidates: Candidate[];
	match: AnnotationMatch;
}

/** Asks the side panel that shows the case (DEC-027). */
export type AskPanel = (request: MarkRequest) => Promise<MarkAnswer>;

/** No panel shows the case: nothing changes it from the page. */
export const NO_PANEL =
	"Open this case in Overmark's side panel to change its marks.";

const askPanel: AskPanel = async (request) => {
	try {
		const answer = (await chrome.runtime.sendMessage(request)) as
			| MarkAnswer
			| undefined;
		return answer ?? { ok: false, error: NO_PANEL };
	} catch {
		return { ok: false, error: NO_PANEL };
	}
};

/** How long "Really delete?" waits for its second click. */
export const DELETE_ARMED_MS = 4000;
/** A double click is no second thought. */
const DELETE_CLICK_GAP_MS = 400;

/** The popover of a loaded mark, open on the page (DEC-027). */
interface OpenMark {
	annotationId: string;
	field: HTMLTextAreaElement;
	problem: HTMLElement;
	remove: HTMLButtonElement;
	done: HTMLButtonElement;
	armedAt: number | undefined;
	busy: boolean;
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

/**
 * A load stopped by a clear (the panel's or the page's own Hide) or by a load
 * of another case: no failure, its marks are simply not the page's now.
 */
export class LoadReplaced extends Error {
	constructor() {
		super("Loading was replaced by another one.");
	}
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
	#loading: { caseId: string } | undefined;
	#newer: Case | undefined;
	/** The newest load: an older one of the same case ends with its result. */
	#latest: { caseId: string; run: Promise<LoadResult> } | undefined;
	/** The mark whose popover is open (DEC-027). */
	#open: OpenMark | undefined;
	readonly #ask: AskPanel;

	constructor(overlay: Overlay, ask: AskPanel = askPanel) {
		this.overlay = overlay;
		this.#ask = ask;
		overlay.onPick = (number) => this.pick(number);
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

	/** The case a load is finding marks for now, if one is under way. */
	get loadingCaseId(): string | undefined {
		return this.#loading?.caseId;
	}

	/**
	 * Find the case's elements and draw its marks. Two loads of the same case
	 * close together (the side panel's draw, an AI app's load_case, a search
	 * again) both end with the newest one's result; a load stopped by a clear
	 * or by another case's load rejects with `LoadReplaced`.
	 */
	load(c: Case): Promise<LoadResult> {
		const run: Promise<LoadResult> = this.#loadOnce(c).catch(
			(error: unknown) => {
				const newest = this.#latest;
				if (
					error instanceof LoadReplaced &&
					newest !== undefined &&
					newest.run !== run &&
					newest.caseId === c.id
				)
					// Its marks are that load's: the caller of this one may be done
					// with the case and must not take them off.
					return newest.run.then((r) => ({ ...r, adopted: true as const }));
				throw error;
			},
		);
		this.#latest = { caseId: c.id, run };
		void run
			.finally(() => {
				if (this.#latest?.run === run) this.#latest = undefined;
			})
			.catch(() => undefined);
		return run;
	}

	async #loadOnce(c: Case): Promise<LoadResult> {
		const loading = { caseId: c.id };
		this.#loading = loading;
		this.#newer = undefined;
		try {
			const result = await this.#load(c);
			const newer = this.#newer;
			this.#newer = undefined;
			this.#loading = undefined;
			if (newer === undefined) return result;
			const generation = this.#generation;
			const updated = await this.update(newer);
			// Stopped while it drew the newer copy: its first result is gone too.
			if (generation !== this.#generation) throw new LoadReplaced();
			return updated ?? result;
		} finally {
			// A newer load's, if one started meanwhile.
			if (this.#loading === loading) this.#loading = undefined;
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
			if (generation !== this.#generation) throw new LoadReplaced();
			entries.push(this.#find(search, annotation));
		}
		this.#closeMark();
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
		if (this.#loading?.caseId === c.id) {
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
		// Its mark was deleted (here, in the panel, by an AI app).
		if (this.#open !== undefined && !byId.has(this.#open.annotationId))
			this.#closeMark();
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

	/**
	 * The element an annotation's mark is drawn on now (looked for again when a
	 * re-render replaced it), without scrolling or focusing anything.
	 */
	target(
		annotationId: string,
	): { element: Element | undefined; match: AnnotationMatch } | undefined {
		const entry = this.#entries.find((e) => e.annotation.id === annotationId);
		if (entry === undefined) return undefined;
		if (this.#replaced(entry)) this.#findAgain(entry);
		return { element: this.#element(entry), match: entry.match };
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

	/**
	 * A loaded mark's pin was clicked (DEC-027): its comment opens in the
	 * popover a new mark's comment is typed in, with Delete mark and Done, and
	 * the side panel shows the mark with its other actions.
	 */
	pick(number: number): void {
		const c = this.#case;
		const entry = this.#entries.find((e) => e.annotation.number === number);
		if (c === undefined || entry === undefined) return;
		const { annotation } = entry;
		// Open for this mark already: what is being typed stays.
		if (
			this.#open?.annotationId === annotation.id &&
			!this.overlay.popover.hidden
		)
			return;
		const doc = this.overlay.doc;
		const status = markStatus(annotation);
		const pin = doc.createElement("span");
		pin.className = "pin";
		pin.style.background = reviewColour({ status });
		pin.textContent = String(annotation.number);
		const label = doc.createElement("div");
		label.className = "label";
		label.append(pin, "Comment");
		if (status !== "open") {
			const state = doc.createElement("span");
			state.className = "state";
			state.textContent = STATUS_LABEL[status];
			label.append(state);
		}
		const field = doc.createElement("textarea");
		field.setAttribute("aria-label", `Comment of mark ${annotation.number}`);
		field.placeholder = "What is wrong, or what should change?";
		field.maxLength = MAX_COMMENT;
		field.value = annotation.comment;
		field.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void this.#done();
			// What was typed is dropped, as the panel's Cancel does.
			else if (e.key === "Escape") this.#closeMark();
		});
		const problem = doc.createElement("p");
		problem.className = "problem";
		problem.setAttribute("role", "alert");
		problem.hidden = true;
		const done = doc.createElement("button");
		done.type = "button";
		done.className = "primary";
		done.dataset["action"] = "mark-done";
		done.textContent = "Done";
		done.addEventListener("click", () => void this.#done());
		const remove = doc.createElement("button");
		remove.type = "button";
		remove.dataset["action"] = "mark-delete";
		remove.textContent = "Delete mark";
		remove.addEventListener("click", () => void this.#delete());
		const row = doc.createElement("div");
		row.className = "row";
		row.append(remove, done);
		const open: OpenMark = {
			annotationId: annotation.id,
			field,
			problem,
			remove,
			done,
			armedAt: undefined,
			busy: false,
		};
		this.overlay.openPopover([label, field, problem, row], () => {
			// Closed for another popover, or by a click beside it: what was
			// typed is the mark's comment, as a new mark's is.
			if (this.#open !== open) return;
			this.#open = undefined;
			const text = field.value.trim();
			if (!open.busy && text !== annotation.comment)
				void this.#ask({
					type: "mark:comment",
					caseId: c.id,
					annotationId: annotation.id,
					text,
				});
		});
		this.#open = open;
		// Its element is outlined, as after the panel's Show.
		this.#focused = annotation.id;
		this.#render();
		field.focus();
		void this.#ask({
			type: "mark:picked",
			caseId: c.id,
			annotationId: annotation.id,
		});
	}

	/** The open popover's mark, as the case has it now. */
	#openAnnotation():
		| { c: Case; open: OpenMark; annotation: Annotation }
		| undefined {
		const c = this.#case;
		const open = this.#open;
		if (c === undefined || open === undefined) return undefined;
		const annotation = this.#entries.find(
			(e) => e.annotation.id === open.annotationId,
		)?.annotation;
		return annotation === undefined ? undefined : { c, open, annotation };
	}

	/** Ask the panel, with the buttons off meanwhile; says why it did not work. */
	async #change(open: OpenMark, request: MarkRequest): Promise<void> {
		open.busy = true;
		open.done.disabled = true;
		open.remove.disabled = true;
		open.problem.hidden = true;
		const answer = await this.#ask(request);
		if (this.#open !== open) return;
		if (answer.ok) {
			this.#closeMark();
			return;
		}
		open.busy = false;
		open.done.disabled = false;
		open.remove.disabled = false;
		open.problem.textContent = answer.error;
		open.problem.hidden = false;
	}

	/** Done: a changed comment is stored, then the popover goes. */
	async #done(): Promise<void> {
		const now = this.#openAnnotation();
		if (now === undefined || now.open.busy) return;
		const text = now.open.field.value.trim();
		if (text === now.annotation.comment) {
			this.#closeMark();
			return;
		}
		await this.#change(now.open, {
			type: "mark:comment",
			caseId: now.c.id,
			annotationId: now.annotation.id,
			text,
		});
	}

	/** Delete mark: asked twice, as in the panel; the mark leaves the case. */
	async #delete(): Promise<void> {
		const now = this.#openAnnotation();
		if (now === undefined || now.open.busy) return;
		const { open } = now;
		if (open.armedAt === undefined) {
			const at = Date.now();
			open.armedAt = at;
			open.remove.textContent = "Really delete?";
			open.remove.setAttribute("data-armed", "");
			setTimeout(() => {
				if (this.#open !== open || open.armedAt !== at || open.busy) return;
				open.armedAt = undefined;
				open.remove.textContent = "Delete mark";
				open.remove.removeAttribute("data-armed");
			}, DELETE_ARMED_MS);
			return;
		}
		if (Date.now() - open.armedAt < DELETE_CLICK_GAP_MS) return;
		await this.#change(open, {
			type: "mark:delete",
			caseId: now.c.id,
			annotationId: now.annotation.id,
		});
	}

	/** The popover goes, with what was typed in it. */
	#closeMark(): void {
		if (this.#open === undefined) return;
		this.#open = undefined;
		this.overlay.closePopover();
	}

	clear(): void {
		this.#closeMark();
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
			status: markStatus(annotation),
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
			status: markStatus(annotation),
		};
	}

	#render(): void {
		if (!this.overlay.reviewing) return;
		const items: ReviewItem[] = [];
		/** The mark the popover is open for, where it is drawn now. */
		let open: ReviewItem | undefined;
		const add = (entry: Entry, item: ReviewItem) => {
			items.push(item);
			if (entry.annotation.id === this.#open?.annotationId) open = item;
		};
		for (const entry of this.#entries) {
			if (entry.match.status === "no-element") {
				const item = this.#whereItWas(entry.annotation);
				if (item !== undefined) add(entry, item);
				continue;
			}
			const el = this.#element(entry);
			if (el === undefined || !el.isConnected) continue;
			const r = el.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) continue;
			add(
				entry,
				this.#onElement(entry, {
					x: r.x,
					y: r.y,
					width: r.width,
					height: r.height,
				}),
			);
		}
		this.overlay.renderReview(items);
		// The popover follows its mark; a mark off the page leaves it where it is.
		if (open !== undefined)
			this.overlay.placePopover(shapeBounds((open as ReviewItem).shape));
	}

	#renderBar(): void {
		const doc = this.overlay.doc;
		// Verified and closed marks are drawn, faded, but no longer counted;
		// open ones and those to verify are what to look at.
		const active = this.#entries.filter((e) => {
			const status = markStatus(e.annotation);
			return status === "open" || status === "fixed";
		});
		const found = active.filter(
			(e) => e.match.status !== "lost" && e.match.status !== "no-element",
		).length;
		const toVerify = this.#case ? caseCounts(this.#case).toVerify : 0;
		const title = doc.createElement("span");
		title.className = "title";
		title.textContent = this.#case?.title ?? "";
		const count = doc.createElement("span");
		count.className = "count";
		count.textContent =
			active.length === 0 && this.#entries.length > 0
				? "all verified or closed"
				: `${found} of ${active.length} found${toVerify > 0 ? ` · ${toVerify} to verify` : ""}`;
		const sep = doc.createElement("span");
		sep.className = "sep";
		sep.setAttribute("aria-hidden", "true");
		sep.textContent = "·";
		const text = doc.createElement("span");
		text.className = "text";
		text.dataset["role"] = "review-status";
		text.append(title, sep, count);
		const bar = this.overlay.reviewBar;
		// Hide stays the same element: a click pressed on it while the case
		// is drawn again (a mark added, a search again) still lands.
		let hide = bar.querySelector<HTMLButtonElement>(
			'[data-action="review-hide"]',
		);
		if (hide === null) {
			hide = doc.createElement("button");
			hide.type = "button";
			hide.dataset["action"] = "review-hide";
			hide.textContent = "Hide";
			hide.addEventListener("click", () => this.clear());
			bar.replaceChildren(ring(doc), text, hide);
			return;
		}
		bar.querySelector('[data-role="review-status"]')?.replaceWith(text);
	}
}
