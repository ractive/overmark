/**
 * Annotating a page: the tools (element, box, arrow, pen, note), a comment for
 * each mark, undo, and saving the marks as a case.
 *
 * Two modes (DEC-014). Without a case, the marks are drafts until "Save case"
 * stores them as a new case with a title. With a case (the side panel's "Add
 * marks", or after that save), each mark goes into the case as soon as it is
 * done: its comment confirmed, or the comment closed with the mark kept. One
 * queue adds them in order; Undo takes the last one out of the case again. A
 * mark that could not be added stays on the page with the reason and a button
 * to add it again.
 *
 * A mark's screenshot is taken when the mark is drawn (DEC-012): the page as
 * the user sees it then is the record, whatever it does afterwards. Marks drawn
 * while nothing moved or changed share one screenshot. Screenshots show the
 * page alone; saving draws the marks onto them, so undoing a mark or
 * renumbering marks never touches an image.
 *
 * On the screen a mark follows its element, wherever that scrolls or moves.
 */

import {
	type Case,
	type ElementDetails,
	imageScale,
	LANGUAGE,
	MAX_COMMENT,
	MAX_PAGE_TITLE,
	MAX_PEN_POINTS,
	MAX_TITLE,
	newId,
	type PageInfo,
	type Point,
	pendingImage,
	type Rect,
	type Shape,
	type Shot,
	shapeBounds,
	translateShape,
} from "../lib/case.ts";
import {
	createContext,
	describeElement,
	documentRect,
} from "../lib/element.ts";
import type {
	AnnotateTarget,
	CaptureResult,
	NumberCheck,
	OverlayState,
	SaveResult,
	UndoResult,
	WorkerRequest,
	WorkerResponse,
} from "../lib/messages.ts";
import { type AnnotationDraft, cropRectFor } from "../lib/save.ts";
import { parentOf, shadowTrees } from "../lib/shadow.ts";
import {
	type Afterwards,
	AI_TIMEOUT_MS,
	type Exclusive,
	type PageActivity,
	type ShowOptions,
} from "./activity.ts";
import { elementAt, elementForRect } from "./anchor.ts";
import type { PageBlur } from "./blur.ts";
import { type IconName, icon, type Overlay, ring } from "./overlay.ts";

export type Tool = "element" | "box" | "arrow" | "pen" | "note";

const TOOLS: { tool: Tool; label: string; title: string }[] = [
	{ tool: "element", label: "Element", title: "Pick an element" },
	{ tool: "box", label: "Box", title: "Draw a box" },
	{ tool: "arrow", label: "Arrow", title: "Draw an arrow" },
	{ tool: "pen", label: "Pen", title: "Draw freehand" },
	{ tool: "note", label: "Note", title: "Place a note" },
];

interface Draft {
	number: number;
	/** In document coordinates. */
	shape: Shape;
	comment: string;
	element: Element | null;
	/** Read when the mark was drawn: the element may be gone by saving. */
	details: ElementDetails | null;
	/** The element's box then, in document coordinates. */
	anchor: Rect | null;
	/** The page's address then. */
	url: string;
	/** The window's scroll position then. */
	scroll: Point;
	/** Its screenshot and its place on it, once taken. */
	/** `box`: the element in the document at the shot, if it moved since `details`. */
	shot?: { view: View; shape: Shape; box?: Rect };
	/** The case it was queued for: it never goes into another one unasked. */
	queuedFor?: { caseId: string; title: string };
}

/** One screenshot, and the marks that share it. */
interface View {
	shot: Shot;
	page: PageInfo;
	marks: Draft[];
}

interface Drag {
	pointerId: number;
	start: Point;
	points: Point[];
}

