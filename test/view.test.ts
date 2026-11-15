import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { Window } from "happy-dom";
import type { Annotation, Case } from "../src/lib/case.ts";
import { summarize } from "../src/lib/element.ts";
import type { AnnotationMatch } from "../src/lib/messages.ts";
import { initialState, type PanelState } from "../src/sidepanel/state.ts";
import type { Actions } from "../src/sidepanel/view.ts";
import { sampleCase } from "./fixtures.ts";

const window = new Window({ url: "chrome-extension://x/sidepanel/index.html" });
const globals = globalThis as unknown as Record<string, unknown>;
const before = { document: globals["document"] };
let render: (state: PanelState, actions: Actions) => void;
let ASKING_DOWNLOADS: string;
let IMPORT_BUSY: string;
let EXPORT_ALL_BUSY: string;

/** Actions that do nothing, except for `some`. */
const actionsWith = (some: Partial<Actions>) =>
	new Proxy(some as Actions, {
		get: (target, key: keyof Actions) => target[key] ?? (() => undefined),
	});
const noActions = actionsWith({});
const el = <T extends HTMLElement>(id: string) =>
	window.document.getElementById(id) as unknown as T;

/** The side panel's page, and `view.ts` drawing into it. */
beforeAll(async () => {
	window.document.write(
		await Bun.file(
			new URL("../src/sidepanel/index.html", import.meta.url),
		).text(),
	);
	globals["document"] = window.document;
	({ render, ASKING_DOWNLOADS, IMPORT_BUSY, EXPORT_ALL_BUSY } = await import(
		"../src/sidepanel/view.ts"
	));
});

afterAll(() => {
	globals["document"] = before.document;
});

function caseState(c: Case, change?: (s: PanelState) => void): PanelState {
	const state = initialState();
	state.view = { kind: "case", id: c.id };
	state.current = c;
	change?.(state);
	return state;
}

describe("the tab", () => {
	const home = (
		tab: PanelState["tab"],
		change?: (s: PanelState) => void,
		actions: Actions = noActions,
	) => {
		const state = initialState();
		state.tab = tab;
		change?.(state);
		render(state, actions);
	};
	const text = (id: string) => el(id).textContent;
	const allow = () =>
		el("access-notice").querySelector(
			'[data-action="allow-all-sites"]',
		) as unknown as HTMLButtonElement;

	test("one heading, This page: its address, else its title, else nothing more", () => {
		expect(text("page-heading")).toBe("This page");
		home({ id: 1, url: "", title: "", size: undefined });
		expect(el("page").hidden).toBe(true);
		home({ id: 1, url: "", title: "Kasse", size: undefined });
		expect(el("page").hidden).toBe(false);
		expect(text("page")).toBe("Kasse");
	});

	test("without an address: a notice with a warning sign, the icon's click and Allow on all sites", () => {
		const asked: string[] = [];
		home({ id: 1, url: "", title: "", size: undefined }, undefined, {
			...noActions,
			allowAllSites: () => asked.push("all"),
		} as Actions);
		const notice = el("access-notice");
		expect(notice.hidden).toBe(false);
		expect(notice.querySelector("svg.notice-icon")).not.toBeNull();
		expect(notice.textContent).toContain("Click the Overmark icon");
		// It stands above New case for this page, and the hint below says nothing.
		expect(notice.nextElementSibling).toBe(el("annotate"));
		expect(el("hint").hidden).toBe(true);
		expect(allow().hidden).toBe(false);
		allow().click();
		expect(asked).toEqual(["all"]);
		// Annotating needs the page: off, and its title points at the notice.
		expect(el<HTMLButtonElement>("annotate").disabled).toBe(true);
		expect(el("annotate").title).toContain("see the notice");
	});

	test("without an address although Overmark may run on all sites: Chrome's own pages, no button", () => {
		home({ id: 1, url: "", title: "", size: undefined }, (s) => {
			s.allSites = true;
		});
		expect(el("access-notice").hidden).toBe(false);
		expect(text("access-notice")).toContain("cannot run on this tab");
		expect(allow().hidden).toBe(true);
		expect(el<HTMLButtonElement>("annotate").disabled).toBe(true);
	});

	test("a tab still loading has no address yet: no notice", () => {
		home({ id: 1, url: "", title: "", size: undefined, loading: true });
		expect(el("access-notice").hidden).toBe(true);
		expect(el<HTMLButtonElement>("annotate").disabled).toBe(false);
	});

	test("with an address: no notice, New case for this page on", () => {
		home({
			id: 1,
			url: "https://www.example.com/kk",
			title: "KK",
			size: undefined,
		});
		expect(text("page")).toBe("www.example.com/kk");
		expect(el("hint").hidden).toBe(true);
		expect(el("access-notice").hidden).toBe(true);
		expect(el<HTMLButtonElement>("annotate").disabled).toBe(false);
	});

	test("a hint of its own goes first", () => {
		const state = initialState();
		state.tab = { id: 1, url: "", title: "", size: undefined };
		state.hint = "Saving";
		render(state, noActions);
		expect(text("hint")).toBe("Saving");
	});
});

describe("the case list", () => {
	test("no Load of its own: opening any case draws its marks (DEC-022)", () => {
		const mine = sampleCase("c_here");
		const theirs = {
			...sampleCase("c_there"),
			page: { ...mine.page, url: "https://www.example.com/elsewhere" },
		};
		const state = initialState();
		state.tab = { id: 1, url: mine.page.url, title: "", size: undefined };
		state.cases = [mine, theirs];
		const opened: string[] = [];
		render(state, actionsWith({ openCase: (id) => opened.push(id) }));
		expect(window.document.querySelector("[data-load]")).toBeNull();
		for (const id of ["c_here", "c_there"])
			(
				window.document.querySelector(
					`[data-case="${id}"]`,
				) as unknown as HTMLElement
			).click();
		expect(opened).toEqual(["c_here", "c_there"]);
	});
});

describe("a mark's status and actions", () => {
	const mark = (
		n: number,
		resolution?: Annotation["resolution"],
	): Annotation => ({
		id: `a${n}`,
		number: n,
		shot: "s1",
		comment: `Comment ${n}`,
		author: "user",
		shape: { kind: "note", at: { x: 1, y: 1 } },
		crop: `crops/a${n}.webp`,
		element: null,
		...(resolution ? { resolution } : {}),
	});
	// Its own case each: rows of a case unchanged are kept, with their handlers.
	let n = 0;
	const twoMarks = (): Case => ({
		...sampleCase(`c_marks${++n}`),
		annotations: [
			mark(1),
			mark(2, {
				kind: "wontfix",
				note: "Legal wants it",
				at: "2026-11-08T10:00:00Z",
			}),
		],
	});
	const row = (id: string) =>
		window.document.querySelector(
			`[data-annotation="${id}"]`,
		) as unknown as HTMLElement;
	const action = (id: string, name: string) =>
		row(id).querySelector(
			`[data-mark-action="${name}"]`,
		) as unknown as HTMLButtonElement;
	const chips = () =>
		[...window.document.querySelectorAll("#case-status .chip")].map((b) =>
			(b.textContent ?? "").trim(),
		);

	test("a resolved mark says how, with its note, and the chips sum up", () => {
		render(caseState(twoMarks()), noActions);
		expect(row("a2").dataset["resolved"]).toBe("wontfix");
		expect(row("a2").querySelector(".history")?.textContent).toMatch(
			/^Won't fix .+ · Legal wants it$/,
		);
		expect(row("a1").querySelector(".history")).toBeNull();
		expect(chips()).toEqual(["● Open 1", "– Closed 1"]);
		expect(action("a1", "resolve").textContent).toBe("Resolve…");
		expect(action("a2", "reopen").textContent).toBe("Reopen…");
	});

	test("Resolve opens its form; the choice and note go to resolveMark", () => {
		const c = twoMarks();
		const calls: unknown[] = [];
		const actions = actionsWith({
			editMark: (_c, a, mode) => calls.push(["edit", a.id, mode]),
			resolveMark: (_c, a, kind, note) =>
				calls.push(["resolve", a.id, kind, note]),
		});
		render(caseState(c), actions);
		action("a1", "resolve").click();
		render(
			caseState(c, (s) => {
				s.markEdit = {
					annotationId: "a1",
					mode: "resolve",
					kind: "fixed",
					text: "",
				};
			}),
			actions,
		);
		const form = row("a1").querySelector(
			"[data-form=resolve]",
		) as unknown as HTMLElement;
		const radio = form.querySelector(
			'input[value="cantreproduce"]',
		) as unknown as HTMLInputElement;
		radio.checked = true;
		(form.querySelector("input.note") as unknown as HTMLInputElement).value =
			"Not on dev";
		(
			form.querySelector(
				'[data-mark-action="resolve-done"]',
			) as unknown as HTMLElement
		).click();
		expect(calls).toEqual([
			["edit", "a1", "resolve"],
			["resolve", "a1", "cantreproduce", "Not on dev"],
		]);
	});

	test("a form takes the focus when it opens, not at each redraw", async () => {
		const c = twoMarks();
		const editing = (updatedAt: string) =>
			caseState({ ...c, updatedAt }, (s) => {
				s.markEdit = {
					annotationId: "a1",
					mode: "comment",
					kind: "fixed",
					text: "x",
				};
			});
		render(editing("2026-11-08T10:00:00Z"), noActions);
		await Promise.resolve();
		const comment = row("a1").querySelector(
			"textarea",
		) as unknown as HTMLElement;
		expect(window.document.activeElement).toBe(comment as never);
		el<HTMLTextAreaElement>("verdict").focus();
		// Another window or an AI app changed the case: the list is drawn again.
		render(editing("2026-11-08T10:01:00Z"), noActions);
		await Promise.resolve();
		expect(window.document.activeElement).toBe(el("verdict") as never);
	});

	test("AI findings show under the comment with their app; Delete asks once more", () => {
		const c: Case = {
			...twoMarks(),
			annotations: [
				{
					...mark(1),
					findings: [
						{
							id: "f_1",
							text: "Padding in Card.tsx",
							app: {
								id: "https://claude.ai/oauth",
								name: "Claude",
								host: "claude.ai",
							},
							at: "2026-11-10T10:00:00Z",
						},
						{
							id: "f_2",
							text: "From a file",
							app: { id: "x", host: "other.example" },
							at: "2026-11-10T10:00:00Z",
							imported: true,
						},
					],
				},
				mark(2),
			],
		};
		const deleted: string[] = [];
		const actions = actionsWith({
			deleteFinding: (_c, a, id) => void deleted.push(`${a.id}:${id}`),
		});
		render(
			caseState(c, (s) => {
				s.findingDeleteArmed = {
					annotationId: "a1",
					findingId: "f_2",
					at: 1,
				};
			}),
			actions,
		);
		const finding = (id: string) =>
			row("a1").querySelector(
				`[data-finding="${id}"]`,
			) as unknown as HTMLElement;
		expect(row("a1").querySelector(".findings-count")?.textContent).toBe(
			"2 AI findings",
		);
		expect(row("a2").querySelector(".findings")).toBeNull();
		expect(finding("f_1").querySelector(".finding-text")?.textContent).toBe(
			"Padding in Card.tsx",
		);
		expect(finding("f_1").textContent).toContain("Claude (claude.ai), ");
		expect(finding("f_2").textContent).toContain(
			"other.example, as the file says",
		);
		const button = (id: string) =>
			finding(id).querySelector(
				'[data-finding-action="delete"]',
			) as unknown as HTMLButtonElement;
		expect(button("f_1").textContent).toBe("Delete");
		expect(button("f_2").textContent).toBe("Really delete?");
		button("f_1").click();
		expect(deleted).toEqual(["a1:f_1"]);
	});

	test("a finding's Delete, clicked once, asks on its own mark only: ids repeat on other marks", () => {
		const finding = (id: string) => ({
			id,
			text: "Same id elsewhere",
			app: { id: "x", host: "other.example" },
			at: "2026-11-10T10:00:00Z",
		});
		const c: Case = {
			...twoMarks(),
			annotations: [
				{ ...mark(1), findings: [finding("f_1")] },
				{ ...mark(2), findings: [finding("f_1")] },
			],
		};
		render(
			caseState(c, (s) => {
				s.findingDeleteArmed = {
					annotationId: "a2",
					findingId: "f_1",
					at: 1,
				};
			}),
			noActions,
		);
		const button = (annotationId: string) =>
			row(annotationId).querySelector(
				'[data-finding="f_1"] [data-finding-action="delete"]',
			) as unknown as HTMLButtonElement;
		expect(button("a1").textContent).toBe("Delete");
		expect(button("a1").hasAttribute("data-armed")).toBe(false);
		expect(button("a2").textContent).toBe("Really delete?");
		expect(button("a2").hasAttribute("data-armed")).toBe(true);
	});

	test("Delete asks once more", () => {
		const c = twoMarks();
		render(
			caseState(c, (s) => {
				s.markDeleteArmed = { annotationId: "a1", at: 1 };
			}),
			noActions,
		);
		expect(action("a1", "delete").textContent).toBe("Really delete?");
		expect(action("a2", "delete").textContent).toBe("Delete");
	});

	test("Show sits in a mark's head, where the page can show the mark", () => {
		const c = twoMarks();
		const shown: [string, number][] = [];
		const actions = actionsWith({
			showMatch: (_caseId, a, candidate) => shown.push([a.id, candidate]),
		});
		const found: AnnotationMatch = {
			annotationId: "a1",
			number: 1,
			status: "found",
			score: 1,
			current: 0,
			candidates: [
				{ score: 1, summary: "p", selector: "p", visible: true, found: true },
			],
		};
		// A note or box: no element to find, but Show still scrolls to it.
		const noElement: AnnotationMatch = {
			annotationId: "a2",
			number: 2,
			status: "no-element",
			score: 0,
			current: 0,
			candidates: [],
		};
		const withImages = (loaded: boolean, matches = new Map([["a1", found]])) =>
			caseState(c, (s) => {
				s.images = {
					caseId: c.id,
					version: "v1",
					urls: new Map([
						["crops/a1.webp", "blob:a1"],
						["crops/a2.webp", "blob:a2"],
					]),
				};
				if (loaded)
					s.loaded = {
						caseId: c.id,
						tabId: 1,
						matches,
					};
			});
		// Not loaded on a tab: nothing to show.
		render(withImages(false), actions);
		expect(row("a1").querySelector("[data-action=show]")).toBeNull();
		render(withImages(true), actions);
		const show = (id: string) =>
			row(id).querySelector(
				".mark-head [data-action=show]",
			) as unknown as HTMLButtonElement | null;
		expect(show("a1")?.getAttribute("aria-label")).toBe(
			"Show mark 1 on the page",
		);
		show("a1")?.click();
		expect(shown).toEqual([["a1", 0]]);
		// A mark the page has no match for: no Show.
		expect(show("a2")).toBeNull();
		// A note or box has no element, and Show still scrolls to it.
		render(
			withImages(
				true,
				new Map([
					["a1", found],
					["a2", noElement],
				]),
			),
			actions,
		);
		show("a2")?.click();
		expect(shown).toEqual([
			["a1", 0],
			["a2", 0],
		]);
		// A crop is small; a click shows it large, another small again.
		const crop = row("a1").querySelector(
			"button.crop",
		) as unknown as HTMLButtonElement;
		expect(crop.getAttribute("aria-pressed")).toBe("false");
		crop.click();
		expect(crop.getAttribute("aria-pressed")).toBe("true");
		crop.click();
		expect(crop.getAttribute("aria-pressed")).toBe("false");
	});

	test("a mark opens and closes at its head; Expand all opens every one", () => {
		const c = twoMarks();
		render(caseState(c), noActions);
		const isOpen = (id: string) => {
			const toggle = row(id).querySelector(".mark-toggle");
			const body = row(id).querySelector(".body") as unknown as HTMLElement;
			expect(toggle?.getAttribute("aria-expanded")).toBe(String(!body.hidden));
			return !body.hidden;
		};
		const all = () =>
			window.document.getElementById(
				"toggle-marks",
			) as unknown as HTMLButtonElement;
		expect([isOpen("a1"), isOpen("a2")]).toEqual([false, false]);
		expect(all().textContent).toBe("Expand all");
		(
			row("a1").querySelector(".mark-toggle") as unknown as HTMLButtonElement
		).click();
		expect([isOpen("a1"), isOpen("a2")]).toEqual([true, false]);
		all().click();
		expect([isOpen("a1"), isOpen("a2")]).toEqual([true, true]);
		expect(all().textContent).toBe("Collapse all");
		// Drawn again (the case changed): what was open stays open.
		render(caseState({ ...c, updatedAt: "2026-11-08T23:00:00Z" }), noActions);
		expect([isOpen("a1"), isOpen("a2")]).toEqual([true, true]);
		all().click();
		expect([isOpen("a1"), isOpen("a2")]).toEqual([false, false]);
		// A mark being edited is open.
		render(
			caseState(c, (s) => {
				s.markEdit = {
					annotationId: "a2",
					mode: "comment",
					kind: "fixed",
					text: "",
				};
			}),
			noActions,
		);
		expect(isOpen("a2")).toBe(true);
		// Neither Collapse all nor its own head hides its form.
		all().click();
		all().click();
		expect([isOpen("a1"), isOpen("a2")]).toEqual([false, true]);
		(
			row("a2").querySelector(".mark-toggle") as unknown as HTMLButtonElement
		).click();
		expect(isOpen("a2")).toBe(true);
	});

	test("a closed mark says its state in a word, and the counts read apart", () => {
		const c = twoMarks();
		const found: AnnotationMatch = {
			annotationId: "a1",
			number: 1,
			status: "lost",
			score: 0,
			current: 0,
			candidates: [],
		};
		render(
			caseState(c, (s) => {
				s.loaded = {
					caseId: c.id,
					tabId: 1,
					matches: new Map([["a1", found]]),
				};
			}),
			noActions,
		);
		const state = (id: string) =>
			row(id).querySelector(".mark-sub .state")?.textContent;
		const pill = (id: string) =>
			row(id).querySelector(".mark-sub .pill")?.textContent;
		expect(state("a1")).toBe("Not found on this page");
		expect(pill("a1")).toBeUndefined();
		expect(pill("a2")).toBe("Won't fix");
		expect(window.document.getElementById("marks-heading")?.textContent).toBe(
			"Marks 2",
		);
		// The bar: one open, one closed, each its share; above the actions.
		const bar = [
			...window.document.querySelectorAll("#case-status .progress > span"),
		].map((s) => [s.getAttribute("data-kind"), s.getAttribute("style")]);
		expect(bar).toEqual([
			["open", "flex-grow: 1"],
			["closed", "flex-grow: 1"],
		]);
	});
});

