/**
 * `overlay:end` on the page's toolbar (DEC-023): the side panel closes the
 * case, and the toolbar finishes as its Done does, then adds to no case any
 * more; a mark that could not be added keeps it up, unless `discard`.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "bun:test";
import { Window } from "happy-dom";
import type { Annotator as AnnotatorClass } from "../src/content/annotator.ts";
import type { WorkerRequest } from "../src/lib/messages.ts";

const window = new Window({
	url: "https://shop.example/cart",
	width: 1024,
	height: 768,
});
const globals = globalThis as unknown as Record<string, unknown>;
const names = [
	"window",
	"document",
	"location",
	"CSS",
	"CSSStyleSheet",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"MutationObserver",
	"HTMLElement",
	"Element",
	"chrome",
] as const;
const before = Object.fromEntries(names.map((n) => [n, globals[n]]));

/** What the worker answers, by request; the requests it got. */
let answer: (r: WorkerRequest) => object;
const asked: WorkerRequest[] = [];

let Annotator: typeof AnnotatorClass;
let PageActivity: typeof import("../src/content/activity.ts").PageActivity;
let PageBlur: typeof import("../src/content/blur.ts").PageBlur;
let Overlay: typeof import("../src/content/overlay.ts").Overlay;

beforeAll(async () => {
	// happy-dom has no hit test: a note on nothing in particular.
	Object.assign(window.document, { elementsFromPoint: () => [] });
	for (const n of names.slice(0, -1))
		globals[n] = n === "window" ? window : (window as never)[n];
	globals["CSS"] ??= { escape: (s: string) => s };
	globals["chrome"] = {
		runtime: {
			sendMessage: async (r: WorkerRequest) => {
				asked.push(r);
				return answer(r);
			},
		},
	};
	({ Annotator } = await import("../src/content/annotator.ts"));
	({ PageActivity } = await import("../src/content/activity.ts"));
	({ PageBlur } = await import("../src/content/blur.ts"));
	({ Overlay } = await import("../src/content/overlay.ts"));
});

afterAll(() => {
	for (const n of names) globals[n] = before[n];
});

/** A worker that takes every screenshot and every mark. */
const works = (r: WorkerRequest): object => {
	switch (r.type) {
		case "capture":
			return { ok: true, width: 1024, height: 768 };
		case "case:number":
			return { ok: true, free: true, next: r.number + 1 };
		case "case:save":
			return {
				ok: true,
				caseId: r.request.caseId,
				title: r.request.title,
				annotations: 1,
			};
		default:
			return { ok: true };
	}
};

/** A worker that takes no screenshot: no mark can be added. */
const noShots = (r: WorkerRequest): object =>
	r.type === "capture"
		? { ok: false, error: "The tab is not in front." }
		: works(r);

beforeEach(() => {
	window.document.body.innerHTML = `<main><p id="text">Some text</p></main>`;
	asked.length = 0;
	answer = works;
});

/** The overlays made: their timers stop after each test. */
const made: InstanceType<typeof Overlay>[] = [];

afterEach(() => {
	for (const overlay of made.splice(0)) overlay.setAnnotating(false);
});

const target = { caseId: "c_open", title: "Open case", nextAnnotation: 3 };

function annotator(): {
	a: AnnotatorClass;
	overlay: InstanceType<typeof Overlay>;
} {
	const doc = window.document as unknown as Document;
	const overlay = new Overlay(doc);
	made.push(overlay);
	const a = new Annotator(overlay, new PageBlur(doc), new PageActivity());
	return { a, overlay };
}

/** Draw a note and close its comment: it goes into the case the toolbar adds to. */
function note(overlay: InstanceType<typeof Overlay>, a: AnnotatorClass): void {
	a.setTool("note");
	const at = { clientX: 40, clientY: 40, button: 0, pointerId: 1 };
	overlay.capture.dispatchEvent(
		new window.PointerEvent("pointerdown", at) as unknown as Event,
	);
	overlay.capture.dispatchEvent(
		new window.PointerEvent("pointerup", at) as unknown as Event,
	);
	const done = overlay.popover.querySelector<HTMLButtonElement>(
		'[data-action="comment-done"]',
	);
	if (done === null) throw new Error("no comment field");
	done.click();
}

/** Until the queue has added or failed what was drawn. */
const settle = async (a: AnnotatorClass, done: () => boolean) => {
	for (let i = 0; i < 100 && !done(); i++) await Bun.sleep(50);
	expect(done()).toBe(true);
	return a;
};

test("the target is cleared and the toolbar hidden: the next show is a new case", async () => {
	const { a, overlay } = annotator();
	a.show({ target });
	expect(a.state().target?.caseId).toBe("c_open");
	note(overlay, a);
	await settle(a, () => asked.some((r) => r.type === "case:save"));
	await settle(a, () => a.state().drafts === 0);
	await a.end("c_open");
	expect(a.state().visible).toBe(false);
	expect(a.state().target).toBeUndefined();
	a.show({});
	expect(a.state().target).toBeUndefined();
	const status = overlay.toolbar.querySelector('[data-role="status"]');
	expect(status?.textContent).toBe("New case: choose a tool");
	// No New case button any more (DEC-023).
	expect(overlay.toolbar.querySelector('[data-action="new-case"]')).toBeNull();
});

test("a toolbar hidden by its own Done still drops its case", async () => {
	const { a } = annotator();
	a.show({ target });
	a.hide();
	expect(a.state().target?.caseId).toBe("c_open");
	await a.end("c_open");
	expect(a.state().target).toBeUndefined();
});

test("another case's toolbar is left as it is", async () => {
	const { a } = annotator();
	a.show({ target });
	await a.end("c_other");
	expect(a.state().visible).toBe(true);
	expect(a.state().target?.caseId).toBe("c_open");
});

test("a mark that could not be added keeps the toolbar up and the case; discard drops it", async () => {
	answer = noShots;
	const { a, overlay } = annotator();
	a.show({ target });
	note(overlay, a);
	const alert = () =>
		overlay.toolbar.querySelector('[data-role="alert"]')?.textContent ?? "";
	await settle(a, () => alert().startsWith("Mark 3 was not added"));
	await a.end("c_open");
	expect(a.state().visible).toBe(true);
	expect(a.state().target?.caseId).toBe("c_open");
	expect(a.state().drafts).toBe(1);
	expect(asked.some((r) => r.type === "case:save")).toBe(false);
	// The second "← All cases": without it.
	await a.end("c_open", true);
	expect(a.state().visible).toBe(false);
	expect(a.state().target).toBeUndefined();
	expect(a.state().drafts).toBe(0);
	expect(asked.some((r) => r.type === "case:save")).toBe(false);
});

test("the page tells the side panel when its drafts or its case change", async () => {
	const { a, overlay } = annotator();
	let told = 0;
	overlay.onChange = () => told++;
	a.show({});
	const shown = told;
	answer = noShots;
	note(overlay, a);
	expect(told).toBeGreaterThan(shown);
	expect(a.state().drafts).toBe(1);
	const status = overlay.toolbar.querySelector('[data-role="status"]');
	expect(status?.textContent).toBe("New case: 1 mark");
	// The screenshot it asked for is over before the page goes.
	await settle(
		a,
		() => status?.textContent?.startsWith("No screenshot") ?? false,
	);
});