async function ask<T extends object>(request: WorkerRequest): Promise<T> {
	const response = (await chrome.runtime.sendMessage(request)) as
		| WorkerResponse<T>
		| undefined;
	if (response === undefined) throw new Error("Overmark did not answer.");
	if (!response.ok) throw new Error(response.error);
	return response;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The next frame; a tab in the background has none, and then time decides. */
const frame = () =>
	Promise.race([
		new Promise<void>((r) => requestAnimationFrame(() => r())),
		sleep(250),
	]);

/** Chrome allows two screenshots a second; the overlay stays up meanwhile. */
const SHOT_GAP_MS = 620;

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** At most `MAX_PEN_POINTS` points of a stroke, evenly spread. */
function thin(points: Point[]): Point[] {
	if (points.length <= MAX_PEN_POINTS) return points;
	const step = points.length / MAX_PEN_POINTS;
	return Array.from(
		{ length: MAX_PEN_POINTS },
		(_, i) => points[Math.floor(i * step)] as Point,
	);
}

function normalizeRect(a: Point, b: Point): Rect {
	return {
		x: Math.min(a.x, b.x),
		y: Math.min(a.y, b.y),
		width: Math.abs(a.x - b.x),
		height: Math.abs(a.y - b.y),
	};
}

export class Annotator {
	readonly overlay: Overlay;
	#drafts: Draft[] = [];
	/** The target case's marks saved from this page: shown, no longer changed. */
	#savedMarks: Draft[] = [];
	#tool: Tool | null = null;
	#hover: Element | null = null;
	#drag: Drag | null = null;
	#preview: Shape | null = null;
	#editing: Draft | null = null;
	#target: AnnotateTarget | undefined;
	#blurForms = false;
	#saveForm = false;
	#title = "";
	#message = "";
	#frame = 0;
	#views: View[] = [];
	/** The screenshot the page still looks like, if any: a new mark can share it. */
	#shown: View | undefined;
	/** Screenshots run one after the other; this never rejects. */
	#shots: Promise<void> = Promise.resolve();
	#lastShot = 0;
	/** Where pending screenshots are stored until a save takes them. */
	#pendingCase: string | undefined;
	/** Since the last screenshot, something scrolled or the window changed. */
	#scrolled = true;
	/** Since the last screenshot, the page's DOM changed. */
	#mutated = true;
	#observer: MutationObserver | undefined;
	/** Lets go of the blur while a screenshot is taken. */
	#unblur: (() => void) | undefined;
	/** The last screenshot's page scrolled while it was taken. */
	#shotMoved = false;
	#saveCalled = false;
	/** "Save case" is storing the drafts as a new case now. */
	#savingCase = false;
	/** Adding to a case: what changes it (adds, undos) runs in order. */
	#ops: Promise<void> = Promise.resolve();
	/** Drafts waiting to be added to the case, or being added now. */
	#queued = new Set<Draft>();
	/** Drafts that could not be added, with why. */
	#failed = new Map<Draft, string>();
	/** Marks this toolbar added to the case, oldest first: Undo takes them out. */
	#added: Draft[] = [];
	/** Marks Undo is taking out of the case. */
	#undoing = new Set<Draft>();
	/** Done was clicked: the toolbar goes once the marks are in. */
	#finishing = false;
	/** Done (or the side panel's end) under way: a second one waits for it. */
	#finishRun: Promise<void> | undefined;
	/** What the side panel last heard: the drafts, the case, a save. */
	#announced = "";
	/** Done found these marks not in the case: Done again discards them. */
	#leftOut: Set<Draft> | undefined;
	/** A failure, said with role="alert" next to the status. */
	#alert = "";
	/** The toolbar's status and alert: kept, and changed in place. */
	readonly #statusEl: HTMLElement;
	readonly #alertEl: HTMLElement;

	readonly #pageBlur: PageBlur;
	readonly #activity: PageActivity;

	constructor(overlay: Overlay, blur: PageBlur, activity: PageActivity) {
		this.overlay = overlay;
		this.#pageBlur = blur;
		this.#activity = activity;
		this.#statusEl = overlay.doc.createElement("span");
		this.#statusEl.className = "status";
		this.#statusEl.dataset["role"] = "status";
		this.#statusEl.setAttribute("role", "status");
		this.#alertEl = overlay.doc.createElement("span");
		this.#alertEl.className = "status";
		this.#alertEl.dataset["role"] = "alert";
		this.#alertEl.setAttribute("role", "alert");
		const capture = overlay.capture;
		capture.addEventListener("pointermove", (e) => this.#move(e));
		capture.addEventListener("pointerdown", (e) => this.#down(e));
		capture.addEventListener("pointerup", (e) => this.#up(e));
		capture.addEventListener("pointercancel", () => {
			this.#drag = null;
			this.#preview = null;
			this.#render();
		});
		capture.addEventListener("wheel", (e) => this.#wheel(e), {
			passive: false,
		});
		const doc = overlay.doc;
		const win = doc.defaultView;
		const moved = () => {
			this.#scrolled = true;
			this.#schedule();
		};
		// Capture phase: scrolling inside a container moves elements too.
		doc.addEventListener("scroll", moved, { capture: true, passive: true });
		win?.addEventListener("resize", moved);
		// What no mutation shows: typed values, checkboxes, a canvas redrawn.
		for (const type of ["input", "change", "click", "keydown"])
			win?.addEventListener(
				type,
				(e) => {
					if (e.target !== overlay.host) this.#mutated = true;
				},
				true,
			);
		win?.addEventListener(
			"keydown",
			(e) => {
				if (!overlay.annotating || e.key !== "Escape") return;
				if (this.#editing !== null) this.#commitComment();
				else if (this.#saveForm) this.#setSaveForm(false);
				else if (this.#tool !== null) this.setTool(null);
				else return;
				// It was for Overmark, not for a dialog the page has open.
				e.preventDefault();
				e.stopImmediatePropagation();
			},
			true,
		);
		win?.addEventListener("beforeunload", (e) => {
			if (this.#drafts.length > 0) e.preventDefault();
		});
		win?.addEventListener("pagehide", (e) => {
			if (!e.persisted) this.#discard(this.#views.map((v) => v.shot.id));
		});
		overlay.onTick = () => this.#render();
		if (win !== null && typeof win.MutationObserver === "function")
			this.#observer = new win.MutationObserver(() => {
				this.#mutated = true;
			});
		this.#renderToolbar();
	}

	state(): OverlayState {
		const state: OverlayState = {
			visible: this.overlay.annotating,
			url: location.href,
			title: document.title,
			drafts: this.#drafts.length,
			saving: this.#activity.saving,
		};
		if (this.#target) state.target = this.#target;
		return state;
	}

	show(options: ShowOptions): void {
		// During a save its case stays; the new one applies when it is over.
		if (!this.#activity.defer({ kind: "show", options })) {
			const before = this.#target;
			const next = options.target;
			if (next?.caseId !== before?.caseId) {
				this.#savedMarks = [];
				this.#added = [];
				if (next === undefined) {
					// Drafts of a new case now.
					this.#failed.clear();
					for (const d of this.#drafts) delete d.queuedFor;
				}
				// Not moved into another case unasked: they wait for "Add mark N".
				else
					for (const d of this.#failed.keys())
						this.#failed.set(d, this.#notFor(d, next));
			}
			this.#target = next;
			this.#blurForms = options.blurForms ?? false;
			this.#message = "";
			this.#alert = "";
			if (this.#target !== undefined) this.#saveForm = false;
			this.#renumber();
			// Marks drawn before a case was chosen go into it now.
			this.#addDone();
		}
		this.overlay.setAnnotating(true);
		// What happened while the toolbar was away is not known.
		this.#mutated = true;
		this.#watch();
		this.#renderToolbar();
		this.#render();
	}

	hide(): void {
		// A save still running finishes first.
		if (this.#activity.defer({ kind: "hide" })) return;
		if (this.#editing !== null) this.#commitComment();
		this.setTool(null);
		this.overlay.setAnnotating(false);
		this.#observer?.disconnect();
		// Shown again, the page may look different: the next mark takes a new shot.
		this.#shown = undefined;
		this.#retire();
		// Undo reaches only marks added since the toolbar was last shown.
		this.#added = [];
		this.#leftOut = undefined;
	}

	/** The side panel's "Blur form fields in screenshots". */
	setBlurForms(on: boolean): void {
		this.#blurForms = on;
	}

	#watch(): void {
		if (!this.overlay.annotating) return;
		// Shadow roots too: a mutation inside one is not reported outside it.
		for (const root of shadowTrees(this.overlay.doc, this.overlay.host))
			this.#observer?.observe(root, {
				subtree: true,
				childList: true,
				attributes: true,
				characterData: true,
			});
	}

	setTool(tool: Tool | null): void {
		if (!this.#activity.saving) this.#message = "";
		this.#alert = "";
		this.#tool = tool;
		this.#hover = null;
		this.#drag = null;
		this.#preview = null;
		const capture = this.overlay.capture;
		capture.classList.toggle("active", tool !== null);
		capture.classList.toggle("element", tool === "element");
		this.#renderToolbar();
		this.#render();
	}

	// --- pointer -------------------------------------------------------------

	/** The layer that takes the pointer covers the page: pass the wheel on. */
	#wheel(e: WheelEvent): void {
		const win = this.overlay.doc.defaultView;
		const root = this.overlay.doc.scrollingElement;
		let at = elementAt(e.clientX, e.clientY, this.overlay.host);
		for (; at !== null && at !== root; at = parentOf(at)) {
			const { overflowY, overflowX } = win?.getComputedStyle(at) ?? {};
			const scrolls = (overflow: string | undefined) =>
				overflow === "auto" || overflow === "scroll";
			if (
				(scrolls(overflowY) && at.scrollHeight > at.clientHeight) ||
				(scrolls(overflowX) && at.scrollWidth > at.clientWidth)
			) {
				e.preventDefault();
				const unit = e.deltaMode === 1 ? 16 : 1;
				at.scrollBy(e.deltaX * unit, e.deltaY * unit);
				return;
			}
		}
	}

	#scroll(): Point {
		const win = this.overlay.doc.defaultView;
		return { x: win?.scrollX ?? 0, y: win?.scrollY ?? 0 };
	}

	#toDocument(e: PointerEvent): Point {
		const s = this.#scroll();
		return { x: e.clientX + s.x, y: e.clientY + s.y };
	}

	#move(e: PointerEvent): void {
		if (this.#tool === "element" && this.#drag === null) {
			this.#hover = elementAt(e.clientX, e.clientY, this.overlay.host);
			this.#schedule();
			return;
		}
		const drag = this.#drag;
		if (drag === null || e.pointerId !== drag.pointerId) return;
		const p = this.#toDocument(e);
		if (this.#tool === "pen") {
			const last = drag.points.at(-1);
			if (last === undefined || Math.hypot(p.x - last.x, p.y - last.y) >= 3)
				drag.points.push(p);
			this.#preview = { kind: "pen", points: [...drag.points] };
		} else if (this.#tool === "box") {
			this.#preview = { kind: "box", rect: normalizeRect(drag.start, p) };
		} else if (this.#tool === "arrow") {
			this.#preview = { kind: "arrow", from: drag.start, to: p };
		}
		this.#schedule();
	}

	#down(e: PointerEvent): void {
		if (e.button !== 0 || this.#tool === null) return;
		e.preventDefault();
		if (this.#editing !== null) {
			this.#commitComment();
			return;
		}
		const p = this.#toDocument(e);
		this.#drag = { pointerId: e.pointerId, start: p, points: [p] };
		this.overlay.capture.setPointerCapture?.(e.pointerId);
	}

	#up(e: PointerEvent): void {
		const drag = this.#drag;
		if (drag === null || e.pointerId !== drag.pointerId) return;
		this.#drag = null;
		this.#preview = null;
		const p = this.#toDocument(e);
		const s = this.#scroll();
		const host = this.overlay.host;
		const toWindow = (r: Rect): Rect => ({ ...r, x: r.x - s.x, y: r.y - s.y });
		switch (this.#tool) {
			case "element": {
				const el = elementAt(e.clientX, e.clientY, host);
				if (el !== null)
					this.#add({ kind: "element", rect: documentRect(el, s) }, el);
				break;
			}
			case "box": {
				const rect = normalizeRect(drag.start, p);
				if (rect.width >= 6 && rect.height >= 6)
					this.#add(
						{ kind: "box", rect },
						elementForRect(toWindow(rect), host),
					);
				break;
			}
			case "arrow":
				if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) >= 12)
					this.#add(
						{ kind: "arrow", from: drag.start, to: p },
						elementAt(e.clientX, e.clientY, host),
					);
				break;
			case "pen": {
				const points = thin([...drag.points, p]);
				const shape: Shape = { kind: "pen", points };
				const bounds = shapeBounds(shape);
				if (points.length >= 2 && bounds.width + bounds.height >= 8)
					this.#add(shape, elementForRect(toWindow(bounds), host));
				break;
			}
			case "note":
				this.#add(
					{ kind: "note", at: p },
					elementAt(e.clientX, e.clientY, host),
				);
				break;
			case null:
				break;
		}
		this.#render();
	}

	// --- marks and comments --------------------------------------------------

	/** Number the unsaved marks on from the target's next number (or 1 for a new case). */
	#renumber(): void {
		let next = this.#target?.nextAnnotation ?? 1;
		for (const draft of this.#drafts) draft.number = next++;
		if (this.#editing === null) return;
		const { number } = this.#editing;
		const { popover } = this.overlay;
		const pin = popover.querySelector(".pin");
		if (pin !== null) pin.textContent = String(number);
		popover
			.querySelector("textarea")
			?.setAttribute("aria-label", `Comment for mark ${number}`);
	}

	#nextNumber(): number {
		const first = this.#target?.nextAnnotation ?? 1;
		return Math.max(first - 1, ...this.#drafts.map((d) => d.number)) + 1;
	}

	#add(shape: Shape, element: Element | null): void {
		const draft: Draft = {
			number: this.#nextNumber(),
			shape,
			comment: "",
			element,
			details:
				element === null
					? null
					: describeElement(element, createContext(this.overlay.doc)),
			anchor: element === null ? null : documentRect(element, this.#scroll()),
			url: location.href,
			scroll: this.#scroll(),
		};
		this.#message = "";
		this.#alert = "";
		this.#leftOut = undefined;
		this.#drafts.push(draft);
		this.#openComment(draft);
		this.#shootLater(draft);
		this.#renderToolbar();
	}

	/** Take a draft out, with its screenshot if no other mark shares it. */
	#forget(draft: Draft): void {
		this.#drafts = this.#drafts.filter((d) => d !== draft);
		const view = draft.shot?.view;
		if (view === undefined) return;
		view.marks = view.marks.filter((d) => d !== draft);
		if (view.marks.length > 0) {
			this.#retire();
			return;
		}
		this.#views = this.#views.filter((v) => v !== view);
		if (this.#shown === view) this.#shown = undefined;
		this.#discard([view.shot.id]);
	}

	#openComment(draft: Draft): void {
		this.#editing = draft;
		const doc = this.overlay.doc;
		const popover = this.overlay.popover;
		const pin = doc.createElement("span");
		pin.className = "pin";
		pin.textContent = String(draft.number);
		const label = doc.createElement("div");
		label.className = "label";
		label.append(pin, "Comment");
		const field = doc.createElement("textarea");
		field.setAttribute("aria-label", `Comment for mark ${draft.number}`);
		field.placeholder = "What is wrong, or what should change?";
		field.maxLength = MAX_COMMENT;
		field.value = draft.comment;
		field.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) this.#commitComment();
		});
		const done = doc.createElement("button");
		done.type = "button";
		done.className = "primary";
		done.dataset["action"] = "comment-done";
		done.textContent = "Done";
		done.addEventListener("click", () => this.#commitComment());
		const remove = doc.createElement("button");
		remove.type = "button";
		remove.dataset["action"] = "comment-remove";
		remove.textContent = "Remove mark";
		remove.addEventListener("click", () => {
			this.#forget(draft);
			this.#closeComment();
		});
		const row = doc.createElement("div");
		row.className = "row";
		row.append(remove, done);
		popover.replaceChildren(label, field, row);
		popover.hidden = false;
		this.#placePopover(draft);
		field.focus();
	}

	#placePopover(draft: Draft): void {
		const win = this.overlay.doc.defaultView;
		const b = shapeBounds(this.#onWindow(draft));
		const vw = win?.innerWidth ?? 1024;
		const vh = win?.innerHeight ?? 768;
		const width = 296;
		const height = 160;
		let x = b.x;
		let y = b.y + b.height + 12;
		if (y + height > vh) y = b.y - height - 12;
		x = Math.min(Math.max(8, x), vw - width - 8);
		y = Math.min(Math.max(8, y), vh - height - 70);
		this.overlay.popover.style.left = `${x}px`;
		this.overlay.popover.style.top = `${y}px`;
	}

	#commitComment(): void {
		const draft = this.#editing;
		const field = this.overlay.popover.querySelector("textarea");
		if (draft !== null && field !== null) draft.comment = field.value.trim();
		this.#closeComment();
		this.#addDone();
	}

	#closeComment(): void {
		this.#editing = null;
		this.overlay.popover.hidden = true;
		this.overlay.popover.replaceChildren();
		this.#renderToolbar();
		this.#render();
	}

	/**
	 * Take back the last mark: a draft goes from the page; a mark added to the
	 * case (or on its way there) is taken out of the case too, in turn.
	 */
	undo(): void {
		this.#message = "";
		this.#alert = "";
		const last = lastMark(
			[...this.#drafts, ...this.#added].filter((d) => !this.#undoing.has(d)),
		);
		if (last === undefined) {
			// Nothing to take back.
		} else if (this.#drafts.includes(last) && !this.#queued.has(last)) {
			this.#failed.delete(last);
			this.#forget(last);
			if (last === this.#editing) this.#closeComment();
		} else {
			this.#undoing.add(last);
			this.#queue(() => this.#undoAdded(last));
		}
		this.#renderToolbar();
		this.#render();
	}

	// --- rendering -----------------------------------------------------------

	#schedule(): void {
		if (this.#frame !== 0) return;
		this.#frame = requestAnimationFrame(() => {
			this.#frame = 0;
			this.#render();
		});
	}

	/** A mark in window coordinates: with its element, if that is still there. */
	#onWindow(draft: Draft): Shape {
		const s = this.#scroll();
		const box = draft.element?.isConnected
			? draft.element.getBoundingClientRect()
			: undefined;
		if (
			box === undefined ||
			draft.anchor === null ||
			(box.width === 0 && box.height === 0)
		)
			return translateShape(draft.shape, -s.x, -s.y);
		if (draft.shape.kind === "element") {
			const { x, y, width, height } = box;
			return { kind: "element", rect: { x, y, width, height } };
		}
		return translateShape(
			draft.shape,
			box.x - draft.anchor.x,
			box.y - draft.anchor.y,
		);
	}

	/** Marks whose element left (another route, a menu that closed) stay off the page. */
	#onPage(draft: Draft): boolean {
		return draft.element === null
			? draft.url === location.href
			: draft.element.isConnected;
	}

	#render(): void {
		if (!this.overlay.annotating) return;
		const s = this.#scroll();
		const toWindow = (shape: Shape) => translateShape(shape, -s.x, -s.y);
		const hover =
			this.#tool === "element" && this.#hover !== null
				? this.#hover.getBoundingClientRect()
				: null;
		const rendered = (marks: Draft[]) =>
			marks
				.filter((d) => this.#onPage(d))
				.map((d) => ({ number: d.number, shape: this.#onWindow(d) }));
		this.overlay.render(
			rendered(this.#drafts),
			this.#preview === null ? null : toWindow(this.#preview),
			hover === null
				? null
				: { x: hover.x, y: hover.y, width: hover.width, height: hover.height },
			rendered(this.#savedMarks),
		);
		if (this.#editing !== null) this.#placePopover(this.#editing);
	}

	#button(
		label: string,
		action: string,
		onClick: () => void,
		image?: IconName,
	): HTMLButtonElement {
		const doc = this.overlay.doc;
		const b = doc.createElement("button");
		b.type = "button";
		if (image !== undefined) b.append(icon(doc, image));
		b.append(label);
		b.dataset["action"] = action;
		b.addEventListener("click", onClick);
		return b;
	}

	#setSaveForm(on: boolean): void {
		this.#saveForm = on;
		this.#renderToolbar();
	}

	/**
	 * The case the toolbar adds to changed: deleted marks leave the saved ones
	 * drawn faintly, and where its marks are loaded those draw them instead.
	 */
	caseChanged(c: Case, loaded: boolean): void {
		if (this.#target?.caseId !== c.id) return;
		const numbers = new Set(c.annotations.map((x) => x.number));
		this.#savedMarks = loaded
			? []
			: this.#savedMarks.filter((d) => numbers.has(d.number));
		this.#added = this.#added.filter((d) => numbers.has(d.number));
		this.#render();
	}

	/**
	 * The side panel closes the case (DEC-023): finish as Done does and, once
	 * the toolbar is hidden, add to no case any more, so the next show starts
	 * a new one. A mark that could not be added keeps the toolbar up, adding
	 * to the case, unless `discard`: then the marks not in the case go.
	 * Without `retry` it is Done's own second click where an earlier Done left
	 * marks out (they go); with it they are tried once more.
	 */
	async end(
		caseId: string,
		{
			discard = false,
			retry = false,
		}: { discard?: boolean; retry?: boolean } = {},
	): Promise<void> {
		if (this.#target?.caseId !== caseId) return;
		// Not a Done again: what an earlier Done left out is tried once more.
		if (retry) this.#leftOut = undefined;
		if (discard) await this.#discardLeft();
		else await this.#finish();
		// Shown for another case meanwhile, or a mark is still not in this one.
		if (this.#target?.caseId !== caseId || this.overlay.annotating) return;
		this.#forgetTarget();
	}

	/** Add to no case any more: the next marks are a new case's drafts. */
	#forgetTarget(): void {
		this.#target = undefined;
		this.#savedMarks = [];
		this.#added = [];
		this.#failed.clear();
		for (const d of this.#drafts) delete d.queuedFor;
		this.#leftOut = undefined;
		this.#alert = "";
		this.#message = "";
		this.#renumber();
		this.#renderToolbar();
		this.#render();
	}

	/**
	 * Leave without the marks that are not in the case: the toolbar goes at
	 * once its queue is empty (a mark being added goes in), a comment being
	 * typed goes with its mark.
	 */
	async #discardLeft(): Promise<void> {
		await this.#finishRun;
		const editing = this.#editing;
		if (editing !== null) {
			this.#forget(editing);
			this.#closeComment();
		}
		this.setTool(null);
		this.#finishing = true;
		this.#renderToolbar();
		try {
			await this.#settled();
		} finally {
			this.#finishing = false;
		}
		for (const d of [...this.#drafts]) {
			this.#failed.delete(d);
			this.#forget(d);
		}
		this.#leftOut = undefined;
		this.#alert = "";
		this.#message = "";
		this.hide();
		this.#renderToolbar();
	}

	/** Until the queue is empty, with what was queued meanwhile. */
	async #settled(): Promise<void> {
		for (let ops = this.#ops; ; ops = this.#ops) {
			await ops;
			if (ops === this.#ops) return;
		}
	}

	/**
	 * Tell the side panel when what it shows of the page changed (the drafts'
	 * count, the case added to, a save under way): it opens a case that a
	 * save made (DEC-023) and says how many marks are not saved yet.
	 */
	#announce(): void {
		const now = JSON.stringify([
			this.#drafts.length,
			this.#target?.caseId,
			this.#activity.saving,
		]);
		if (now === this.#announced) return;
		this.#announced = now;
		this.overlay.onChange?.();
	}

	#renderToolbar(): void {
		this.#announce();
		const doc = this.overlay.doc;
		const bar = this.overlay.toolbar;
		const brand = ring(doc);
		const sep = () => {
			const s = doc.createElement("span");
			s.className = "sep";
			return s;
		};
		const count = this.#drafts.length;
		const target = this.#target;
		if (this.#savingCase) {
			this.#mount([brand], this.#message || "Saving…", []);
			return;
		}
		if (this.#saveForm && target === undefined) {
			const title = doc.createElement("input");
			title.type = "text";
			title.placeholder = "Case title";
			title.setAttribute("aria-label", "Case title");
			title.maxLength = MAX_TITLE;
			title.value = this.#title;
			title.addEventListener("input", () => {
				this.#title = title.value;
			});
			title.addEventListener("keydown", (e) => {
				if (e.key === "Enter") void this.save(title.value);
			});
			const save = this.#button(
				"Save case",
				"save-confirm",
				() => void this.save(title.value),
			);
			save.className = "primary";
			const keep = this.#button("Keep drawing", "save-cancel", () =>
				this.#setSaveForm(false),
			);
			keep.title = "Close this without saving; the marks stay";
			this.#mount([brand, title], this.#message, [save, keep]);
			title.focus();
			title.select();
			return;
		}
		const tools = TOOLS.map(({ tool, label, title }) => {
			const b = this.#button(
				label,
				`tool-${tool}`,
				() => this.setTool(this.#tool === tool ? null : tool),
				tool,
			);
			b.title = title;
			b.setAttribute("aria-pressed", String(this.#tool === tool));
			return b;
		});
		const undo = this.#button("Undo", "undo", () => this.undo(), "undo");
		const last = lastMark(
			[...this.#drafts, ...this.#added].filter((d) => !this.#undoing.has(d)),
		);
		undo.disabled = last === undefined;
		if (last !== undefined)
			undo.title =
				target !== undefined && !this.#drafts.includes(last)
					? `Take mark ${last.number} out of “${target.title}”`
					: `Remove mark ${last.number}`;
		const middle: Element[] = [undo];
		if (target === undefined) {
			const save = this.#button("Save case…", "save", () => {
				if (this.#editing !== null) this.#commitComment();
				this.setTool(null);
				this.#title = doc.title.slice(0, 120);
				this.#setSaveForm(true);
			});
			save.title = "Save the marks as a new case";
			save.disabled = count === 0;
			if (count > 0) save.className = "primary";
			middle.push(save);
		} else {
			const failed = [...this.#failed.keys()];
			if (failed.length > 0) {
				const again = this.#button(
					failed.length === 1
						? `Add mark ${(failed[0] as Draft).number}`
						: `Add ${failed.length} marks`,
					"retry",
					() => this.#retry(),
				);
				again.className = "primary";
				again.title = `Try again to add to “${target.title}”`;
				middle.push(again);
			}
		}
		const top = bar.classList.contains("top");
		const move = this.#button(
			"",
			"move-toolbar",
			() => {
				bar.classList.toggle("top");
				this.#renderToolbar();
			},
			top ? "down" : "up",
		);
		move.title = top ? "Move the toolbar down" : "Move the toolbar up";
		move.setAttribute("aria-label", move.title);
		const close =
			target === undefined
				? this.#button("Close", "close", () => this.hide(), "close")
				: this.#button("Done", "close", () => void this.#finish(), "close");
		if (target !== undefined) {
			close.title =
				this.#leftOut === undefined
					? "Stop adding marks"
					: "Discard the marks that are not in the case, and stop";
			close.disabled = this.#finishing;
		}
		this.#mount(
			[brand, ...tools, sep(), ...middle, sep()],
			this.#message || this.#statusText(),
			[close, move],
		);
	}

	/**
	 * Put the toolbar's parts around its status and alert, which stay where
	 * they are (live regions are announced when changed in place), and give
	 * the focus back to the button that had it.
	 */
	#mount(before: Element[], status: string, after: Element[]): void {
		const bar = this.overlay.toolbar;
		const root = bar.getRootNode() as Document | ShadowRoot;
		const focused = root.activeElement;
		const action =
			focused instanceof HTMLElement && bar.contains(focused)
				? focused.dataset["action"]
				: undefined;
		const statusEl = this.#statusEl;
		const alertEl = this.#alertEl;
		for (const child of [...bar.children])
			if (child !== statusEl && child !== alertEl) child.remove();
		if (statusEl.parentNode !== bar) bar.append(statusEl);
		if (statusEl.nextSibling !== alertEl) statusEl.after(alertEl);
		if (statusEl.textContent !== status) statusEl.textContent = status;
		statusEl.hidden = status === "";
		const alert = this.#alert || this.#failureText();
		if (alertEl.textContent !== alert) alertEl.textContent = alert;
		alertEl.hidden = alert === "";
		statusEl.before(...before);
		alertEl.after(...after);
		if (action !== undefined)
			bar
				.querySelector<HTMLElement>(`[data-action="${CSS.escape(action)}"]`)
				?.focus();
	}

	/** Why the last mark that could not be added is not in the case. */
	#failureText(): string {
		if (this.#target === undefined) return "";
		const last = [...this.#failed].at(-1);
		return last === undefined
			? ""
			: `Mark ${last[0].number} was not added: ${last[1]}`;
	}

	/** What the toolbar says when nothing just happened. */
	#statusText(): string {
		const target = this.#target;
		const count = this.#drafts.length;
		if (target === undefined)
			return count === 0
				? "New case: choose a tool"
				: `New case: ${count} mark${count === 1 ? "" : "s"}`;
		const failed = [...this.#failed.keys()];
		if (failed.length === 1)
			return `Mark ${(failed[0] as Draft).number} is not in “${target.title}” yet`;
		if (failed.length > 1)
			return `${failed.length} marks are not in “${target.title}” yet`;
		return `Adding to “${target.title}”`;
	}

	// --- screenshots ---------------------------------------------------------

	#pendingId(): string {
		this.#pendingCase ??= newId("c");
		return this.#pendingCase;
	}

	/**
	 * Views no mark waits for and the page no longer looks like: their pending
	 * screenshots go (marks added one by one leave them for the next mark).
	 */
	#retire(): void {
		const gone = this.#views.filter(
			(v) =>
				v !== this.#shown && !v.marks.some((d) => this.#drafts.includes(d)),
		);
		if (gone.length === 0) return;
		this.#views = this.#views.filter((v) => !gone.includes(v));
		this.#discard(gone.map((v) => v.shot.id));
	}

	#discard(shotIds: string[]): void {
		if (shotIds.length === 0) return;
		const caseId = this.#pendingId();
		ask({ type: "images:discard", caseId, shotIds }).catch(() => undefined);
	}

	/**
	 * Give a mark a screenshot, after the ones already on their way. Whether it
	 * shares the last one is decided now: by its turn the page may have moved on.
	 */
	#shootLater(draft: Draft): void {
		const same = !this.#scrolled && !this.#mutated;
		const shape = this.#onWindow(draft);
		this.#shots = this.#shots
			.then(() => this.#shoot(draft, same, shape))
			.catch((error: unknown) => {
				this.#message = `No screenshot of mark ${draft.number} yet: ${errorText(error)}`;
				this.#renderToolbar();
			});
	}

	async #shoot(draft: Draft, same: boolean, drawn: Shape): Promise<void> {
		if (draft.shot !== undefined || !this.#drafts.includes(draft)) return;
		const shown = this.#shown;
		if (same && shown !== undefined && shown.shot.url === draft.url) {
			shown.marks.push(draft);
			draft.shot = { view: shown, shape: drawn };
			return;
		}
		await this.#take(draft, drawn);
	}

	/** Wait for the page: an AI app's screenshot is over soon, or times out. */
	async #hold(kind: Extract<Exclusive, "shot" | "saving">): Promise<void> {
		for (let waited = 0; ; waited += 200) {
			const started = this.#activity.begin(kind);
			if (started.ok) return;
			if (waited > AI_TIMEOUT_MS) throw new Error(started.error);
			await sleep(200);
		}
	}

	#scrollTo(to: Point): void {
		const now = this.#scroll();
		if (now.x !== to.x || now.y !== to.y)
			this.overlay.doc.defaultView?.scrollTo({
				left: to.x,
				top: to.y,
				behavior: "instant",
			});
	}

	/** The screenshot is taken: the page and the overlay are back. */
	captured(): void {
		if (this.#unblur === undefined) return;
		this.#unblur();
		this.#unblur = undefined;
		this.#shotMoved = this.#scrolled;
		this.overlay.setCapturing(false);
		this.#watch();
	}

	/**
	 * A new screenshot of the page as it is, for `draft`. With `drawn`, where the
	 * mark was drawn, it is given up when the page moved on: the image would not
	 * show the mark, and the page is not moved while the user works. Saving then
	 * takes it, without `drawn`.
	 */
	async #take(draft: Draft, drawn?: Shape): Promise<void> {
		await this.#hold("shot");
		try {
			const gap = this.#lastShot + SHOT_GAP_MS - Date.now();
			if (gap > 0) await sleep(gap);
			if (drawn !== undefined) {
				const now = shapeBounds(this.#onWindow(draft));
				const then = shapeBounds(drawn);
				if (now.x !== then.x || now.y !== then.y || location.href !== draft.url)
					return;
			}
			const win = this.overlay.doc.defaultView as Window;
			const shotId = newId("p");
			this.#shown = undefined;
			// The blur changes the page's DOM, which is no change of the page.
			this.#observer?.disconnect();
			this.overlay.setCapturing(true);
			this.#unblur = this.#pageBlur.hold(this.#blurForms);
			let image: CaptureResult;
			let shape: Shape;
			let box: Rect | undefined;
			let scroll: Point;
			let viewport: PageInfo["viewport"];
			try {
				// Two frames: the first paints what was just changed.
				await frame();
				await frame();
				shape = this.#onWindow(draft);
				scroll = this.#scroll();
				box = this.#boxOn(draft, scroll);
				viewport = {
					width: win.innerWidth,
					height: win.innerHeight,
					dpr: win.devicePixelRatio || 1,
				};
				this.#scrolled = false;
				this.#mutated = false;
				image = await ask<CaptureResult>({
					type: "capture",
					caseId: this.#pendingId(),
					shotId,
				});
			} finally {
				this.captured();
				this.#lastShot = Date.now();
			}
			// The coordinates are from before: the image may be from after.
			if (this.#shotMoved && drawn !== undefined) {
				this.#discard([shotId]);
				return;
			}
			const view = this.#view(shotId, scroll, viewport, image);
			view.marks.push(draft);
			this.#views.push(view);
			this.#shown = view;
			// The one shown before may be needed no longer.
			this.#retire();
			draft.shot = { view, shape, ...(box ? { box } : {}) };
			// Undone while it was being taken.
			if (!this.#drafts.includes(draft)) this.#forget(draft);
		} finally {
			this.#activity.end("shot");
		}
	}

	/** At saving, nobody is using the page: back to where a mark was drawn. */
	async #takeBack(draft: Draft): Promise<void> {
		const win = this.overlay.doc.defaultView as Window;
		const here = this.#scroll();
		this.#scrollTo(draft.scroll);
		const at = shapeBounds(this.#onWindow(draft));
		if (
			at.x + at.width < 0 ||
			at.y + at.height < 0 ||
			at.x > win.innerWidth ||
			at.y > win.innerHeight
		)
			draft.element?.scrollIntoView({
				block: "center",
				inline: "nearest",
				behavior: "instant",
			});
		try {
			await this.#take(draft);
		} finally {
			this.#scrollTo(here);
		}
	}

	/** Where a mark's element is now, in the document, if it has a box. */
	#boxOn(draft: Draft, scroll: Point): Rect | undefined {
		if (!draft.element?.isConnected) return undefined;
		const box = documentRect(draft.element, scroll);
		return box.width === 0 && box.height === 0 ? undefined : box;
	}

	#view(
		shotId: string,
		scroll: Point,
		viewport: PageInfo["viewport"],
		image: CaptureResult,
	): View {
		const doc = this.overlay.doc;
		return {
			shot: {
				id: shotId,
				image: pendingImage(shotId),
				scrollX: scroll.x,
				scrollY: scroll.y,
				viewport: {
					...viewport,
					dpr: imageScale(image.width, viewport.width, viewport.dpr),
				},
				capturedAt: new Date().toISOString(),
				url: location.href,
			},
			page: {
				url: location.href,
				title: doc.title.slice(0, MAX_PAGE_TITLE),
				lang: LANGUAGE.test(doc.documentElement.lang)
					? doc.documentElement.lang
					: "",
				viewport,
				userAgent: navigator.userAgent,
			},
			marks: [],
		};
	}

	// --- saving --------------------------------------------------------------

	/** What the case stores for a draft that has its screenshot. */
	#annotationOf(d: Draft): AnnotationDraft {
		const { view, shape, box } = d.shot as NonNullable<Draft["shot"]>;
		return {
			id: `a${d.number}`,
			number: d.number,
			shot: view.shot.id,
			comment: d.comment,
			author: "user",
			shape,
			// Where the shot shows it: loading places the mark relative to it.
			element: d.details && box ? { ...d.details, rect: box } : d.details,
			cropRect: cropRectFor(shapeBounds(shape), view.shot.viewport),
		};
	}

	/** What to do once the page is free again: hide only after a success. */
	#afterwards(afterwards: Afterwards | undefined, ok: boolean): void {
		if (afterwards?.kind === "hide") {
			// A failure stays up with its error, or its marks would be lost.
			if (ok) this.hide();
		} else if (afterwards?.kind === "show") {
			const message = this.#message;
			this.show(afterwards.options);
			this.#message = message;
		}
	}

	/** Save the drafts as a new case. */
	async save(title: string): Promise<SaveResult | undefined> {
		// A second click must not start over while screenshots are still awaited.
		if (this.#saveCalled) return undefined;
		this.#saveCalled = true;
		try {
			return await this.#save(title);
		} finally {
			this.#saveCalled = false;
		}
	}

	async #save(title: string): Promise<SaveResult | undefined> {
		if (
			this.#activity.saving ||
			this.#drafts.length === 0 ||
			this.#target !== undefined
		)
			return undefined;
		this.#title = title;
		if (this.#editing !== null) this.#commitComment();
		await this.#shots;
		try {
			for (const draft of this.#drafts) {
				if (draft.shot !== undefined) continue;
				if (draft.url !== location.href) {
					// Its page is gone: a screenshot of this one would show something else.
					this.#message = `Mark ${draft.number} has no screenshot and was drawn on another page. Go back there, or undo it.`;
					this.#renderToolbar();
					return undefined;
				}
				await this.#takeBack(draft);
			}
		} catch (error) {
			this.#message = `Not saved: ${errorText(error)}`;
			this.#renderToolbar();
			return undefined;
		}
		const started = this.#activity.begin("saving");
		if (!started.ok) {
			this.#message = started.error;
			this.#renderToolbar();
			return undefined;
		}
		const drafts = [...this.#drafts];
		const first = (v: View) => Math.min(...v.marks.map((d) => d.number));
		const views = this.#views
			.filter((v) => v.marks.some((d) => drafts.includes(d)))
			.sort((a, b) => first(a) - first(b));
		this.#saveForm = false;
		this.#savingCase = true;
		this.#message = "Saving…";
		this.setTool(null);
		let saved = false;
		try {
			const annotations = drafts.map((d) => this.#annotationOf(d));
			annotations.sort((a, b) => a.number - b.number);
			const result = await ask<SaveResult>({
				type: "case:save",
				request: {
					caseId: newId("c"),
					imagesFrom: this.#pendingId(),
					isNew: true,
					title,
					page: (views[0] as View).page,
					shots: views.map((v) => v.shot),
					annotations,
				},
			});
			this.#drafts = this.#drafts.filter((d) => !drafts.includes(d));
			this.#savedMarks.push(...drafts);
			this.#views = this.#views.filter((v) => !views.includes(v));
			// Their images went with the save: a mark drawn on one meanwhile
			// takes its own, and so does the next mark.
			for (const d of this.#drafts)
				if (d.shot !== undefined && views.includes(d.shot.view)) delete d.shot;
			this.#shown = undefined;
			this.#target = {
				caseId: result.caseId,
				title: result.title,
				nextAnnotation: Math.max(...drafts.map((d) => d.number)) + 1,
			};
			this.#message = `Saved “${result.title}”`;
			saved = true;
			return result;
		} catch (error) {
			// The marks and their screenshots stay: the save can be tried again.
			this.#message = `Not saved: ${errorText(error)}`;
			return undefined;
		} finally {
			this.#savingCase = false;
			this.#afterwards(this.#activity.end("saving"), saved);
			// Further marks go into the case one by one, those drawn meanwhile too.
			this.#addDone();
			this.#renderToolbar();
			this.#render();
		}
	}

	// --- adding to a case, mark by mark ---------------------------------------

	/** Run `op` after everything that changes the case before it. */
	#queue(op: () => Promise<void>): void {
		this.#ops = this.#ops.then(op).catch((error: unknown) => {
			this.#message = errorText(error);
			this.#renderToolbar();
		});
	}

	/** Adding to a case: queue every mark that is done and not on its way yet. */
	#addDone(): void {
		const target = this.#target;
		if (target === undefined) return;
		for (const d of this.#drafts) {
			if (d === this.#editing || this.#queued.has(d) || this.#failed.has(d))
				continue;
			if (d.queuedFor !== undefined && d.queuedFor.caseId !== target.caseId)
				this.#failed.set(d, this.#notFor(d, target));
			else this.#enqueueAdd(d, false);
		}
	}

	/**
	 * Queue the draft for the case the toolbar adds to now; it goes into no
	 * other. `takeBack`: a mark without a screenshot scrolls back to take one.
	 */
	#enqueueAdd(draft: Draft, takeBack: boolean): void {
		const target = this.#target;
		if (target === undefined) return;
		draft.queuedFor = { caseId: target.caseId, title: target.title };
		this.#queued.add(draft);
		this.#queue(() => this.#addOne(draft, takeBack));
		this.#renderToolbar();
	}

	/** Why a draft queued for one case is not added to `target`, another one. */
	#notFor(draft: Draft, target: AnnotateTarget): string {
		const was = draft.queuedFor;
		if (was === undefined || was.caseId === target.caseId)
			return this.#failed.get(draft) ?? "";
		return `it was for “${was.title}”, and the toolbar adds to “${target.title}” now. “Add mark ${draft.number}” puts it there; Undo removes it.`;
	}

	/** "Add mark N": the marks that could not be added try again, for this case. */
	#retry(): void {
		// Taking a screenshot may scroll: not while a tool is in use.
		this.setTool(null);
		const failed = [...this.#failed.keys()];
		this.#failed.clear();
		this.#message = "";
		this.#alert = "";
		this.#leftOut = undefined;
		for (const d of failed)
			if (this.#drafts.includes(d)) this.#enqueueAdd(d, true);
	}

	/** A failure shows, also where the toolbar was closed meanwhile. */
	#fail(draft: Draft, why: string): void {
		this.#failed.set(draft, why);
		this.#message = "";
		if (!this.overlay.annotating) {
			this.overlay.setAnnotating(true);
			this.#mutated = true;
			this.#watch();
		}
	}

	async #addOne(draft: Draft, takeBack: boolean): Promise<void> {
		try {
			if (await this.#readyToAdd(draft, takeBack)) await this.#store(draft);
		} finally {
			this.#queued.delete(draft);
			this.#renderToolbar();
			this.#render();
		}
	}

	/** It was queued for another case than the toolbar's now: it waits, and says so. */
	#elsewhere(draft: Draft): boolean {
		const target = this.#target;
		if (target === undefined || draft.queuedFor?.caseId === target.caseId)
			return false;
		this.#fail(draft, this.#notFor(draft, target));
		return true;
	}

	/** Give the draft its screenshot if needed, then hold the page for the add. */
	async #readyToAdd(draft: Draft, takeBack: boolean): Promise<boolean> {
		try {
			await this.#shots;
			const gone = () =>
				!this.#drafts.includes(draft) ||
				draft === this.#editing ||
				this.#target === undefined;
			if (gone() || this.#elsewhere(draft)) return false;
			if (draft.shot === undefined) {
				if (draft.url !== location.href) {
					this.#fail(
						draft,
						"it has no screenshot and was drawn on another page. Go back there, or undo it.",
					);
					return false;
				}
				if (!takeBack) {
					this.#fail(
						draft,
						"the page changed before its screenshot was taken. Adding it again scrolls back to take one.",
					);
					return false;
				}
				await this.#takeBack(draft);
				// Undone, or its case left, meanwhile.
				if (gone() || this.#elsewhere(draft)) return false;
			}
			await this.#hold("saving");
			return true;
		} catch (error) {
			this.#fail(draft, errorText(error));
			return false;
		}
	}

	/** Add one draft to the case; the page is held for it ("saving"). */
	async #store(draft: Draft): Promise<void> {
		let added = false;
		try {
			// Nothing else changes the case from here meanwhile: a show waits for
			// the save to end, Undo waits in the queue.
			let target = this.#target;
			if (target === undefined || this.#elsewhere(draft)) return;
			this.#message = `Adding mark ${draft.number} to “${target.title}”…`;
			this.#alert = "";
			this.#renderToolbar();
			const { view } = draft.shot as NonNullable<Draft["shot"]>;
			const isFree = async () => {
				const check = await ask<NumberCheck>({
					type: "case:number",
					caseId: (target as AnnotateTarget).caseId,
					number: draft.number,
				});
				return check;
			};
			for (let attempt = 0; ; attempt++) {
				const check = await isFree();
				if (!check.free) {
					// An AI app took the number: the marks not added yet move on.
					target = { ...target, nextAnnotation: check.next };
					this.#target = target;
					this.#renumber();
				}
				// Only marks before it: Undo of a later one leaves no pin behind.
				const alsoDrawn = view.marks.flatMap((d) =>
					d !== draft &&
					d.shot !== undefined &&
					d.number < draft.number &&
					this.#added.includes(d)
						? [{ shot: view.shot.id, number: d.number, shape: d.shot.shape }]
						: [],
				);
				try {
					await ask<SaveResult>({
						type: "case:save",
						request: {
							caseId: target.caseId,
							imagesFrom: this.#pendingId(),
							isNew: false,
							title: target.title,
							page: view.page,
							shots: [view.shot],
							annotations: [this.#annotationOf(draft)],
							keepPending: true,
							alsoDrawn,
						},
					});
					break;
				} catch (error) {
					// The number was taken between the check and the save: once more.
					if (attempt > 0 || (await isFree()).free) throw error;
				}
			}
			this.#drafts = this.#drafts.filter((d) => d !== draft);
			this.#savedMarks.push(draft);
			// Undo reaches only what was added while the toolbar is up.
			if (this.overlay.annotating) this.#added.push(draft);
			this.#target = {
				...target,
				nextAnnotation: Math.max(target.nextAnnotation, draft.number + 1),
			};
			this.#message = `Mark ${draft.number} added to “${target.title}”`;
			this.#retire();
			added = true;
		} catch (error) {
			// It stays on the page with its screenshot: adding it again can work.
			this.#fail(draft, errorText(error));
		} finally {
			this.#afterwards(this.#activity.end("saving"), added);
		}
	}

	/** Undo for a mark that was added, or on its way: out of the case again. */
	async #undoAdded(draft: Draft): Promise<void> {
		try {
			// Its add failed, or it never ran: it is a draft still.
			if (this.#drafts.includes(draft)) {
				this.#failed.delete(draft);
				this.#forget(draft);
				if (draft === this.#editing) this.#closeComment();
				return;
			}
			const target = this.#target;
			if (target === undefined || !this.#added.includes(draft)) return;
			this.#message = `Taking mark ${draft.number} out of “${target.title}”…`;
			this.#renderToolbar();
			const result = await ask<UndoResult>({
				type: "case:undo-add",
				caseId: target.caseId,
				annotationId: `a${draft.number}`,
			});
			this.#added = this.#added.filter((d) => d !== draft);
			this.#savedMarks = this.#savedMarks.filter((d) => d !== draft);
			const view = draft.shot?.view;
			if (view !== undefined)
				view.marks = view.marks.filter((d) => d !== draft);
			this.#retire();
			// Its number is free again (or another mark took the next one).
			this.#target = { ...target, nextAnnotation: result.next };
			this.#message = result.removed
				? `Mark ${draft.number} taken out of “${target.title}”`
				: `Mark ${draft.number} was deleted from “${target.title}” already`;
		} catch (error) {
			// It stays in the case, and Undo no longer offers it.
			this.#added = this.#added.filter((d) => d !== draft);
			this.#message = "";
			this.#alert = `Mark ${draft.number} is still in the case: ${errorText(error)}`;
		} finally {
			this.#undoing.delete(draft);
			this.#renderToolbar();
			this.#render();
		}
	}

	/**
	 * Done: the marks not in the case yet try again (nobody is using the page,
	 * so one without a screenshot can scroll back to take it), then the toolbar
	 * goes. While a mark is still not in the case it stays up and says so; Done
	 * again then discards those marks.
	 */
	#finish(): Promise<void> {
		this.#finishRun ??= this.#finishNow().finally(() => {
			this.#finishRun = undefined;
		});
		return this.#finishRun;
	}

	async #finishNow(): Promise<void> {
		if (this.#editing !== null) this.#commitComment();
		this.setTool(null);
		const left = this.#leftOut;
		this.#leftOut = undefined;
		if (
			left !== undefined &&
			this.#drafts.length > 0 &&
			this.#drafts.every((d) => left.has(d))
		) {
			for (const d of [...this.#drafts]) {
				this.#failed.delete(d);
				this.#forget(d);
			}
			this.#alert = "";
			this.hide();
			this.#renderToolbar();
			return;
		}
		const target = this.#target;
		for (const d of [...this.#failed.keys()])
			if (
				target !== undefined &&
				this.#drafts.includes(d) &&
				d.queuedFor?.caseId === target.caseId
			) {
				this.#failed.delete(d);
				this.#enqueueAdd(d, true);
			}
		this.#addDone();
		this.#finishing = true;
		this.#renderToolbar();
		try {
			await this.#settled();
		} finally {
			this.#finishing = false;
		}
		const remaining = [...this.#drafts];
		if (remaining.length === 0 || this.#target === undefined) {
			this.hide();
			this.#renderToolbar();
			return;
		}
		this.#leftOut = new Set(remaining);
		const first = remaining[0] as Draft;
		this.#message = "";
		this.#alert =
			remaining.length === 1
				? `Mark ${first.number} is not in the case yet: Add mark ${first.number}, or Done again to discard it.`
				: `${remaining.length} marks are not in the case yet: Add ${remaining.length} marks, or Done again to discard them.`;
		this.#renderToolbar();
	}
}

/** The mark Undo takes: the one with the highest number. */
export function lastMark<T extends { number: number }>(
	marks: readonly T[],
): T | undefined {
	let last: T | undefined;
	for (const m of marks)
		if (last === undefined || m.number > last.number) last = m;
	return last;
}
