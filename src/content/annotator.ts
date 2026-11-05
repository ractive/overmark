/**
 * Annotating a page: the tools (element, box, arrow, pen, note), a comment for
 * each mark, undo, and saving the marks as a case.
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
	OverlayState,
	SaveResult,
	WorkerRequest,
	WorkerResponse,
} from "../lib/messages.ts";
import { type AnnotationDraft, cropRectFor } from "../lib/save.ts";
import { parentOf, shadowTrees } from "../lib/shadow.ts";
import {
	AI_TIMEOUT_MS,
	type PageActivity,
	type ShowOptions,
} from "./activity.ts";
import { elementAt, elementForRect } from "./anchor.ts";
import type { PageBlur } from "./blur.ts";
import type { Overlay } from "./overlay.ts";

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
	shot?: { view: View; shape: Shape };
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

	readonly #pageBlur: PageBlur;
	readonly #activity: PageActivity;

	constructor(overlay: Overlay, blur: PageBlur, activity: PageActivity) {
		this.overlay = overlay;
		this.#pageBlur = blur;
		this.#activity = activity;
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
			this.#target = options.target;
			this.#blurForms = options.blurForms ?? false;
			this.#message = "";
			this.#renumber();
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
		const label = this.overlay.popover.querySelector(".label");
		if (this.#editing !== null && label !== null)
			label.textContent = `Comment for mark ${this.#editing.number}`;
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
		if (view.marks.length > 0) return;
		this.#views = this.#views.filter((v) => v !== view);
		if (this.#shown === view) this.#shown = undefined;
		this.#discard([view.shot.id]);
	}

	#openComment(draft: Draft): void {
		this.#editing = draft;
		const doc = this.overlay.doc;
		const popover = this.overlay.popover;
		const label = doc.createElement("div");
		label.className = "label";
		label.textContent = `Comment for mark ${draft.number}`;
		const field = doc.createElement("textarea");
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
		const height = 150;
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
	}

	#closeComment(): void {
		this.#editing = null;
		this.overlay.popover.hidden = true;
		this.overlay.popover.replaceChildren();
		this.#renderToolbar();
		this.#render();
	}

	undo(): void {
		this.#message = "";
		const last = this.#drafts.at(-1);
		if (last !== undefined) this.#forget(last);
		if (last !== undefined && last === this.#editing) this.#closeComment();
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
		this.overlay.render(
			this.#drafts
				.filter((d) => this.#onPage(d))
				.map((d) => ({ number: d.number, shape: this.#onWindow(d) })),
			this.#preview === null ? null : toWindow(this.#preview),
			hover === null
				? null
				: { x: hover.x, y: hover.y, width: hover.width, height: hover.height },
		);
		if (this.#editing !== null) this.#placePopover(this.#editing);
	}

	#button(
		label: string,
		action: string,
		onClick: () => void,
	): HTMLButtonElement {
		const b = this.overlay.doc.createElement("button");
		b.type = "button";
		b.textContent = label;
		b.dataset["action"] = action;
		b.addEventListener("click", onClick);
		return b;
	}

	#setSaveForm(on: boolean): void {
		this.#saveForm = on;
		this.#renderToolbar();
	}

	#renderToolbar(): void {
		const doc = this.overlay.doc;
		const bar = this.overlay.toolbar;
		const brand = doc.createElement("span");
		brand.className = "brand";
		brand.textContent = "Overmark";
		const status = doc.createElement("span");
		status.className = "status";
		status.dataset["role"] = "status";
		const sep = () => {
			const s = doc.createElement("span");
			s.className = "sep";
			return s;
		};
		const count = this.#drafts.length;
		if (this.#activity.saving) {
			status.textContent = this.#message || "Saving…";
			bar.replaceChildren(brand, status);
			return;
		}
		if (this.#saveForm) {
			const save = this.#button(
				this.#target ? "Add to case" : "Save case",
				"save-confirm",
				() => void this.save(title?.value ?? ""),
			);
			save.className = "primary";
			let title: HTMLInputElement | undefined;
			const parts: HTMLElement[] = [brand];
			if (this.#target) {
				status.textContent =
					this.#message ||
					`Add ${count} mark${count === 1 ? "" : "s"} to “${this.#target.title}”`;
				parts.push(status);
			} else {
				title = doc.createElement("input");
				title.type = "text";
				title.placeholder = "Case title";
				title.setAttribute("aria-label", "Case title");
				title.maxLength = MAX_TITLE;
				title.value = this.#title;
				title.addEventListener("input", () => {
					this.#title = title?.value ?? "";
				});
				title.addEventListener("keydown", (e) => {
					if (e.key === "Enter") void this.save(title?.value ?? "");
				});
				parts.push(title);
				if (this.#message) {
					status.textContent = this.#message;
					parts.push(status);
				}
			}
			parts.push(
				save,
				this.#button("Back", "save-cancel", () => this.#setSaveForm(false)),
			);
			bar.replaceChildren(...parts);
			title?.focus();
			title?.select();
			return;
		}
		const tools = TOOLS.map(({ tool, label, title }) => {
			const b = this.#button(label, `tool-${tool}`, () =>
				this.setTool(this.#tool === tool ? null : tool),
			);
			b.title = title;
			b.setAttribute("aria-pressed", String(this.#tool === tool));
			return b;
		});
		const undo = this.#button("Undo", "undo", () => this.undo());
		undo.disabled = count === 0;
		const save = this.#button("Save…", "save", () => {
			if (this.#editing !== null) this.#commitComment();
			this.setTool(null);
			this.#title = doc.title.slice(0, 120);
			this.#setSaveForm(true);
		});
		save.disabled = count === 0;
		status.textContent =
			this.#message ||
			(count === 0
				? this.#target
					? `Adding to “${this.#target.title}”`
					: "Choose a tool"
				: `${count} mark${count === 1 ? "" : "s"}`);
		const top = bar.classList.contains("top");
		const move = this.#button(top ? "↓" : "↑", "move-toolbar", () => {
			bar.classList.toggle("top");
			this.#renderToolbar();
		});
		move.title = top ? "Move the toolbar down" : "Move the toolbar up";
		move.setAttribute("aria-label", move.title);
		bar.replaceChildren(
			brand,
			...tools,
			sep(),
			undo,
			save,
			this.#button("Close", "close", () => this.hide()),
			move,
			status,
		);
	}

	// --- screenshots ---------------------------------------------------------

	#pendingId(): string {
		this.#pendingCase ??= newId("c");
		return this.#pendingCase;
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
	async #hold(): Promise<void> {
		for (let waited = 0; ; waited += 200) {
			const started = this.#activity.begin("shot");
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
		await this.#hold();
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
			let scroll: Point;
			let viewport: PageInfo["viewport"];
			try {
				// Two frames: the first paints what was just changed.
				await frame();
				await frame();
				shape = this.#onWindow(draft);
				scroll = this.#scroll();
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
			draft.shot = { view, shape };
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

	/** Save the marks as a new case, or add them to the target case. */
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
		if (this.#activity.saving || this.#drafts.length === 0) return undefined;
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
		const target = this.#target;
		const imagesFrom = this.#pendingId();
		this.#saveForm = false;
		this.#message = "Saving…";
		this.setTool(null);
		let saved = false;
		try {
			const annotations: AnnotationDraft[] = drafts.map((d) => {
				const { view, shape } = d.shot as NonNullable<Draft["shot"]>;
				return {
					id: `a${d.number}`,
					number: d.number,
					shot: view.shot.id,
					comment: d.comment,
					author: "user",
					shape,
					element: d.details,
					cropRect: cropRectFor(shapeBounds(shape), view.shot.viewport),
				};
			});
			annotations.sort((a, b) => a.number - b.number);
			const result = await ask<SaveResult>({
				type: "case:save",
				request: {
					caseId: target?.caseId ?? imagesFrom,
					imagesFrom,
					isNew: target === undefined,
					title: target?.title ?? title,
					page: (views[0] as View).page,
					shots: views.map((v) => v.shot),
					annotations,
				},
			});
			this.#drafts = this.#drafts.filter((d) => !drafts.includes(d));
			this.#views = this.#views.filter((v) => !views.includes(v));
			this.#pendingCase = undefined;
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
			const afterwards = this.#activity.end("saving");
			if (afterwards?.kind === "hide") {
				// A failed save stays up with its error, or its marks would be lost.
				if (saved) this.hide();
			} else if (afterwards?.kind === "show") {
				const message = this.#message;
				this.show(afterwards.options);
				this.#message = message;
			}
			this.#renderToolbar();
			this.#render();
		}
	}
}