describe("Verify (DEC-023)", () => {
	const CLAUDE = {
		id: "https://claude.ai/oauth",
		name: "Claude",
		host: "claude.ai",
	};
	const mark = (n: number, more: Partial<Annotation> = {}): Annotation => ({
		id: `a${n}`,
		number: n,
		shot: "s1",
		comment: `Comment ${n}`,
		author: "user",
		shape: { kind: "note", at: { x: 1, y: 1 } },
		crop: `crops/a${n}.webp`,
		element: null,
		...more,
	});
	let n = 0;
	/** Open, to verify, verified, won't fix; mark 1 reopened once. */
	const fourMarks = (): Case => ({
		...sampleCase(`c_verify${++n}`),
		annotations: [
			mark(1, {
				reopens: [
					{
						note: "Still pale on hover\nand on focus",
						at: "2026-11-13T16:00:00Z",
						was: {
							kind: "fixed",
							note: "Darker text, 7:1 now",
							at: "2026-11-13T11:00:00Z",
						},
					},
				],
			}),
			mark(2, {
				resolution: {
					kind: "fixed",
					note: "Hover state too",
					at: "2026-11-14T09:00:00Z",
					app: CLAUDE,
				},
			}),
			mark(3, {
				resolution: {
					kind: "fixed",
					at: "2026-11-14T09:00:00Z",
					verified: { at: "2026-11-14T15:00:00Z" },
				},
			}),
			mark(4, { resolution: { kind: "wontfix", at: "2026-11-14T09:00:00Z" } }),
		],
	});
	const row = (id: string) =>
		window.document.querySelector(
			`[data-annotation="${id}"]`,
		) as unknown as HTMLElement;
	const actionsOf = (id: string) =>
		[...row(id).querySelectorAll(".mark-actions [data-mark-action]")].map(
			(b) => b.textContent,
		);
	const rows = () =>
		[...window.document.querySelectorAll("li.annotation")].map((li) =>
			li.getAttribute("data-annotation"),
		);

	test("the status block: a bar and the chips in order, counts above zero", () => {
		render(caseState(fourMarks()), noActions);
		const bar = [
			...window.document.querySelectorAll("#case-status .progress > span"),
		].map((s) => s.getAttribute("data-kind"));
		expect(bar).toEqual(["open", "toVerify", "verified", "closed"]);
		expect(
			[...window.document.querySelectorAll("#case-status .chip")].map((b) =>
				(b.textContent ?? "").trim(),
			),
		).toEqual(["● Open 1", "◐ To verify 1", "✓ Verified 1", "– Closed 1"]);
		expect(window.document.querySelector(".all-done")).toBeNull();
	});

	test("the status block and Show marks sit in the marks' section, under its heading", () => {
		const c = fourMarks();
		render(caseState(c), noActions);
		const marks = window.document.querySelector("section.marks");
		const bar = marks?.querySelector(".marks-bar");
		// The chips filter this list: straight under its bar, above the marks.
		const holder = el("case-status").parentElement;
		expect(holder?.parentElement).toBe(marks as never);
		expect(holder?.previousElementSibling).toBe(bar as never);
		expect(
			window.document.querySelector(".case-header #case-status"),
		).toBeNull();
		// Show marks is what is done with the list: in its bar.
		expect(bar?.contains(el("load-case") as never)).toBe(true);
		expect(window.document.querySelector("#this-tab #load-case")).toBeNull();
		// A redraw of the list keeps both, and the focus on the button pressed.
		el("load-case").focus();
		render(
			caseState({ ...c, updatedAt: "2026-11-14T10:00:00.000Z" }),
			noActions,
		);
		expect(window.document.querySelectorAll("#load-case").length).toBe(1);
		expect(window.document.querySelectorAll("#case-status").length).toBe(1);
		expect(
			window.document
				.querySelector("section.marks .marks-bar")
				?.contains(el("load-case") as never),
		).toBe(true);
		expect(window.document.activeElement?.id).toBe("load-case");
		// A chip drawn anew after its click has the focus still.
		(
			window.document.querySelector(
				'#case-status .chip[data-group="open"]',
			) as unknown as HTMLElement
		).focus();
		render(
			caseState(c, (s) => {
				s.markFilter = { caseId: c.id, group: "open", upTo: 4 };
			}),
			noActions,
		);
		const at = window.document.activeElement;
		expect(at?.getAttribute("data-group")).toBe("open");
		expect(at?.getAttribute("aria-pressed")).toBe("true");
		// A case without marks: no block, no gap for one.
		render(caseState({ ...c, id: "c_none", annotations: [] }), noActions);
		expect(window.document.querySelector("#case-status")).toBeNull();
		expect(
			(
				window.document.querySelector(
					"section.marks .case-status",
				) as unknown as HTMLElement | null
			)?.hidden,
		).toBe(true);
	});

	test("a mark picked on the page opens its row, once per click (DEC-027)", () => {
		const c = fourMarks();
		const open = (id: string) =>
			window.document
				.querySelector(`[data-annotation="${id}"]`)
				?.hasAttribute("data-open");
		render(caseState(c), noActions);
		expect(open("a3")).toBe(false);
		const picked = (at: number) =>
			caseState(c, (s) => {
				s.picked = { caseId: c.id, annotationId: "a3", at };
			});
		render(picked(1), noActions);
		expect(open("a3")).toBe(true);
		expect(
			window.document
				.querySelector('[data-annotation="a3"]')
				?.hasAttribute("data-picked"),
		).toBe(true);
		// Closed by hand: the same click does not open it again.
		(
			window.document.querySelector(
				'[data-annotation="a3"] .mark-toggle',
			) as unknown as HTMLElement
		).click();
		expect(open("a3")).toBe(false);
		render(picked(1), noActions);
		expect(open("a3")).toBe(false);
		// Another click does; another case's does not.
		render(picked(2), noActions);
		expect(open("a3")).toBe(true);
		render(
			caseState(c, (s) => {
				s.picked = { caseId: "c_other", annotationId: "a1", at: 3 };
			}),
			noActions,
		);
		expect(open("a1")).toBe(false);
	});

	test("a chip filters the list, a second click or Show all shows all", () => {
		const c = fourMarks();
		const filters: unknown[] = [];
		const actions = actionsWith({
			filterMarks: (id, group) => void filters.push([id, group]),
		});
		render(caseState(c), actions);
		(
			window.document.querySelector(
				'#case-status .chip[data-group="toVerify"]',
			) as unknown as HTMLElement
		).click();
		const filtered = caseState(c, (s) => {
			s.markFilter = { caseId: c.id, group: "toVerify", upTo: 4 };
		});
		render(filtered, actions);
		expect(rows()).toEqual(["a2"]);
		expect(
			window.document
				.querySelector('.chip[data-group="toVerify"]')
				?.getAttribute("aria-pressed"),
		).toBe("true");
		expect(el("marks-filtered").textContent).toBe(
			"Showing 1 of 4 marks. Show all",
		);
		(
			window.document.querySelector(
				'.chip[data-group="toVerify"]',
			) as unknown as HTMLElement
		).click();
		(
			window.document.querySelector(
				'[data-action="show-all"]',
			) as unknown as HTMLElement
		).click();
		expect(filters).toEqual([
			[c.id, "toVerify"],
			[c.id, undefined],
			[c.id, undefined],
		]);
		// Another case's filter is not this one's.
		render(
			caseState(c, (s) => {
				s.markFilter = { caseId: "c_other", group: "toVerify", upTo: 4 };
			}),
			actions,
		);
		expect(rows()).toEqual(["a1", "a2", "a3", "a4"]);
		expect(el("marks-filtered")).toBeNull();
	});

	test("the filter ends when its marks are gone, or a mark is added", () => {
		const c = fourMarks();
		const filtered = (k: Case) =>
			caseState(k, (s) => {
				s.markFilter = { caseId: c.id, group: "toVerify", upTo: 4 };
			});
		// The last mark to verify verified: all marks again, no empty list.
		const none: Case = {
			...c,
			updatedAt: "2026-11-15T10:00:00Z",
			annotations: c.annotations.filter((a) => a.id !== "a2"),
		};
		render(filtered(none), noActions);
		expect(rows()).toEqual(["a1", "a3", "a4"]);
		expect(el("marks-filtered")).toBeNull();
		// A mark drawn while filtered shows, whatever its status.
		const added: Case = {
			...c,
			updatedAt: "2026-11-15T11:00:00Z",
			annotations: [...c.annotations, mark(5)],
		};
		render(filtered(added), noActions);
		expect(rows()).toEqual(["a1", "a2", "a3", "a4", "a5"]);
		expect(
			window.document
				.querySelector('.chip[data-group="toVerify"]')
				?.getAttribute("aria-pressed"),
		).toBe("false");
	});

	test("nothing open or to verify: a line says so", () => {
		const c = fourMarks();
		c.annotations = c.annotations.slice(2);
		render(caseState(c), noActions);
		expect(
			window.document.querySelector("#case-status .all-done")?.textContent,
		).toBe("✓ All marks are verified or closed.");
	});

	test("each status: its pill, its strong button and the others", () => {
		render(caseState(fourMarks()), noActions);
		const pill = (id: string) =>
			row(id).querySelector(".mark-sub .pill")?.textContent;
		expect([pill("a1"), pill("a2"), pill("a3"), pill("a4")]).toEqual([
			undefined,
			"To verify",
			"Verified",
			"Won't fix",
		]);
		expect(actionsOf("a1")).toEqual(["Resolve…", "Edit comment", "Delete"]);
		expect(actionsOf("a2")).toEqual([
			"Verified",
			"Reopen…",
			"Change…",
			"Edit comment",
			"Delete",
		]);
		for (const id of ["a3", "a4"])
			expect(actionsOf(id)).toEqual([
				"Reopen…",
				"Change…",
				"Edit comment",
				"Delete",
			]);
		const strong = (id: string) =>
			[...row(id).querySelectorAll(".mark-actions .strong")].map(
				(b) => b.textContent,
			);
		expect([strong("a1"), strong("a2"), strong("a3")]).toEqual([
			["Resolve…"],
			["Verified"],
			[],
		]);
		// To verify: Verified and Reopen… in the collapsed head too.
		expect(
			[...row("a2").querySelectorAll(".mark-sub button")].map(
				(b) => b.textContent,
			),
		).toEqual(["Verified", "Reopen…"]);
		expect(row("a3").querySelector(".mark-sub button")).toBeNull();
		expect(
			row("a2")
				.querySelector('.mark-sub [data-mark-action="verify"]')
				?.getAttribute("title"),
		).toBe("The fix holds on the page you checked");
		// A mark to verify is drawn in full; verified and closed step back.
		expect(row("a2").hasAttribute("data-resolved")).toBe(false);
		expect(row("a2").dataset["status"]).toBe("fixed");
		expect(row("a3").dataset["resolved"]).toBe("fixed");
	});

	test("Verified and Reopen… in the head call their actions", () => {
		const c = fourMarks();
		const calls: unknown[] = [];
		render(
			caseState(c),
			actionsWith({
				verifyMark: (_c, a) => void calls.push(["verify", a.id]),
				editMark: (_c, a, mode) => void calls.push(["edit", a.id, mode]),
			}),
		);
		for (const name of ["verify", "reopen"])
			(
				row("a2").querySelector(
					`.mark-sub [data-mark-action="${name}"]`,
				) as unknown as HTMLElement
			).click();
		expect(calls).toEqual([
			["verify", "a2"],
			["edit", "a2", "reopen"],
		]);
	});

	test("a reopened mark: its note's first line in the head, the history in order", () => {
		const c = fourMarks();
		const verified: Case = {
			...c,
			updatedAt: "2026-11-14T15:00:00Z",
			annotations: [
				{
					...(c.annotations[0] as Annotation),
					resolution: {
						kind: "fixed",
						note: "Hover state too",
						at: "2026-11-14T09:00:00Z",
						app: CLAUDE,
						verified: { at: "2026-11-14T15:00:00Z" },
					},
				},
			],
		};
		render(caseState(c), noActions);
		expect(row("a1").querySelector(".mark-sub .reopened")?.textContent).toBe(
			"Reopened: Still pale on hover",
		);
		render(caseState(verified), noActions);
		const lines = [...row("a1").querySelectorAll(".history li")].map((li) => [
			li.getAttribute("data-kind"),
			li.textContent,
		]);
		expect(lines.map(([kind]) => kind)).toEqual([
			"fixed",
			"reopened",
			"fixed",
			"verified",
		]);
		expect(lines[0]?.[1]).toMatch(/^Fixed .+ · Darker text, 7:1 now$/);
		expect(lines[1]?.[1]).toMatch(/^Reopened .+ · Still pale on hover/);
		expect(lines[2]?.[1]).toMatch(
			/^Fixed .+ by Claude \(claude\.ai\) · Hover state too$/,
		);
		expect(lines[3]?.[1]).toMatch(/^Verified /);
		// Not reopened any more: no reopen line in the head.
		expect(row("a1").querySelector(".mark-sub .reopened")).toBeNull();
	});

	test("a status from a file says so in the history", () => {
		const c = fourMarks();
		const fromFile: Case = {
			...c,
			updatedAt: "2026-11-15T10:00:00Z",
			importedAt: "2026-11-15T10:00:00Z",
			annotations: [
				{
					...(c.annotations[1] as Annotation),
					resolution: {
						kind: "fixed",
						at: "2026-11-14T09:00:00Z",
						app: CLAUDE,
						imported: true,
						verified: { at: "2026-11-14T15:00:00Z", imported: true },
					},
				},
			],
		};
		render(caseState(fromFile), noActions);
		const lines = [...row("a2").querySelectorAll(".history li")].map(
			(li) => li.textContent,
		);
		expect(lines[0]).toMatch(
			/^Fixed .+ by Claude \(claude\.ai\), as the file says$/,
		);
		expect(lines[1]).toMatch(/^Verified .+, as the file says$/);
	});

	test("the crop of a verified or closed mark is not greyed", async () => {
		const css = await Bun.file(
			new URL("../src/sidepanel/style.css", import.meta.url),
		).text();
		expect(css).not.toMatch(/\[data-resolved\][^{]*img/);
	});

	test("Resolve…: four choices, the note, and the choice to resolveMark", () => {
		const c = fourMarks();
		const calls: unknown[] = [];
		const actions = actionsWith({
			resolveMark: (_c, a, kind, note) => void calls.push([a.id, kind, note]),
		});
		render(
			caseState(c, (s) => {
				s.markEdit = {
					annotationId: "a1",
					mode: "resolve",
					kind: "fixed",
					text: "",
				};
			}),
			actions,
		);
		const form = row("a1").querySelector(
			"[data-form=resolve]",
		) as unknown as HTMLElement;
		expect(form.querySelector("legend")?.textContent).toBe("Mark 1 is");
		expect(
			[...form.querySelectorAll("label.choice")].map((l) => l.textContent),
		).toEqual([
			"Fixed, to verify",
			"Fixed and verified",
			"Won't fix",
			"Can't reproduce",
		]);
		expect(
			(form.querySelector("input.note") as unknown as HTMLInputElement)
				.placeholder,
		).toBe("Note (optional): what was done, or why");
		(
			form.querySelector(
				'input[value="verified"]',
			) as unknown as HTMLInputElement
		).checked = true;
		const done = form.querySelector(
			'[data-mark-action="resolve-done"]',
		) as unknown as HTMLElement;
		expect(done.textContent).toBe("Save");
		done.click();
		expect(calls).toEqual([["a1", "verified", ""]]);
	});

	test("Reopen…: the note is required, then goes to reopenMark", () => {
		const c = fourMarks();
		const calls: unknown[] = [];
		const actions = actionsWith({
			reopenMark: (_c, a, note) => void calls.push([a.id, note]),
		});
		render(
			caseState(c, (s) => {
				s.markEdit = {
					annotationId: "a2",
					mode: "reopen",
					kind: "fixed",
					text: "",
				};
			}),
			actions,
		);
		const form = row("a2").querySelector(
			"[data-form=reopen]",
		) as unknown as HTMLElement;
		expect(form.querySelector("legend")?.textContent).toBe("Reopen mark 2");
		const field = form.querySelector(
			"textarea",
		) as unknown as HTMLTextAreaElement;
		expect(field.placeholder).toBe(
			"What is still wrong? The developer reads this first.",
		);
		const done = form.querySelector(
			'[data-mark-action="reopen-done"]',
		) as unknown as HTMLButtonElement;
		expect(done.textContent).toBe("Reopen");
		expect(done.disabled).toBe(true);
		field.value = "   ";
		field.dispatchEvent(new window.Event("input") as unknown as Event);
		expect(done.disabled).toBe(true);
		field.value = "Still pale";
		field.dispatchEvent(new window.Event("input") as unknown as Event);
		expect(done.disabled).toBe(false);
		done.click();
		expect(calls).toEqual([["a2", "Still pale"]]);
		// The head's buttons wait while a form is open.
		expect(row("a2").querySelector(".mark-sub button")).toBeNull();
	});

	test("the case list counts by status, with the bar", () => {
		const c = fourMarks();
		const home = initialState();
		home.cases = [c];
		render(home, noActions);
		const item = window.document.querySelector(
			`[data-case="${c.id}"]`,
		) as unknown as HTMLElement;
		expect(item.textContent).toContain(
			"4 marks (1 open, 1 to verify, 1 verified, 1 closed)",
		);
		expect(
			[...item.querySelectorAll(".progress > span")].map((s) =>
				s.getAttribute("data-kind"),
			),
		).toEqual(["open", "toVerify", "verified", "closed"]);
	});

	test("the import prompt says what differs: the counts of both copies", () => {
		const here = {
			...sampleCase("c_back"),
			annotations: [mark(1), mark(2), mark(3)],
		};
		const file: Case = {
			...here,
			updatedAt: "2026-11-14T10:00:00Z",
			annotations: [
				mark(1),
				mark(2, { resolution: { kind: "fixed", at: "2026-11-14T09:00:00Z" } }),
				mark(3, { resolution: { kind: "fixed", at: "2026-11-14T09:00:00Z" } }),
			],
		};
		const state = initialState();
		state.importing = {
			parsed: { case: file, images: async () => new Map() },
			existing: here,
		};
		render(state, noActions);
		expect(
			window.document.querySelector('[data-role="import-counts"]')?.textContent,
		).toBe("Here: 3 open. In the file: 1 open, 2 to verify.");
		state.importing = undefined;
		render(state, noActions);
	});
});

describe("Load and Hide", () => {
	test("a case loaded on the tab in front offers to hide its marks", () => {
		const c = sampleCase("c_loaded");
		const called: string[] = [];
		const actions = actionsWith({
			loadOntoTab: () => called.push("load"),
			hideFromTab: () => called.push("hide"),
		});
		render(caseState(c), actions);
		expect(el("load-case").textContent).toBe("Show marks");
		// A button with an edge, so it is seen, but not the case's primary:
		// that is Add marks (DEC-023).
		expect(el("load-case").classList.contains("primary")).toBe(false);
		expect(el("load-case").classList.contains("quiet")).toBe(false);
		expect(el("load-case").classList.contains("link")).toBe(false);
		el("load-case").click();
		const loadedOn = (front: number) =>
			caseState(c, (s) => {
				s.tab = {
					id: front,
					url: "http://localhost:3000/kk",
					title: "",
					size: undefined,
				};
				s.loaded = { caseId: c.id, tabId: 1, matches: new Map() };
			});
		render(loadedOn(1), actions);
		expect(el("load-case").textContent).toBe("Hide marks");
		el("load-case").click();
		// Its marks are on another tab: this one can show them.
		render(loadedOn(2), actions);
		expect(el("load-case").textContent).toBe("Show marks");
		// Loaded by an AI app: the page says so.
		render(
			caseState(c, (s) => {
				s.overlay = {
					visible: false,
					url: "",
					title: "",
					drafts: 0,
					saving: false,
					loadedCase: c.id,
				};
			}),
			actions,
		);
		expect(el("load-case").textContent).toBe("Hide marks");
		expect(called).toEqual(["load", "hide"]);
	});
});

describe("a case on a tab Overmark may not run on", () => {
	const noAccess = (c: Case, allSites = false) =>
		caseState(c, (s) => {
			s.tab = { id: 1, url: "", title: "", size: undefined };
			s.allSites = allSites;
		});
	const withMark = (): Case => ({
		...sampleCase("c_reach"),
		annotations: [
			{
				id: "a1",
				number: 1,
				shot: "s1",
				comment: "Here",
				author: "user",
				shape: { kind: "note", at: { x: 1, y: 1 } },
				crop: "crops/a1.webp",
				element: null,
			},
		],
	});

	test("the notice with Allow on all sites; only what needs the page is off", () => {
		const c = withMark();
		const asked: string[] = [];
		const state = noAccess(c);
		state.loaded = {
			caseId: c.id,
			tabId: 1,
			matches: new Map([
				[
					"a1",
					{
						annotationId: "a1",
						number: 1,
						status: "no-element",
						score: 0,
						current: 0,
						candidates: [],
					},
				],
			]),
		};
		render(state, actionsWith({ allowAllSites: () => void asked.push("all") }));
		const notice = el("case-access");
		expect(notice.hidden).toBe(false);
		expect(notice.textContent).toContain("Click the Overmark icon");
		expect(notice.querySelector("svg.notice-icon")).not.toBeNull();
		// In the This tab block, which says nothing else.
		expect(notice.parentElement).toBe(el("this-tab"));
		expect(el("tab-line").hidden).toBe(true);
		(
			notice.querySelector(
				'[data-action="allow-all-sites"]',
			) as unknown as HTMLButtonElement
		).click();
		expect(asked).toEqual(["all"]);
		// Show marks goes; Add marks is off and says why.
		expect(el("load-case").hidden).toBe(true);
		expect(el<HTMLButtonElement>("add-marks").disabled).toBe(true);
		expect(el("add-marks").title).toContain("see the notice");
		// The notice is below the actions in a case, above the button on Home.
		expect(el("add-marks").title).not.toContain("above");
		const show = window.document.querySelector(
			'[data-action="show"]',
		) as unknown as HTMLButtonElement;
		expect(show.disabled).toBe(true);
		expect(show.title).toContain("see the notice");
		// The rest works without the tab.
		for (const id of ["export-case", "delete-case", "save-verdict"])
			expect(el<HTMLButtonElement>(id).disabled).toBe(false);
	});

	test("with all sites allowed: the tab is Chrome's own, no button", () => {
		render(noAccess(sampleCase("c_never"), true), noActions);
		expect(el("case-access").textContent).toContain("cannot run on this tab");
		expect(
			(
				el("case-access").querySelector(
					'[data-action="allow-all-sites"]',
				) as unknown as HTMLElement
			).hidden,
		).toBe(true);
	});

	test("with all sites allowed but no file access: it may be a file, the details open the toggle", () => {
		const opened: string[] = [];
		const asked: string[] = [];
		const state = noAccess(sampleCase("c_file"), true);
		state.fileAccess = false;
		render(
			state,
			actionsWith({
				openDetails: () => void opened.push("details"),
				allowAllSites: () => void asked.push("all"),
			}),
		);
		const notice = el("case-access");
		expect(notice.textContent).toContain("Allow access to file URLs");
		expect(notice.textContent).toContain("Chrome Web Store");
		const button = notice.querySelector(
			"button",
		) as unknown as HTMLButtonElement;
		expect(button.hidden).toBe(false);
		expect(button.textContent).toBe("Open Overmark's details");
		button.click();
		expect(opened).toEqual(["details"]);
		expect(asked).toEqual([]);
		// With file access, the tab is Chrome's own: no button.
		state.fileAccess = true;
		render(state, noActions);
		expect(notice.textContent).not.toContain("file URLs");
		expect(button.hidden).toBe(true);
	});

	test("with access: no notice, the buttons on", () => {
		render(
			caseState(withMark(), (s) => {
				s.tab = {
					id: 1,
					url: "http://localhost:3000/kk",
					title: "",
					size: undefined,
				};
			}),
			noActions,
		);
		expect(el("case-access").hidden).toBe(true);
		expect(el<HTMLButtonElement>("load-case").disabled).toBe(false);
		expect(el<HTMLButtonElement>("add-marks").disabled).toBe(false);
	});
});

describe("none of the case's marks found (DEC-022)", () => {
	const match = (
		n: number,
		status: AnnotationMatch["status"],
	): AnnotationMatch => ({
		annotationId: `a${n}`,
		number: n,
		status,
		score: status === "lost" ? 0 : 0.9,
		current: 0,
		candidates:
			status === "lost"
				? []
				: [
						{
							score: 0.9,
							summary: "button",
							selector: "button",
							visible: true,
							found: status === "found",
						},
					],
	});
	const on = (
		url: string,
		matches: AnnotationMatch[],
		settling = false,
	): PanelState => {
		const c = sampleCase("c_none");
		return caseState(c, (s) => {
			s.tab = { id: 1, url, title: "", size: undefined };
			s.loaded = {
				caseId: c.id,
				tabId: 1,
				matches: new Map(matches.map((m) => [m.annotationId, m])),
				settling,
			};
		});
	};

	test("on another page: says so, with the case's page and a way there", () => {
		const opened: string[] = [];
		render(
			on("http://localhost:3000/other", [match(1, "lost"), match(2, "lost")]),
			actionsWith({ openPage: (c) => void opened.push(c.id) }),
		);
		const warning = el("none-found");
		expect(warning.hidden).toBe(false);
		expect(warning.querySelector("svg.notice-icon")).not.toBeNull();
		expect(warning.textContent).toContain(
			"None of this case's marks were found on this page. It is probably for another page: www.example.com/kk.",
		);
		const open = warning.querySelector(
			'[data-action="open-case-page"]',
		) as unknown as HTMLButtonElement;
		expect(open.hidden).toBe(false);
		open.click();
		expect(opened).toEqual(["c_none"]);
	});

	test("on the case's own path (another build): says so, no claim of another page", () => {
		render(on("http://localhost:3000/kk", [match(1, "lost")]), noActions);
		expect(el("none-found").hidden).toBe(false);
		expect(el("none-found").textContent).not.toContain("another page");
		expect(
			(
				el("none-found").querySelector(
					'[data-action="open-case-page"]',
				) as unknown as HTMLElement
			).hidden,
		).toBe(true);
	});

	test("some found, still being looked for, or nothing to tell by: no warning", () => {
		const url = "http://localhost:3000/other";
		render(on(url, [match(1, "lost"), match(2, "probable")]), noActions);
		expect(el("none-found").hidden).toBe(true);
		render(on(url, [match(1, "lost")], true), noActions);
		expect(el("none-found").hidden).toBe(true);
		render(on(url, [match(1, "no-element")]), noActions);
		expect(el("none-found").hidden).toBe(true);
	});
});

describe("the case's page and size", () => {
	const at = (url: string) => {
		const c = sampleCase("c_page");
		return { ...c, page: { ...c.page, url } };
	};

	test("a web page's address is a link that opens it", () => {
		const opened: Case[] = [];
		const c = at("https://www.example.com/krankenkassen/default?x=1");
		render(caseState(c), actionsWith({ openPage: (it) => opened.push(it) }));
		const link = el<HTMLButtonElement>("open-page");
		expect(link.hidden).toBe(false);
		expect(link.textContent).toBe("www.example.com/krankenkassen/default");
		link.click();
		expect(opened.map((it) => it.id)).toEqual(["c_page"]);
	});

	test("any other address is only text: an imported case's is anyone's", () => {
		for (const url of [
			"javascript:alert(1)",
			"file:///etc/passwd",
			"chrome://settings",
		]) {
			render(caseState(at(url)), noActions);
			expect(el("open-page").hidden).toBe(true);
			const chips = [...(el("open-page").parentElement?.children ?? [])]
				.filter((chip) => !(chip as unknown as HTMLElement).hidden)
				.map((chip) => chip.textContent);
			expect(chips).toEqual([
				url,
				expect.stringMatching(/^\d+×\d+$/),
				expect.stringMatching(/\d{4}/),
			]);
		}
	});

	test("a tab of another size offers the case's", () => {
		const c = sampleCase("c_size");
		const { width, height } = c.page.viewport;
		const tab = (size?: { width: number; height: number }) =>
			caseState(c, (s) => {
				s.tab = { id: 1, url: "", title: "", size };
			});
		render(tab({ width: width - 300, height }), noActions);
		expect(el("case-size").hidden).toBe(false);
		expect(el("case-size").textContent).toContain(
			`This tab is ${width - 300}×${height}`,
		);
		expect(el("match-size").textContent).toBe("Match size");
		render(tab({ width: width + 1, height }), noActions);
		expect(el("case-size").hidden).toBe(true);
		render(tab(undefined), noActions);
		expect(el("case-size").hidden).toBe(true);
	});
});

describe("what stays between renders", () => {
	test("the open case's buttons stay the same elements", () => {
		const c = sampleCase("c_keep");
		render(caseState(c), noActions);
		const buttons = ["load-case", "add-marks", "export-case", "delete-case"];
		const drawn = buttons.map((id) => el(id));
		const same = () => buttons.every((id, i) => el(id) === drawn[i]);
		render(
			caseState(c, (s) => {
				s.deleteArmedAt = 1;
				s.caseHint = "3 of 5 marks found";
			}),
			noActions,
		);
		expect(same()).toBe(true);
		expect(el("delete-case").textContent).toBe("Really delete?");
		expect(el("delete-case").hasAttribute("data-armed")).toBe(true);
		expect(el("case-hint").textContent).toBe("3 of 5 marks found");
		expect(el("case-hint").hidden).toBe(false);
		render(caseState(c), noActions);
		expect(el("delete-case").textContent).toBe("Delete");
		expect(el("delete-case").hasAttribute("data-armed")).toBe(false);
		expect(el("case-hint").hidden).toBe(true);
	});

	test("a button acts on the case as it is now, not as it was first drawn", () => {
		const c = sampleCase("c_now");
		const exported: Case[] = [];
		const actions = actionsWith({ exportCase: (x) => void exported.push(x) });
		render(caseState(c), actions);
		const newer = { ...c, title: "Newer", updatedAt: "2026-11-05T10:00:00Z" };
		render(caseState(newer), actions);
		el("export-case").click();
		expect(exported).toEqual([newer]);
	});

	test("the case list is drawn again only when it shows something else", () => {
		const state = initialState();
		state.cases = [sampleCase("c_a"), sampleCase("c_b")];
		render(state, noActions);
		const item = () => window.document.querySelector("[data-case]");
		const first = item();
		render(state, noActions);
		expect(item() === first).toBe(true);
		state.cases = [
			{ ...sampleCase("c_a"), updatedAt: "2026-11-05T10:00:00Z" },
			sampleCase("c_b"),
		];
		render(state, noActions);
		expect(item() === first).toBe(false);
	});

	test("the import prompt is drawn again only when it shows something else", () => {
		const existing = sampleCase("c_in");
		const state = initialState();
		state.importing = {
			parsed: { case: sampleCase("c_in"), images: async () => new Map() },
			existing,
		};
		render(state, noActions);
		const button = () =>
			window.document.querySelector('[data-action="import-replace"]');
		const first = button();
		expect(first === null).toBe(false);
		render(state, noActions);
		expect(button() === first).toBe(true);
		state.importing = {
			...state.importing,
			existing: { ...existing, updatedAt: "2026-11-05T10:00:00Z" },
		};
		render(state, noActions);
		expect(button() === first).toBe(false);
		state.importing = undefined;
		render(state, noActions);
		expect(button() === null).toBe(true);
		expect(el("import-prompt").hidden).toBe(true);
	});
});

describe("the summary for the developer", () => {
	const value = () => el<HTMLTextAreaElement>("verdict").value;

	test("is labelled so, says what it is for, and shows in the case list", () => {
		const c = { ...sampleCase("c_s"), verdict: "Darker button" };
		render(caseState(c), noActions);
		expect(
			window.document.querySelector('label[for="verdict"]')?.textContent,
		).toBe("Summary for the developer");
		expect(el<HTMLTextAreaElement>("verdict").placeholder).toContain(
			"Whoever loads this case sees it first.",
		);
		expect(el("save-verdict").textContent).toBe("Save summary");
		const home = initialState();
		home.cases = [c];
		render(home, noActions);
		expect(
			window.document.querySelector('[data-case="c_s"]')?.textContent,
		).toContain("Summary for the developer: Darker button");
	});

	test("a draft stays while the case changes, and comes back after leaving", () => {
		const c = sampleCase("c_v");
		const drafts = (s: PanelState) => s.verdictDrafts.set(c.id, "Typed");
		render(caseState(c, drafts), noActions);
		expect(value()).toBe("Typed");
		expect(el("verdict-status").textContent).toBe("Not saved yet");
		render(caseState({ ...c, verdict: "From the AI app" }, drafts), noActions);
		expect(value()).toBe("Typed");
		render(initialState(), noActions);
		render(caseState(c, drafts), noActions);
		expect(value()).toBe("Typed");
	});

	test("without a draft it shows what is stored, whitespace or not", () => {
		const c = { ...sampleCase("c_w"), verdict: "abc" };
		const typed = (s: PanelState) => s.verdictDrafts.set(c.id, "abc\n");
		render(caseState(c, typed), noActions);
		expect(value()).toBe("abc\n");
		render(caseState(c), noActions);
		expect(value()).toBe("abc");
		render(caseState({ ...c, verdict: "From the AI app" }), noActions);
		expect(value()).toBe("From the AI app");
		expect(el("verdict-status").textContent).toBe("");
	});

	test("Save summary shows only while the text differs from what is stored", () => {
		const c = { ...sampleCase("c_sv"), verdict: "Stored" };
		render(caseState(c), noActions);
		expect(el("save-verdict").hidden).toBe(true);
		render(
			caseState(c, (s) => s.verdictDrafts.set(c.id, "Stored, and more")),
			noActions,
		);
		expect(el("save-verdict").hidden).toBe(false);
		expect(el("verdict-status").textContent).toBe("Not saved yet");
		// Saved: the draft is gone, "Saved" stays a moment without the button.
		render(
			caseState(c, (s) => (s.verdictStatus = "Saved")),
			noActions,
		);
		expect(el("save-verdict").hidden).toBe(true);
		expect(el("verdict-status").textContent).toBe("Saved");
	});

	test("typing tells the panel", () => {
		const c = sampleCase("c_t");
		const typed: string[] = [];
		const actions = actionsWith({
			typeVerdict: (_id, text) => void typed.push(text),
		});
		render(caseState(c), actions);
		const verdict = el<HTMLTextAreaElement>("verdict");
		verdict.value = "Hello";
		verdict.dispatchEvent(new window.Event("input") as unknown as Event);
		expect(typed).toEqual(["Hello"]);
	});
});

describe("an imported case", () => {
	test("says so in its header", () => {
		const c = {
			...sampleCase("c_i"),
			importedAt: "2026-11-05T09:00:00.000Z",
		};
		render(caseState(c), noActions);
		expect(el("case-origin").hidden).toBe(false);
		expect(el("case-origin").textContent).toContain("Imported from a file");
		// What came in with it is the file's: statuses and reopen notes too.
		expect(el("case-origin").textContent).toContain(
			"statuses and reopen notes, summary and findings are as the file says",
		);
		render(caseState(sampleCase("c_j")), noActions);
		expect(el("case-origin").hidden).toBe(true);
	});
});

describe("the AI app", () => {
	const ai = (change: Partial<PanelState["ai"]>) => (s: PanelState) => {
		s.ai = { ...s.ai, ...change };
	};

	test("its connection, and how to stop it, show in the case view too", () => {
		const c = sampleCase("c_ai");
		render(
			caseState(c, ai({ status: "Connected: Claude", active: true })),
			noActions,
		);
		expect(el("home").hidden).toBe(true);
		// What the user sees of it: the pill's label, beside Stop.
		expect(el("ai-label").closest("[hidden], .visually-hidden")).toBeNull();
		expect(el("ai-label").textContent).toBe("AI connecting…");
		// The whole sentence is the pill's name, for a screen reader.
		expect(el("ai-status").textContent).toBe("Connected: Claude");
		expect(el("stop-ai").closest("[hidden]")).toBeNull();
		render(caseState(c, ai({ status: "Not connected" })), noActions);
		expect(el("stop-ai").hidden).toBe(true);
	});

	test("a problem is said in words without hovering: a red dot, its name in the pill, its sentence under the bar on every view (DEC-024)", () => {
		const c = sampleCase("c_problem");
		const seen = () => ({
			label: el("ai-label").textContent,
			dot: el("bar").dataset["ai"],
			line: el("ai-problem").hidden
				? undefined
				: el("ai-problem-text").textContent,
			title: el("ai-button").title,
		});
		const off = { connected: false, apps: 0, active: false };
		for (const [change, want] of [
			[
				// The panel's page in a tab.
				{
					...off,
					problem: "tab",
					status: "Open the side panel from the Overmark icon for AI access",
				},
				{
					label: "AI: side panel only",
					line: "Open the side panel from the Overmark icon for AI access.",
					title: "Open the side panel from the Overmark icon for AI access.",
				},
			],
			[
				// The extension was updated under an open panel.
				{
					...off,
					problem: "updated",
					status: "Overmark was updated: close and open this panel again.",
				},
				{
					label: "AI: reopen panel",
					line: "Overmark was updated: close and open this panel again.",
					title: "Overmark was updated: close and open this panel again.",
				},
			],
			[
				// The worker's connection could not start.
				{
					...off,
					problem: "unavailable",
					status: "AI access is not available: no storage",
				},
				{
					label: "AI unavailable",
					line: "AI access is not available: no storage.",
					title: "AI access is not available: no storage.",
				},
			],
			[
				// A connect that failed, or an address taken over.
				{
					...off,
					problem: "connection",
					status: "Not connected: the address is in use elsewhere.",
				},
				{
					label: "AI problem",
					line: "Not connected: the address is in use elsewhere.",
					title:
						"Not connected: the address is in use elsewhere. Click for the AI app card.",
				},
			],
			[
				// Lost, and trying again by itself: still a problem, and Stop ends it.
				{
					...off,
					active: true,
					problem: "connection",
					status: "Connection lost, retrying…",
				},
				{
					label: "AI retrying…",
					line: "Connection lost, retrying…",
					title: "Connection lost, retrying… Click for the AI app card.",
				},
			],
		] as [Partial<PanelState["ai"]>, Record<string, string>][]) {
			// In a case, at home and in Settings alike.
			for (const state of [
				caseState(c, ai(change)),
				(() => {
					const s = initialState();
					ai(change)(s);
					return s;
				})(),
				caseState(c, (s) => {
					ai(change)(s);
					s.settings = true;
				}),
			]) {
				render(state, noActions);
				expect(seen()).toEqual({ ...want, dot: "problem" } as never);
				// Above the views, under the top bar.
				expect(el("ai-problem").previousElementSibling).toBe(el("bar"));
				expect(el("ai-problem").getAttribute("role")).toBe("status");
			}
		}
		// After an update the pill no longer says what was true before it.
		render(
			caseState(
				c,
				ai({
					status: "Connected: Claude",
					connected: true,
					apps: 1,
					active: true,
				}),
			),
			noActions,
		);
		expect(seen()).toMatchObject({ label: "AI on · 1 app", line: undefined });
		// The problem gone, the line goes.
		render(caseState(c), noActions);
		expect(seen()).toMatchObject({
			label: "AI off",
			dot: "off",
			line: undefined,
		});
	});

	test("its last call shows once there is one", () => {
		const c = sampleCase("c_call");
		render(caseState(c), noActions);
		expect(el("ai-call").hidden).toBe(true);
		const lastCall = { tool: "Screenshot", app: "claude.ai", at: 0 };
		render(caseState(c, ai({ lastCall })), noActions);
		expect(el("ai-call").hidden).toBe(false);
		expect(el("ai-call").textContent).toContain("Screenshot, by claude.ai");
	});

	test("the status at the top says what a click on it does", () => {
		render(caseState(sampleCase("c_b1")), noActions);
		// The status at the top is a button too.
		expect(el("ai-button").contains(el("ai-status"))).toBe(true);
		expect(el("ai-action").textContent).toBe("Turn on");
		render(caseState(sampleCase("c_b1"), ai({ connected: true })), noActions);
		expect(el("ai-action").textContent).toBe("Manage");
	});

	test("the pill: a few words, a dot in the state's colour, and the rest in its name and tooltip (DEC-024)", () => {
		const c = sampleCase("c_pill");
		const pill = () => [
			el("ai-label").textContent,
			el("bar").dataset["ai"],
			el("ai-button").title,
		];
		render(caseState(c), noActions);
		expect(pill()).toEqual([
			"AI off",
			"off",
			"AI access is off. Click to turn it on and set it up.",
		]);
		// The whole status stays in the button, for a screen reader.
		expect(el("ai-status").textContent).toBe("Not connected");
		expect(el("ai-status").classList.contains("visually-hidden")).toBe(true);
		render(
			caseState(
				c,
				ai({
					status: "Waiting for an AI app to pair",
					connected: true,
					active: true,
				}),
			),
			noActions,
		);
		expect(pill()).toEqual([
			"AI on, no app yet",
			"waiting",
			"Waiting for an AI app to pair. Click for the address and code.",
		]);
		const on = (apps: number, status: string) =>
			caseState(c, ai({ status, connected: true, active: true, apps }));
		render(on(1, "Connected: Claude"), noActions);
		expect(pill()).toEqual([
			"AI on · 1 app",
			"connected",
			"Connected: Claude. Click to manage it.",
		]);
		render(on(2, "Connected: Claude, ChatGPT"), noActions);
		expect(pill()).toEqual([
			"AI on · 2 apps",
			"connected",
			"Connected: Claude, ChatGPT. Click to manage them.",
		]);
		render(
			caseState(c, ai({ status: "Connecting…", active: true })),
			noActions,
		);
		expect(pill()).toEqual([
			"AI connecting…",
			"waiting",
			"Connecting… Click for the AI app card.",
		]);
		// Healthy in each of these: nothing is said under the bar.
		expect(el("ai-problem").hidden).toBe(true);
		expect(el("ai-problem-text").textContent).toBe("");
		// Stop is short beside the pill; its name says what it stops.
		expect(el("stop-ai").textContent).toBe("Stop");
		expect(el("stop-ai").getAttribute("aria-label")).toBe("Stop AI access");
	});
});

describe("settings and errors at home", () => {
	test("Allow on all sites shows the permission, not the last click", () => {
		const box = el<HTMLInputElement>("all-sites");
		const state = initialState();
		box.checked = true; // the click, and Chrome said no
		render(state, noActions);
		expect(box.checked).toBe(false);
		state.allSites = true;
		render(state, noActions);
		expect(box.checked).toBe(true);
	});

	test("Keep AI access on shows the setting, also after Stop AI access", () => {
		const box = el<HTMLInputElement>("keep-on");
		const state = initialState();
		state.ai.keepOn = true;
		render(state, noActions);
		expect(box.checked).toBe(true);
		state.ai.keepOn = false;
		render(state, noActions);
		expect(box.checked).toBe(false);
	});

	test("an import error has its own place and can stay", () => {
		const state = initialState();
		state.importError = "Could not import x.zip: broken";
		render(state, noActions);
		expect(el("import-error").hidden).toBe(false);
		expect(el("import-error-text").textContent).toContain("broken");
		expect(el("hint").textContent).not.toContain("broken");
		state.importError = undefined;
		render(state, noActions);
		expect(el("import-error").hidden).toBe(true);
	});
});

describe("the annotate button (DEC-023, DEC-026)", () => {
	const c = sampleCase();
	const overlay = (
		change: Partial<NonNullable<PanelState["overlay"]>> = {},
	): NonNullable<PanelState["overlay"]> => ({
		visible: false,
		url: "https://example.com/",
		title: "",
		drafts: 0,
		saving: false,
		...change,
	});
	const home = (o: PanelState["overlay"], cases: Case[] = [c]) => {
		const state = initialState();
		state.tab = {
			id: 1,
			url: "https://example.com/",
			title: "",
			size: undefined,
		};
		state.overlay = o;
		state.cases = cases;
		render(state, noActions);
		const button = el<HTMLButtonElement>("annotate");
		return {
			label: button.textContent,
			primary: button.classList.contains("primary"),
			disabled: button.disabled,
		};
	};

	test("one state: New case for this page, the one primary, whatever the page shows", () => {
		const target = { caseId: c.id, title: c.title, nextAnnotation: 2 };
		for (const o of [
			undefined,
			overlay(),
			overlay({ drafts: 3 }),
			overlay({ visible: true }),
			overlay({ visible: true, drafts: 2, saving: true }),
			overlay({ target }),
			overlay({ target, visible: true, drafts: 1 }),
		])
			expect(home(o)).toEqual({
				label: "New case for this page",
				primary: true,
				disabled: false,
			});
		expect(home(overlay({ target }), []).label).toBe("New case for this page");
	});

	test("a page that has a case: Home says so and offers to open it; a new case steps back", () => {
		const opened: string[] = [];
		const actions = actionsWith({ openCase: (id) => void opened.push(id) });
		const at = (url: string, cases: Case[]) => {
			const state = initialState();
			state.tab = { id: 1, url, title: "", size: undefined };
			state.cases = cases;
			render(state, actions);
		};
		const own = { ...c, id: "c_own", title: "The form" };
		const second = { ...c, id: "c_second", title: "The footer" };
		const elsewhere: Case = {
			...c,
			id: "c_else",
			title: "Elsewhere",
			page: { ...c.page, url: "https://example.com/other" },
		};
		const rows = (group: string) =>
			[
				...window.document.querySelectorAll(
					`ul.cases[data-group="${group}"] [data-case]`,
				),
			].map((b) => b.getAttribute("data-case"));
		const primary = (id: string) => el(id).classList.contains("primary");

		// No case for the page: as before, the new case is the one primary.
		at("https://example.com/none", [own, elsewhere]);
		expect(el("here").hidden).toBe(true);
		expect(primary("annotate")).toBe(true);
		expect(el("cases-heading").textContent).toBe("Cases");
		expect(rows("other")).toEqual(["c_own", "c_else"]);

		// One: said in words, its row under This page, and Open this case is
		// the one amber button.
		at(c.page.url, [own, elsewhere]);
		expect(el("here").hidden).toBe(false);
		expect(el("here-text").textContent).toBe(
			"This page already has a case. Open it to go on with its marks, or start a new one.",
		);
		expect(rows("here")).toEqual(["c_own"]);
		expect(el("here").contains(el("open-here") as never)).toBe(true);
		expect(el("open-here").hidden).toBe(false);
		expect(primary("open-here")).toBe(true);
		expect(primary("annotate")).toBe(false);
		expect(el("annotate").textContent).toBe("New case for this page");
		// The list below holds the others, and says so.
		expect(el("cases-heading").textContent).toBe("Other cases");
		expect(rows("other")).toEqual(["c_else"]);
		el("open-here").click();
		expect(opened).toEqual(["c_own"]);

		// Several: each row opens its case, no button picks one of them.
		at(c.page.url, [own, second, elsewhere]);
		expect(el("here-text").textContent).toBe(
			"This page already has 2 cases. Open one to go on with its marks, or start a new one.",
		);
		expect(rows("here")).toEqual(["c_own", "c_second"]);
		expect(el("open-here").hidden).toBe(true);
		expect(primary("annotate")).toBe(false);

		// Every case is the page's: the list below says there are no others.
		at(c.page.url, [own]);
		expect(window.document.querySelector("#cases .empty")?.textContent).toBe(
			"No cases for other pages.",
		);
		// Back on a page without one.
		at("https://example.com/none", [own]);
		expect(el("here").hidden).toBe(true);
		expect(el("open-here").hidden).toBe(true);
		expect(primary("annotate")).toBe(true);
	});

	test("no hint lines for drafts: there are no drafts (DEC-026)", () => {
		home(overlay({ visible: true, drafts: 3 }));
		expect(el("annotate-hint")).toBeNull();
		expect(el("hint").hidden).toBe(true);
	});
});

describe("a case deleted elsewhere while its toolbar was adding (DEC-026)", () => {
	test("says only what was lost", async () => {
		const { lostMarksText } = await import("../src/sidepanel/view.ts");
		expect(lostMarksText("Login", 1)).toBe(
			"“Login” was deleted, and 1 mark not in it yet is gone with it.",
		);
		expect(lostMarksText(undefined, 3)).toBe(
			"The case was deleted, and 3 marks not in it yet are gone with it.",
		);
	});
});

describe("the title is renamed where it is shown (DEC-026)", () => {
	const c = sampleCase("c_rename");
	const renaming = (text: string, error?: string) =>
		caseState(c, (s) => {
			s.renaming = {
				caseId: c.id,
				text,
				...(error === undefined ? {} : { error }),
			};
		});
	const shown = (id: string) => !el(id).hidden;

	test("the title with a quiet Rename beside it, which has a name", () => {
		const called: string[] = [];
		render(
			caseState(c),
			actionsWith({ startRename: (x) => void called.push(x.id) }),
		);
		// Made with these actions: the first render of this case.
		expect(el("case-view").querySelector(".case-title")?.textContent).toBe(
			"Button contrast",
		);
		const button = el<HTMLButtonElement>("rename-case");
		expect(button.textContent).toBe("Rename");
		expect(button.getAttribute("aria-label")).toBe("Rename this case");
		expect(button.className).toContain("quiet");
		expect(shown("rename")).toBe(false);
		button.click();
		expect(called).toEqual(["c_rename"]);
	});

	test("renaming: a field with the title and its name, Save and Cancel; the title row goes", () => {
		render(renaming("Button contrast"), noActions);
		expect(shown("rename")).toBe(true);
		expect(
			el("case-view").querySelector<HTMLElement>(".case-title-row")?.hidden,
		).toBe(true);
		const field = el<HTMLInputElement>("rename-field");
		expect(field.value).toBe("Button contrast");
		expect(field.getAttribute("aria-label")).toBe("Case title");
		expect(field.maxLength).toBe(500);
		expect(el<HTMLButtonElement>("rename-save").disabled).toBe(false);
		expect(shown("rename-hint")).toBe(false);
	});

	test("Enter saves what is typed, Escape cancels, as the buttons do", () => {
		const called: string[] = [];
		const actions = actionsWith({
			saveRename: (_c, text) => void called.push(`save ${text}`),
			cancelRename: () => void called.push("cancel"),
			typeRename: (text) => void called.push(`type ${text}`),
		});
		// The case's parts keep the actions they were made with: a case of its own.
		const keys = sampleCase("c_rename_keys");
		render(
			caseState(keys, (s) => {
				s.renaming = { caseId: keys.id, text: "Login" };
			}),
			actions,
		);
		const field = el<HTMLInputElement>("rename-field");
		field.value = "Login button";
		field.dispatchEvent(new window.Event("input") as unknown as Event);
		const key = (k: string) =>
			field.dispatchEvent(
				new window.KeyboardEvent("keydown", {
					key: k,
					cancelable: true,
				}) as unknown as Event,
			);
		// The Enter that ends an IME composition is the composition's.
		field.dispatchEvent(
			new window.KeyboardEvent("keydown", {
				key: "Enter",
				isComposing: true,
				cancelable: true,
			}) as unknown as Event,
		);
		field.dispatchEvent(
			new window.KeyboardEvent("keydown", {
				key: "Enter",
				keyCode: 229,
				cancelable: true,
			}) as unknown as Event,
		);
		key("Enter");
		key("Escape");
		el<HTMLButtonElement>("rename-save").click();
		el<HTMLButtonElement>("rename-cancel").click();
		expect(called).toEqual([
			"type Login button",
			"save Login button",
			"cancel",
			"save Login button",
			"cancel",
		]);
	});

	test("an empty title is refused: Save off, and the field says why", () => {
		render(renaming("   "), noActions);
		expect(el<HTMLButtonElement>("rename-save").disabled).toBe(true);
		expect(el("rename-field").getAttribute("aria-invalid")).toBe("true");
		expect(shown("rename-hint")).toBe(true);
		expect(el("rename-hint").textContent).toBe("A case needs a title.");
	});

	test("a save that failed says why under the field", () => {
		render(
			renaming("Login", "Not renamed: the case no longer exists"),
			noActions,
		);
		expect(el("rename-hint").textContent).toBe(
			"Not renamed: the case no longer exists",
		);
		expect(el("rename-field").getAttribute("aria-invalid")).toBe("false");
	});

	test("done: the stored title shows, Rename has the focus again", async () => {
		render(renaming("Login"), noActions);
		await Promise.resolve();
		expect(window.document.activeElement?.id).toBe("rename-field");
		render(caseState({ ...c, title: "Login" }), noActions);
		await Promise.resolve();
		expect(shown("rename")).toBe(false);
		expect(el("case-view").querySelector(".case-title")?.textContent).toBe(
			"Login",
		);
		expect(window.document.activeElement?.id).toBe("rename-case");
	});

	test("another case's rename is not this one's", () => {
		render(
			caseState(c, (s) => {
				s.renaming = { caseId: "c_other", text: "X" };
			}),
			noActions,
		);
		expect(shown("rename")).toBe(false);
	});
});

describe("a case's link (DEC-028)", () => {
	const TICKET = "https://tickets.example.com/browse/ABC-123?focused=1";
	const shown = (id: string) => !el(id).hidden;
	const open = () => el<HTMLAnchorElement>("case-link-open");
	const edit = () => el<HTMLButtonElement>("case-link-edit");

	test("no link: only a quiet Add a link, under the meta line", () => {
		const c = sampleCase("c_link_none");
		const called: string[] = [];
		render(
			caseState(c),
			actionsWith({ startLink: (x) => void called.push(x.id) }),
		);
		expect(el("case-link").previousElementSibling?.className).toContain(
			"case-meta",
		);
		expect(shown("case-link-open")).toBe(false);
		expect(edit().textContent).toBe("Add a link");
		expect(edit().className).toContain("link");
		expect(shown("case-link-form")).toBe(false);
		edit().click();
		expect(called).toEqual(["c_link_none"]);
	});

	test("a link: an anchor to it in a new tab, its short text, and Edit", () => {
		const c = { ...sampleCase("c_link_one"), link: TICKET };
		render(caseState(c), noActions);
		expect(shown("case-link-open")).toBe(true);
		expect(open().getAttribute("href")).toBe(TICKET);
		expect(open().getAttribute("target")).toBe("_blank");
		expect(open().getAttribute("rel")).toBe("noopener noreferrer");
		expect(open().textContent).toBe("tickets.example.com/browse/ABC-123");
		expect(open().title).toBe(TICKET);
		expect(edit().textContent).toBe("Edit");
		// Removed again: Add a link, no address left in the anchor.
		render(caseState({ ...sampleCase("c_link_one") }), noActions);
		expect(shown("case-link-open")).toBe(false);
		expect(open().hasAttribute("href")).toBe(false);
		expect(edit().textContent).toBe("Add a link");
	});

	test("editing: the field with the stored link; Enter and Save save, Escape and Cancel cancel", () => {
		const c = { ...sampleCase("c_link_keys"), link: TICKET };
		const called: string[] = [];
		render(
			caseState(c, (s) => {
				s.linking = { caseId: c.id, text: TICKET };
			}),
			actionsWith({
				saveLink: (_c, text) => void called.push(`save ${text}`),
				cancelLink: () => void called.push("cancel"),
				typeLink: (text) => void called.push(`type ${text}`),
			}),
		);
		const field = el<HTMLInputElement>("case-link-field");
		expect(shown("case-link-form")).toBe(true);
		expect(shown("case-link-open")).toBe(false);
		expect(shown("case-link-edit")).toBe(false);
		expect(field.value).toBe(TICKET);
		expect(field.type).toBe("url");
		expect(field.getAttribute("aria-label")).toBe("Link of this case");
		expect(field.placeholder).toBe(
			"https://… a ticket, a design, a pull request",
		);
		expect(shown("case-link-hint")).toBe(false);
		field.value = "https://example.com/pr/7";
		field.dispatchEvent(new window.Event("input") as unknown as Event);
		const key = (k: string, more: Record<string, unknown> = {}) =>
			field.dispatchEvent(
				new window.KeyboardEvent("keydown", {
					key: k,
					cancelable: true,
					...more,
				}) as unknown as Event,
			);
		// The Enter that ends an IME composition is the composition's.
		key("Enter", { isComposing: true });
		key("Enter", { keyCode: 229 });
		key("Enter");
		key("Escape");
		el<HTMLButtonElement>("case-link-save").click();
		el<HTMLButtonElement>("case-link-cancel").click();
		expect(called).toEqual([
			"type https://example.com/pr/7",
			"save https://example.com/pr/7",
			"cancel",
			"save https://example.com/pr/7",
			"cancel",
		]);
	});

	test("a text that is no link, or a save that failed, says why under the field", () => {
		const c = sampleCase("c_link_error");
		render(
			caseState(c, (s) => {
				s.linking = {
					caseId: c.id,
					text: "ABC-123",
					error: "A link starts with https:// or http://",
				};
			}),
			noActions,
		);
		expect(shown("case-link-hint")).toBe(true);
		expect(el("case-link-hint").textContent).toBe(
			"A link starts with https:// or http://",
		);
		expect(el("case-link-field").getAttribute("aria-invalid")).toBe("true");
	});

	test("done: the link shows, Edit has the focus again", async () => {
		const c = sampleCase("c_link_done");
		render(
			caseState(c, (s) => {
				s.linking = { caseId: c.id, text: "" };
			}),
			noActions,
		);
		await Promise.resolve();
		expect(window.document.activeElement?.id).toBe("case-link-field");
		render(caseState({ ...c, link: TICKET }), noActions);
		await Promise.resolve();
		expect(shown("case-link-form")).toBe(false);
		expect(open().getAttribute("href")).toBe(TICKET);
		expect(window.document.activeElement?.id).toBe("case-link-edit");
	});

	test("another case's link form is not this one's", () => {
		const c = sampleCase("c_link_other");
		render(
			caseState(c, (s) => {
				s.linking = { caseId: "c_other", text: TICKET };
			}),
			noActions,
		);
		expect(shown("case-link-form")).toBe(false);
		expect(shown("case-link-edit")).toBe(true);
	});
});

describe("the top bar and Settings (DEC-023)", () => {
	test("Home: no back button; a case: All cases with a chevron, which closes it", () => {
		const called: string[] = [];
		const actions = actionsWith({
			closeCase: () => void called.push("close"),
		});
		render(initialState(), actions);
		expect(el("back").hidden).toBe(true);
		render(caseState(sampleCase("c_top")), actions);
		expect(el("back").hidden).toBe(false);
		expect(el("back").textContent).toBe("All cases");
		expect(el("back").querySelector("svg[aria-hidden=true]")).not.toBeNull();
		expect(el("back").getAttribute("aria-label")).toBe(
			"All cases: close this case",
		);
		// In the top bar, before the AI pill.
		expect(el("back").parentElement).toBe(el("bar"));
		expect(el("back").nextElementSibling).toBe(el("ai-button"));
		el("back").click();
		expect(called).toEqual(["close"]);
	});

	test("a double click on the back button is one click: it changed its meaning under the pointer", () => {
		const called: string[] = [];
		const actions = actionsWith({
			closeSettings: () => void called.push("settings"),
			closeCase: () => void called.push("case"),
		});
		const c = sampleCase("c_double");
		try {
			setSystemTime(new Date("2020-01-01T10:00:00Z"));
			render(
				caseState(c, (s) => (s.settings = true)),
				actions,
			);
			setSystemTime(new Date("2020-01-01T10:00:05Z"));
			el("back").click();
			// Settings closes: the same button is "← All cases" now.
			render(caseState(c), actions);
			setSystemTime(new Date("2020-01-01T10:00:05.200Z"));
			el("back").click();
			expect(called).toEqual(["settings"]);
			setSystemTime(new Date("2020-01-01T10:00:06Z"));
			el("back").click();
			expect(called).toEqual(["settings", "case"]);
			// Blocked a moment after the first click: the second is no decision.
			render(
				caseState(c, (s) => (s.leaving = { phase: "blocked", left: 1 })),
				actions,
			);
			setSystemTime(new Date("2020-01-01T10:00:06.100Z"));
			el("back").click();
			expect(called).toEqual(["settings", "case"]);
		} finally {
			setSystemTime();
		}
	});

	test("while the toolbar finishes, the back button waits and the case says so", () => {
		const c = sampleCase("c_leave");
		render(
			caseState(c, (s) => (s.leaving = { phase: "finishing" })),
			noActions,
		);
		expect(el<HTMLButtonElement>("back").disabled).toBe(true);
		expect(el("leave-hint").textContent).toBe("Finishing the marks…");
		render(
			caseState(c, (s) => (s.leaving = { phase: "blocked", left: 1 })),
			noActions,
		);
		expect(el<HTMLButtonElement>("back").disabled).toBe(false);
		expect(el("leave-hint").textContent).toBe(
			"1 mark is not in the case yet; the toolbar on the page says why. Click All cases again to leave without it.",
		);
		render(caseState(c), noActions);
		expect(el("leave-hint").hidden).toBe(true);
	});

	test("Settings holds the AI app card and the options, over Home or a case", () => {
		const called: string[] = [];
		const actions = actionsWith({
			closeSettings: () => void called.push("back"),
			closeCase: () => void called.push("close"),
		});
		expect(el("ai-card").closest("main")).toBe(el("settings"));
		expect(el("all-sites").closest("main")).toBe(el("settings"));
		expect(el("blur-forms").closest("main")).toBe(el("settings"));
		const c = sampleCase("c_set");
		render(
			caseState(c, (s) => (s.settings = true)),
			actions,
		);
		expect(el("settings").hidden).toBe(false);
		expect(el("case-view").hidden).toBe(true);
		expect(el("home").hidden).toBe(true);
		expect(el("back").textContent).toBe("Back");
		el("back").click();
		expect(called).toEqual(["back"]);
		// The case stays open underneath: its view is there when Back returns.
		expect(el("case-view").querySelector("h2")?.textContent).toBe(c.title);
		render(caseState(c), actions);
		expect(el("settings").hidden).toBe(true);
		expect(el("case-view").hidden).toBe(false);
		const home = initialState();
		home.settings = true;
		render(home, actions);
		expect(el("home").hidden).toBe(true);
		expect(el("back").textContent).toBe("Back");
		home.settings = false;
		render(home, actions);
		expect(el("settings").hidden).toBe(true);
		expect(el("home").hidden).toBe(false);
	});
});

describe("the case view's actions and this tab (DEC-023)", () => {
	const tab = {
		id: 7,
		url: "http://127.0.0.1/v2",
		title: "",
		size: undefined,
	};
	const overlay = (
		change: Partial<NonNullable<PanelState["overlay"]>> = {},
	): NonNullable<PanelState["overlay"]> => ({
		visible: false,
		url: tab.url,
		title: "",
		drafts: 0,
		saving: false,
		...change,
	});
	const line = () =>
		el("tab-line").hidden ? undefined : el("tab-line").textContent;

	test("Add marks is the primary, Export beside it, Delete alone at the bottom", () => {
		const c = sampleCase("c_row");
		render(
			caseState(c, (s) => (s.tab = tab)),
			noActions,
		);
		const row = el("add-marks").parentElement as unknown as HTMLElement;
		expect([...row.querySelectorAll("button")].map((b) => b.id)).toEqual([
			"add-marks",
			"export-case",
		]);
		expect(el("add-marks").classList.contains("primary")).toBe(true);
		expect(el("add-marks").textContent).toBe("Add marks");
		// The last thing in the case view.
		expect(el("case-view").lastElementChild?.contains(el("delete-case"))).toBe(
			true,
		);
		expect(window.document.querySelectorAll("#case-view .primary").length).toBe(
			1,
		);
	});

	test("adding: Done adding, and the line says where the marks go", () => {
		const c = sampleCase("c_adding");
		const called: string[] = [];
		const actions = actionsWith({
			addMarks: () => void called.push("add"),
			doneAdding: () => void called.push("done"),
		});
		render(
			caseState(c, (s) => (s.tab = tab)),
			actions,
		);
		el("add-marks").click();
		const target = { caseId: c.id, title: c.title, nextAnnotation: 2 };
		render(
			caseState(c, (s) => {
				s.tab = tab;
				s.overlay = overlay({ visible: true, target });
			}),
			actions,
		);
		expect(el("add-marks").textContent).toBe("Done adding");
		expect(el("add-marks").classList.contains("primary")).toBe(false);
		expect(line()).toBe(
			"Adding marks: draw on the page. Each mark is saved into this case when its comment is done.",
		);
		el("add-marks").click();
		expect(called).toEqual(["add", "done"]);
		// A toolbar for another case is not this case's.
		render(
			caseState(c, (s) => {
				s.tab = tab;
				s.overlay = overlay({
					visible: true,
					target: { ...target, caseId: "c_other" },
				});
			}),
			actions,
		);
		expect(el("add-marks").textContent).toBe("Add marks");
	});

	test("marks of no case on the page are no case's: nothing said (DEC-026)", () => {
		const c = sampleCase("c_drafts");
		render(
			caseState(c, (s) => {
				s.tab = tab;
				s.overlay = overlay({ drafts: 3 });
			}),
			noActions,
		);
		expect(line()).toBeUndefined();
	});

	test("drawing, hidden, found: each says so, Hide or Show where it applies", () => {
		// With a mark: a case without one has nothing to show or hide.
		const c: Case = {
			...sampleCase("c_tabline"),
			annotations: [
				{
					id: "a1",
					number: 1,
					shot: "s1",
					comment: "Here",
					author: "user",
					shape: { kind: "note", at: { x: 1, y: 1 } },
					crop: "crops/a1.webp",
					element: null,
				},
			],
		};
		render(
			caseState(c, (s) => {
				s.tab = tab;
				s.drawing = tab.id;
			}),
			noActions,
		);
		expect(line()).toBe("Looking for the marks on this tab…");
		expect(el("load-case").hidden).toBe(true);
		render(
			caseState(c, (s) => {
				s.tab = tab;
				s.hiddenOn = new Set([tab.id]);
			}),
			noActions,
		);
		expect(line()).toBe("Marks are hidden on this tab.");
		expect(el("load-case").hidden).toBe(false);
		expect(el("load-case").textContent).toBe("Show marks");
		// A case without marks has nothing to show or hide: no button, also
		// while the toolbar adds to it.
		const empty = { ...c, id: "c_empty", annotations: [] };
		render(
			caseState(empty, (s) => {
				s.tab = tab;
			}),
			noActions,
		);
		expect(el("load-case").hidden).toBe(true);
		render(
			caseState(c, (s) => {
				s.tab = tab;
				s.loaded = { caseId: c.id, tabId: tab.id, matches: new Map() };
				s.caseHint = "3 of 4 marks found on 127.0.0.1/v2.";
			}),
			noActions,
		);
		expect(line()).toBeUndefined();
		expect(el("case-hint").textContent).toBe(
			"3 of 4 marks found on 127.0.0.1/v2.",
		);
		expect(el("case-hint").parentElement).toBe(el("this-tab"));
		expect(el("load-case").textContent).toBe("Hide marks");
	});

	test("the meta line: address · size · date, no chips", () => {
		const c = sampleCase("c_meta");
		render(caseState(c), noActions);
		const meta = el("open-page").parentElement as unknown as HTMLElement;
		expect(meta.classList.contains("chips")).toBe(false);
		expect(meta.classList.contains("case-meta")).toBe(true);
		expect(meta.textContent).toContain(
			`${c.page.viewport.width}×${c.page.viewport.height}`,
		);
	});
});

describe("a loaded mark", () => {
	const element = {
		tag: "button",
		classes: [],
		attributes: {},
		ancestors: [],
		rect: { x: 0, y: 0, width: 100, height: 20 },
		page: { width: 1280, height: 800 },
		selector: "button",
		text: "Berechnen",
	};
	const mark = {
		id: "a1",
		number: 1,
		shot: "s1",
		comment: "Too pale",
		author: "user",
		shape: { kind: "element", rect: element.rect },
		crop: "crops/a1.webp",
		element,
	} as Annotation;
	const shownAs = (summary: string, visible = true, current = 0) =>
		caseState({ ...sampleCase("c_m"), annotations: [mark] }, (s) => {
			s.loaded = {
				caseId: "c_m",
				tabId: 1,
				matches: new Map([
					[
						"a1",
						{
							annotationId: "a1",
							number: 1,
							status: "found",
							score: 1,
							current,
							candidates: [
								{ score: 1, summary, selector: "b", visible, found: true },
								{ score: 0.6, summary, selector: "c", visible, found: false },
							],
						},
					],
				]),
			};
		});
	const said = () =>
		document.querySelector(".match .meta")?.textContent ?? undefined;

	test("a sure match offers no other candidate, unless one is shown", () => {
		const next = () => document.querySelector("[data-action=next]");
		render(shownAs("button"), noActions);
		expect(next()).toBeNull();
		// Stepped to the second: the way back stays.
		render(shownAs("button", true, 1), noActions);
		expect(next()).not.toBeNull();
	});

	const colour = () =>
		document.querySelector<HTMLElement>(".annotation")?.dataset["colour"];

	test("its number has the colour of its mark on the page", () => {
		render(shownAs(summarize(element)), noActions);
		expect(colour()).toBe("found");
	});

	test("another candidate, not sure enough, is unsure on both", () => {
		render(shownAs(summarize(element), true, 1), noActions);
		expect(colour()).toBe("unsure");
		expect(document.querySelector(".match")?.className).toContain("unsure");
	});

	test("says nothing more about the element it expected", () => {
		render(shownAs(summarize(element)), noActions);
		expect(said()).toBeUndefined();
	});

	test("the pin: its colour is the status, its fill the match (DEC-024)", async () => {
		const at = "2026-11-14T09:00:00Z";
		const marks: Annotation[] = [
			{ ...mark, id: "a1", number: 1 },
			{ ...mark, id: "a2", number: 2, resolution: { kind: "fixed", at } },
			{
				...mark,
				id: "a3",
				number: 3,
				resolution: { kind: "fixed", at, verified: { at } },
			},
			{ ...mark, id: "a4", number: 4, resolution: { kind: "wontfix", at } },
		];
		const candidate = (found: boolean) => ({
			score: found ? 1 : 0.6,
			summary: "button",
			selector: "b",
			visible: true,
			found,
		});
		const match = (
			n: number,
			status: AnnotationMatch["status"],
			candidates: ReturnType<typeof candidate>[],
		): [string, AnnotationMatch] => [
			`a${n}`,
			{
				annotationId: `a${n}`,
				number: n,
				status,
				score: candidates[0]?.score ?? 0,
				current: 0,
				candidates,
			},
		];
		render(
			caseState({ ...sampleCase("c_pin"), annotations: marks }, (s) => {
				s.loaded = {
					caseId: "c_pin",
					tabId: 1,
					matches: new Map([
						match(1, "found", [candidate(true)]),
						match(2, "probable", [candidate(false)]),
						match(3, "lost", []),
						// The fourth mark was not looked for: no match at all.
					]),
				};
			}),
			noActions,
		);
		const pins = [...document.querySelectorAll<HTMLElement>(".annotation")].map(
			(li) => [
				li.querySelector(".number")?.textContent,
				li.dataset["status"],
				li.dataset["colour"],
			],
		);
		expect(pins).toEqual([
			["1", "open", "found"],
			["2", "fixed", "unsure"],
			["3", "verified", "lost"],
			["4", "wontfix", undefined],
		]);
		// The style sheet turns the two into the pin's look.
		const css = await Bun.file(
			new URL("../src/sidepanel/style.css", import.meta.url),
		).text();
		const rule = (selector: string) => {
			const from = css.indexOf(`${selector} {`);
			expect(from).toBeGreaterThanOrEqual(0);
			return css.slice(from, css.indexOf("}", from)).replace(/\s+/g, " ");
		};
		for (const [selector, tone] of [
			['[data-status="open"],\n[data-group="open"]', "--st-open"],
			['[data-status="fixed"],\n[data-group="toVerify"]', "--st-verify"],
			['[data-status="verified"],\n[data-group="verified"]', "--st-verified"],
			[
				'[data-status="wontfix"],\n[data-status="cantreproduce"],\n[data-group="closed"]',
				"--st-closed",
			],
		] as const)
			expect(rule(selector)).toContain(`--tone: var(${tone});`);
		// Found, or not looked for: filled, with a ring of paper on the rail.
		expect(rule(".number")).toContain(
			"background: var(--tone, var(--st-open));",
		);
		expect(rule(".number")).toContain("box-shadow: 0 0 0 2px var(--paper);");
		// Unsure: a dashed ring outside it. Not found: hollow.
		expect(rule('.annotation[data-colour="unsure"] .number')).toContain(
			"outline: 1.5px dashed var(--tone, var(--st-open));",
		);
		const hollow = rule('.annotation[data-colour="lost"] .number');
		expect(hollow).toContain("background: var(--paper);");
		expect(hollow).toContain("inset 0 0 0 2px var(--tone, var(--st-open))");
		expect(hollow).toContain("color: var(--tone, var(--st-open));");
	});

	test("names another element, and says when one is hidden", () => {
		render(shownAs("a link"), noActions);
		expect(said()).toBe("a link");
		render(shownAs("a span", false), noActions);
		expect(said()).toBe("a span, hidden at this width");
		render(shownAs(summarize(element), false), noActions);
		expect(said()).toBe("Hidden at this width");
	});
});

describe("where an export went (DEC-020)", () => {
	const saved = (where: string) =>
		window.document.querySelector(`#${where}`) as unknown as HTMLElement;

	test("Export all cases waits for a case, and is off while at work", () => {
		const state = initialState();
		render(state, noActions);
		expect(el<HTMLButtonElement>("export-all").disabled).toBe(true);
		state.cases = [sampleCase("c_x1")];
		render(state, noActions);
		expect(el<HTMLButtonElement>("export-all").disabled).toBe(false);
		state.exportingAll = true;
		render(state, noActions);
		expect(el<HTMLButtonElement>("export-all").disabled).toBe(true);
	});

	test("the path of all cases' file at home, with Copy and Show in folder", async () => {
		const state = initialState();
		state.cases = [sampleCase("c_x1")];
		state.exported = { of: "all", downloadId: 7, path: "/Users/a/x.zip" };
		const copied: string[] = [];
		const shown: number[] = [];
		render(
			state,
			actionsWith({
				copyPath: async (path) => {
					copied.push(path);
					return true;
				},
				showFile: (e) => shown.push(e.downloadId),
			}),
		);
		const box = saved("export-all-saved");
		expect(box.hidden).toBe(false);
		expect(box.querySelector("code")?.textContent).toBe("/Users/a/x.zip");
		const copy = box.querySelector(
			'[data-action="copy-path"]',
		) as unknown as HTMLButtonElement;
		copy.click();
		await Bun.sleep(0);
		expect(copied).toEqual(["/Users/a/x.zip"]);
		expect(copy.textContent).toBe("Copied");
		render(state, noActions);
		// Drawn again only when it shows another file: "Copied" stays.
		expect(copy.isConnected).toBe(true);
		(
			box.querySelector('[data-action="show-file"]') as unknown as HTMLElement
		).click();
		expect(shown).toEqual([7]);
		state.exported = undefined;
		render(state, noActions);
		expect(box.hidden).toBe(true);
	});

	test("a case's file shows in that case only", () => {
		const c = sampleCase("c_x2");
		render(
			caseState(c, (s) => {
				s.exported = { of: { caseId: c.id }, downloadId: 1, path: "/p.zip" };
			}),
			noActions,
		);
		expect(saved("export-saved").hidden).toBe(false);
		expect(saved("export-saved").textContent).toContain("/p.zip");
		render(
			caseState(sampleCase("c_x3"), (s) => {
				s.exported = { of: { caseId: c.id }, downloadId: 1, path: "/p.zip" };
			}),
			noActions,
		);
		expect(saved("export-saved").hidden).toBe(true);
	});

	test("while Chrome asks, it says what the answer does", () => {
		const c = sampleCase("c_x4");
		render(
			caseState(c, (s) => {
				s.askingDownloads = { caseId: c.id };
			}),
			noActions,
		);
		expect(saved("export-saved").textContent).toBe(ASKING_DOWNLOADS);
	});

	test("a file of several cases says which case it asks about, and offers Skip", () => {
		const state = initialState();
		state.importing = {
			parsed: { case: sampleCase("c_in"), images: async () => new Map() },
			existing: sampleCase("c_in"),
			batch: { name: "all.zip", rest: [], total: 3, stored: 1, skipped: 1 },
		};
		render(state, noActions);
		expect(el("import-prompt").textContent).toContain(
			"Case 3 of 3 in all.zip.",
		);
		expect(
			window.document.querySelector('[data-action="import-cancel"]')
				?.textContent,
		).toBe("Skip");
		state.importing = undefined;
		render(state, noActions);
	});
});

describe("one import at a time", () => {
	const button = (id: string) => el<HTMLButtonElement>(id);

	test("Import a case… and Export all cases are off while an import is at work, and say why", () => {
		const state = initialState();
		state.cases = [sampleCase("c_y1")];
		render(state, noActions);
		const importTitle = button("import").title;
		const exportTitle = button("export-all").title;
		expect(button("import").disabled).toBe(false);
		expect(button("export-all").disabled).toBe(false);

		state.importWork = "all.zip";
		render(state, noActions);
		expect(button("import").disabled).toBe(true);
		expect(button("export-all").disabled).toBe(true);
		expect(button("import").title).toBe(IMPORT_BUSY);
		expect(button("export-all").title).toBe(EXPORT_ALL_BUSY);
		expect(el("import-done").hidden).toBe(false);
		expect(el("import-done").textContent).toBe("Importing all.zip…");

		// Its question open: the question shows instead.
		state.importWork = undefined;
		state.importing = {
			parsed: { case: sampleCase("c_y1"), images: async () => new Map() },
			existing: sampleCase("c_y1"),
			batch: { name: "all.zip", rest: [], total: 2, stored: 0, skipped: 0 },
		};
		render(state, noActions);
		expect(button("import").disabled).toBe(true);
		expect(button("export-all").disabled).toBe(true);
		expect(el("import-done").hidden).toBe(true);
		expect(el("import-prompt").hidden).toBe(false);

		state.importing = undefined;
		state.importDone = "Imported all 2 cases of all.zip.";
		render(state, noActions);
		expect(button("import").disabled).toBe(false);
		expect(button("export-all").disabled).toBe(false);
		expect(button("import").title).toBe(importTitle);
		expect(button("export-all").title).toBe(exportTitle);
		expect(el("import-done").textContent).toBe(
			"Imported all 2 cases of all.zip.",
		);
	});
});

describe("the sync (DEC-021, DEC-025)", () => {
	const draw = (
		change: (s: PanelState["sync"]) => void,
		actions = noActions,
		view?: Case,
	) => {
		const state = view === undefined ? initialState() : caseState(view);
		change(state.sync);
		render(state, actions);
		return el<HTMLDivElement>("sync");
	};
	const sync = draw;
	const buttons = (box: HTMLElement) =>
		[...box.querySelectorAll("button")].map((b) => [
			b.textContent,
			b.title !== "",
		]);
	const labels = (box: HTMLElement) => buttons(box).map(([label]) => label);
	const synced = (s: PanelState["sync"]) => {
		s.target = "downloads";
		s.targetId = "downloads";
		s.status = {
			folderId: "downloads",
			state: "synced",
			lastSyncedAt: "2026-11-12T09:30:00Z",
		};
	};
	const pausedFolder = (s: PanelState["sync"]) => {
		s.target = "folder";
		s.targetId = "f";
		s.folder = "iCloud cases";
		s.status = { folderId: "f", state: "paused", reason: "access" };
	};
	const banner = () => el<HTMLDivElement>("sync-banner");

	test("off: what it does, Sync to Downloads first, Choose a folder…, and the note", () => {
		const box = sync(() => {});
		expect(box.querySelector(".sync-state")?.textContent).toBe("Sync is off.");
		expect(buttons(box)).toEqual([
			["Sync to Downloads", true],
			["Choose a folder…", true],
		]);
		// Ink, not amber: amber is Home's New case for this page alone (DEC-024).
		expect(box.querySelector('[data-action="sync-downloads"]')?.className).toBe(
			"strong",
		);
		expect(box.querySelector(".sync-note")?.textContent).toContain(
			"works with this panel closed",
		);
		expect(
			(box.querySelector('[data-action="sync-choose"]') as HTMLElement).title,
		).toContain("A deleted case keeps its file");
	});

	test("asking for downloads: what Chrome asks, no buttons", () => {
		const box = sync((s) => {
			s.asking = true;
		});
		expect(box.textContent).toContain(
			"Chrome asks whether Overmark may manage your downloads.",
		);
		expect(labels(box)).toEqual([]);
	});

	test("synced to Downloads: where, when, Show in folder · Change… · Stop syncing", () => {
		let shown = 0;
		const box = sync(synced, actionsWith({ syncShow: () => shown++ }));
		expect(box.querySelector(".sync-state")?.textContent).toBe(
			"Syncing to Downloads/Overmark",
		);
		expect(box.querySelector(".sync-line")?.textContent).toStartWith(
			"Last synced ",
		);
		expect(buttons(box)).toEqual([
			["Show in folder", true],
			["Change…", true],
			["Stop syncing", true],
		]);
		(box.querySelector('[data-action="sync-show"]') as HTMLElement).click();
		expect(shown).toBe(1);
		expect(banner().hidden).toBe(true);
	});

	test("syncing to a folder: its name, how many cases are left", () => {
		const box = sync((s) => {
			s.target = "folder";
			s.targetId = "f";
			s.folder = "Overmark";
			s.status = { folderId: "f", state: "syncing", left: 3 };
		});
		expect(box.querySelector(".sync-state")?.textContent).toBe(
			"Syncing to “Overmark”",
		);
		expect(box.querySelector(".sync-line")?.textContent).toBe(
			"Writing 3 cases…",
		);
		expect(labels(box)).toEqual(["Change…", "Stop syncing"]);
	});

	test("Change…: the Off state's buttons with Cancel, the target still shown", () => {
		const box = sync((s) => {
			synced(s);
			s.changing = true;
		});
		expect(box.querySelector(".sync-state")?.textContent).toBe(
			"Syncing to Downloads/Overmark",
		);
		expect(labels(box)).toEqual([
			"Sync to Downloads",
			"Choose a folder…",
			"Cancel",
		]);
	});

	test("paused, the folder: the section says so, with the banner's buttons", () => {
		let allowed = 0;
		let downloads = 0;
		const box = sync(
			pausedFolder,
			actionsWith({
				syncAllow: () => allowed++,
				syncDownloads: () => downloads++,
			}),
		);
		expect(box.querySelector(".sync-state")?.textContent).toBe(
			"Paused: Chrome wants your OK for “iCloud cases” again.",
		);
		expect(labels(box)).toEqual([
			"Allow access",
			"Use Downloads instead",
			"Change…",
			"Stop syncing",
		]);
		(box.querySelector('[data-action="sync-allow"]') as HTMLElement).click();
		(
			box.querySelector('[data-action="sync-use-downloads"]') as HTMLElement
		).click();
		expect([allowed, downloads]).toEqual([1, 1]);
	});

	test("paused: the banner, on Home and in a case, that cannot be dismissed", () => {
		let allowed = 0;
		for (const view of [undefined, sampleCase("c_1")]) {
			draw(pausedFolder, actionsWith({ syncAllow: () => allowed++ }), view);
			const b = banner();
			expect(b.hidden).toBe(false);
			expect(b.getAttribute("role")).toBe("status");
			expect(b.dataset["sync"]).toBe("paused");
			expect(b.querySelector("p")?.textContent).toBe(
				"Sync is paused. Chrome needs your OK to write to “iCloud cases” again.",
			);
			expect(b.querySelector("strong")?.textContent).toBe("Sync is paused.");
			expect(labels(b)).toEqual(["Allow access", "Use Downloads instead"]);
			(b.querySelector('[data-action="sync-allow"]') as HTMLElement).click();
		}
		expect(allowed).toBe(2);
		expect(el("case-view").hidden).toBe(false);
	});

	test("a no to Allow access: said under the banner's text", () => {
		draw((s) => {
			pausedFolder(s);
			s.refused = true;
		});
		expect(banner().textContent).toContain(
			"Chrome did not allow it. Click Allow access to ask again, or use Downloads instead.",
		);
	});

	test("what a banner button could not do is said in the banner, in a case too", () => {
		const box = draw(
			(s) => {
				pausedFolder(s);
				s.problem = "Chrome did not allow Overmark to save to your downloads.";
			},
			noActions,
			sampleCase("c_1"),
		);
		expect(banner().querySelector("[role=alert]")?.textContent).toBe(
			"Chrome did not allow Overmark to save to your downloads.",
		);
		// Once is enough: not again in the section.
		expect(box.querySelector("[role=alert]")).toBeNull();
	});

	test("paused, the downloads permission gone: Allow downloads", () => {
		let asked = 0;
		const box = draw(
			(s) => {
				s.target = "downloads";
				s.targetId = "downloads";
				s.status = {
					folderId: "downloads",
					state: "paused",
					reason: "downloads",
				};
			},
			actionsWith({ syncAllowDownloads: () => asked++ }),
		);
		expect(box.querySelector(".sync-state")?.textContent).toBe(
			"Paused: Overmark may no longer save to your downloads.",
		);
		expect(banner().querySelector("p")?.textContent).toBe(
			"Sync is paused. Overmark may no longer save to your downloads.",
		);
		expect(labels(banner())).toEqual(["Allow downloads"]);
		(
			banner().querySelector(
				'[data-action="sync-allow-downloads"]',
			) as HTMLElement
		).click();
		expect(asked).toBe(1);
	});

	test("failed: the problem and Try again, in the section and the banner", () => {
		const box = sync((s) => {
			s.target = "folder";
			s.targetId = "f";
			s.folder = "Overmark";
			s.status = {
				folderId: "f",
				state: "failed",
				problem: "The folder “Overmark” is no longer there.",
			};
		});
		expect(box.querySelector("[role=alert]")?.textContent).toBe(
			"The folder “Overmark” is no longer there.",
		);
		expect(labels(box)).toContain("Try again");
		expect(banner().dataset["sync"]).toBe("failed");
		expect(banner().querySelector("p")?.textContent).toBe(
			"Sync failed. The folder “Overmark” is no longer there.",
		);
		expect(labels(banner())).toEqual(["Try again"]);
	});

	test("the banner goes with the state", () => {
		draw(pausedFolder);
		expect(banner().hidden).toBe(false);
		draw(synced);
		expect(banner().hidden).toBe(true);
		expect(banner().childElementCount).toBe(0);
	});

	test("drawn again only when it shows something else", () => {
		const first = sync(synced).querySelector("button");
		const again = sync(synced).querySelector("button");
		expect(again).toBe(first);
		draw(pausedFolder);
		const bannerButton = banner().querySelector("button");
		draw(pausedFolder);
		expect(banner().querySelector("button")).toBe(bannerButton);
	});
});

test("every mask in the panel's style sheet has its -webkit- form beside it: Chrome 116 to 119 know no other", async () => {
	const css = await Bun.file(
		new URL("../src/sidepanel/style.css", import.meta.url),
	).text();
	const masks = [
		...css.matchAll(/^\s*(-webkit-)?mask(-[a-z]+)?:\s*([^;]+);/gm),
	];
	expect(masks.length).toBeGreaterThan(0);
	const plain = masks.filter((m) => m[1] === undefined);
	const prefixed = masks.filter((m) => m[1] !== undefined);
	expect(plain.map((m) => [m[2], m[3]])).toEqual(
		prefixed.map((m) => [m[2], m[3]]),
	);
	// The prefixed one first: where both are known, the standard one wins.
	for (const m of plain)
		expect(
			css
				.slice(0, m.index)
				.trimEnd()
				.endsWith(`-webkit-mask${m[2] ?? ""}: ${m[3]};`),
		).toBe(true);
});
