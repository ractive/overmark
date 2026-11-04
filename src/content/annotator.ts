/**
 * Annotating a page: the tools (element, box, arrow, pen, note), a comment for
 * each mark, undo, and saving the marks as a case with screenshots.
 *
 * Marks are kept in document coordinates while drawing, so the page can
 * scroll; saving translates them into the coordinates of their screenshot.
 */

import {
	type ElementDetails,
	LANGUAGE,
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
import { elementAt, elementForRect } from "./anchor.ts";
import type { Overlay } from "./overlay.ts";
import { planShots } from "./plan.ts";

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

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
	#saving = false;
	/** "Stop annotating" arrived during a save: hide once it is done. */
	#hideAfterSave = false;
	#saveForm = false;
	#message = "";
	#frame = 0;

	constructor(overlay: Overlay) {
		this.overlay = overlay;
		const capture = overlay.capture;
		capture.addEventListener("pointermove", (e) => this.#move(e));
		capture.addEventListener("pointerdown", (e) => this.#down(e));
		capture.addEventListener("pointerup", (e) => this.#up(e));
		capture.addEventListener("pointercancel", () => {
			this.#drag = null;
			this.#preview = null;
			this.#render();
		});
		const win = overlay.doc.defaultView;
		win?.addEventListener("scroll", () => this.#schedule(), { passive: true });
		win?.addEventListener("resize", () => this.#schedule());
		win?.addEventListener(
			"keydown",
			(e) => {
				if (!overlay.annotating || e.key !== "Escape") return;
				if (this.#editing !== null) this.#commitComment();
				else if (this.#saveForm) this.#setSaveForm(false);
				else this.setTool(null);
			},
			true,
		);
		this.#renderToolbar();
	}

	state(): OverlayState {
		const state: OverlayState = {
			visible: this.overlay.annotating,
			url: location.href,
			title: document.title,
			drafts: this.#drafts.length,
			saving: this.#saving,
		};
		if (this.#target) state.target = this.#target;
		return state;
	}

	show(options: { target?: AnnotateTarget; blurForms?: boolean }): void {
		if (!this.#saving) {
			this.#target = options.target;
			this.#blurForms = options.blurForms ?? false;
			this.#message = "";
			this.#renumber();
		}
		this.#hideAfterSave = false;
		this.overlay.setAnnotating(true);
		this.#renderToolbar();
		this.#render();
	}

	hide(): void {
		if (this.#saving) {
			// The remaining screenshots still need the marks.
			this.#hideAfterSave = true;
			return;
		}
		if (this.#editing !== null) this.#commitComment();
		this.setTool(null);
		this.overlay.setAnnotating(false);
	}

	setTool(tool: Tool | null): void {
		if (!this.#saving) this.#message = "";
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
				const points = [...drag.points, p];
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
		};
		this.#message = "";
		this.#drafts.push(draft);
		this.#openComment(draft);
		this.#renderToolbar();
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
		field.value = draft.comment;
		field.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) this.#commitComment();
			if (e.key === "Escape") this.#commitComment();
		});
		field.addEventListener("keyup", (e) => e.stopPropagation());
		field.addEventListener("keypress", (e) => e.stopPropagation());
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
			this.#drafts = this.#drafts.filter((d) => d !== draft);
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
		const s = this.#scroll();
		const b = shapeBounds(draft.shape);
		const vw = win?.innerWidth ?? 1024;
		const vh = win?.innerHeight ?? 768;
		const width = 296;
		const height = 150;
		let x = b.x - s.x;
		let y = b.y - s.y + b.height + 12;
		if (y + height > vh) y = b.y - s.y - height - 12;
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
		const last = this.#drafts.pop();
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

	#render(): void {
		if (!this.overlay.annotating) return;
		const s = this.#scroll();
		const toWindow = (shape: Shape) => translateShape(shape, -s.x, -s.y);
		const hover =
			this.#tool === "element" && this.#hover !== null
				? this.#hover.getBoundingClientRect()
				: null;
		this.overlay.render(
			this.#drafts.map((d) => ({ number: d.number, shape: toWindow(d.shape) })),
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
		if (this.#saving) {
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
				status.textContent = `Add ${count} mark${count === 1 ? "" : "s"} to “${this.#target.title}”`;
				parts.push(status);
			} else {
				title = doc.createElement("input");
				title.type = "text";
				title.placeholder = "Case title";
				title.setAttribute("aria-label", "Case title");
				title.value = doc.title.slice(0, 120);
				title.addEventListener("keydown", (e) => {
					e.stopPropagation();
					if (e.key === "Enter") void this.save(title?.value ?? "");
					if (e.key === "Escape") this.#setSaveForm(false);
				});
				parts.push(title);
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

	// --- saving --------------------------------------------------------------

	#blur(): () => void {
		const fields = this.#blurForms
			? this.overlay.doc.querySelectorAll<HTMLElement>(
					"input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select, [contenteditable='true'], [contenteditable='']",
				)
			: this.overlay.doc.querySelectorAll<HTMLElement>("input[type=password]");
		const before = [...fields].map((f) => ({
			f,
			value: f.style.getPropertyValue("filter"),
			priority: f.style.getPropertyPriority("filter"),
		}));
		for (const { f } of before)
			f.style.setProperty("filter", "blur(6px)", "important");
		return () => {
			for (const { f, value, priority } of before) {
				if (value) f.style.setProperty("filter", value, priority);
				else f.style.removeProperty("filter");
			}
		};
	}

	/** Save the marks as a new case, or add them to the target case. */
	async save(title: string): Promise<SaveResult | undefined> {
		if (this.#saving || this.#drafts.length === 0) return undefined;
		if (this.#editing !== null) this.#commitComment();
		const win = this.overlay.doc.defaultView as Window;
		const doc = this.overlay.doc;
		const target = this.#target;
		const caseId = target?.caseId ?? newId("c");
		const drafts = [...this.#drafts];
		const start = this.#scroll();
		this.#saving = true;
		this.#saveForm = false;
		this.setTool(null);
		const captured: string[] = [];
		try {
			// Element details are read first, while the page is as the user saw it.
			const context = createContext(doc);
			const details: (ElementDetails | null)[] = drafts.map((d) =>
				d.element?.isConnected ? describeElement(d.element, context) : null,
			);
			const viewport = {
				width: win.innerWidth,
				height: win.innerHeight,
				dpr: win.devicePixelRatio || 1,
			};
			const plan = planShots(
				drafts.map((d) => shapeBounds(d.shape)),
				viewport,
				context.page,
				start,
			);
			const shots: Shot[] = [];
			const annotations: AnnotationDraft[] = [];
			for (const [i, window] of plan.entries()) {
				this.#message = `Taking screenshot ${i + 1} of ${plan.length}…`;
				this.#renderToolbar();
				win.scrollTo({
					left: window.scrollX,
					top: window.scrollY,
					behavior: "instant",
				});
				await frame();
				await frame();
				await sleep(150);
				const actual = this.#scroll();
				// Provisional: the saved case gives the shot its final id (save.ts).
				const shotId = newId("p");
				this.overlay.setCapturing(true);
				this.#render();
				const restore = this.#blur();
				await frame();
				try {
					captured.push(shotId);
					await ask<CaptureResult>({ type: "capture", caseId, shotId });
				} finally {
					restore();
					this.overlay.setCapturing(false);
				}
				shots.push({
					id: shotId,
					image: pendingImage(shotId),
					scrollX: actual.x,
					scrollY: actual.y,
					viewport,
					capturedAt: new Date().toISOString(),
				});
				for (const index of window.marks) {
					const draft = drafts[index] as Draft;
					const shape = translateShape(draft.shape, -actual.x, -actual.y);
					annotations.push({
						id: `a${draft.number}`,
						number: draft.number,
						shot: shotId,
						comment: draft.comment,
						author: "user",
						shape,
						element: details[index] ?? null,
						cropRect: cropRectFor(shapeBounds(shape), viewport),
					});
				}
			}
			annotations.sort((a, b) => a.number - b.number);
			const page: PageInfo = {
				url: location.href,
				title: doc.title,
				lang: LANGUAGE.test(doc.documentElement.lang)
					? doc.documentElement.lang
					: "",
				viewport,
				userAgent: navigator.userAgent,
			};
			this.#message = "Saving…";
			this.#renderToolbar();
			const result = await ask<SaveResult>({
				type: "case:save",
				request: {
					caseId,
					isNew: target === undefined,
					title: target?.title ?? title,
					page,
					shots,
					annotations,
				},
			});
			this.#drafts = this.#drafts.filter((d) => !drafts.includes(d));
			this.#target = {
				caseId: result.caseId,
				title: result.title,
				nextAnnotation: Math.max(...drafts.map((d) => d.number)) + 1,
			};
			this.#message = `Saved “${result.title}”`;
			return result;
		} catch (error) {
			if (captured.length > 0)
				await ask({ type: "images:discard", caseId, shotIds: captured }).catch(
					() => undefined,
				);
			this.#message = `Not saved: ${error instanceof Error ? error.message : String(error)}`;
			return undefined;
		} finally {
			win.scrollTo({ left: start.x, top: start.y, behavior: "instant" });
			this.#saving = false;
			if (this.#hideAfterSave) {
				this.#hideAfterSave = false;
				this.hide();
			}
			this.#renderToolbar();
			this.#render();
		}
	}
}
