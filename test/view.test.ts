import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
	FOUND_COLOUR,
	PROBABLE_COLOUR,
	RESOLVED_COLOUR,
} from "../src/content/overlay.ts";
import type { Annotation, Case } from "../src/lib/case.ts";
import { summarize } from "../src/lib/element.ts";
import { MARK_COLOUR } from "../src/lib/marks.ts";
import type { AnnotationMatch } from "../src/lib/messages.ts";
import { initialState, type PanelState } from "../src/sidepanel/state.ts";
import type { Actions } from "../src/sidepanel/view.ts";
import { sampleCase } from "./fixtures.ts";

const window = new Window({ url: "chrome-extension://x/sidepanel/index.html" });
const globals = globalThis as unknown as Record<string, unknown>;
const before = { document: globals["document"] };
let render: (state: PanelState, actions: Actions) => void;

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
	({ render } = await import("../src/sidepanel/view.ts"));
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
	const home = (tab: PanelState["tab"]) => {
		const state = initialState();
		state.tab = tab;
		render(state, noActions);
	};
	const text = (id: string) => el(id).textContent;

	test("without an address: its title, or at least some words", () => {
		home({ id: 1, url: "", title: "", size: undefined });
		expect(text("page")).toBe("This page");
		home({ id: 1, url: "", title: "Kasse", size: undefined });
		expect(text("page")).toBe("Kasse");
	});

	test("without an address: says that a click on the icon is needed", () => {
		home({ id: 1, url: "", title: "", size: undefined });
		expect(el("hint").hidden).toBe(false);
		expect(text("hint")).toContain("Click the Overmark icon");
	});

	test("with an address: no such hint", () => {
		home({
			id: 1,
			url: "https://www.example.com/kk",
			title: "KK",
			size: undefined,
		});
		expect(text("page")).toBe("www.example.com/kk");
		expect(el("hint").hidden).toBe(true);
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
	test("a case of the page in front has no Load: opening it loads it", () => {
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
		const load = (id: string) =>
			window.document.querySelector(`[data-load="${id}"]`);
		expect(load("c_here")).toBeNull();
		expect(load("c_there")).not.toBeNull();
		(
			window.document.querySelector(
				'[data-case="c_here"]',
			) as unknown as HTMLElement
		).click();
		expect(opened).toEqual(["c_here"]);
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

	test("a resolved mark says how, with its note, and the counts sum up", () => {
		render(caseState(twoMarks()), noActions);
		expect(row("a2").dataset["resolved"]).toBe("wontfix");
		expect(row("a2").querySelector(".resolution")?.textContent).toBe(
			"Won't fixLegal wants it",
		);
		expect(row("a1").querySelector(".resolution")).toBeNull();
		expect(window.document.querySelector(".mark-counts")?.textContent).toBe(
			"1 open, 1 won't fix",
		);
		expect(action("a1", "resolve").textContent).toBe("Resolve…");
		expect(action("a2", "reopen").textContent).toBe("Reopen");
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
			row(id).querySelector(".mark-toggle .state")?.textContent;
		expect(state("a1")).toBe("Not found");
		expect(state("a2")).toBe("Won't fix");
		expect(window.document.getElementById("marks-heading")?.textContent).toBe(
			"Marks 2",
		);
		// The bar: one open, one won't fix, each its share.
		const bar = [
			...window.document.querySelectorAll(".marks-bar .progress > span"),
		].map((s) => [s.getAttribute("data-kind"), s.getAttribute("style")]);
		expect(bar).toEqual([
			["open", "flex-grow: 1"],
			["wontfix", "flex-grow: 1"],
		]);
	});

	test("the panel's resolved colour is the page's", async () => {
		const css = await Bun.file(
			new URL("../src/sidepanel/style.css", import.meta.url),
		).text();
		expect(css).toContain(`--resolved: ${RESOLVED_COLOUR};`);
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
		expect(el("load-case").textContent).toBe("Show marks on this tab");
		expect(el("load-case").classList.contains("primary")).toBe(true);
		el("load-case").click();
		const loadedOn = (front: number) =>
			caseState(c, (s) => {
				s.tab = { id: front, url: "", title: "", size: undefined };
				s.loaded = { caseId: c.id, tabId: 1, matches: new Map() };
			});
		render(loadedOn(1), actions);
		expect(el("load-case").textContent).toBe("Hide marks on this tab");
		expect(el("load-case").classList.contains("primary")).toBe(false);
		el("load-case").click();
		// Its marks are on another tab: this one can show them.
		render(loadedOn(2), actions);
		expect(el("load-case").textContent).toBe("Show marks on this tab");
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
		expect(el("load-case").textContent).toBe("Hide marks on this tab");
		expect(called).toEqual(["load", "hide"]);
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
			parsed: { case: sampleCase("c_in"), images: new Map() },
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

describe("the verdict", () => {
	const value = () => el<HTMLTextAreaElement>("verdict").value;

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
		expect(el("ai-status").closest("[hidden]")).toBeNull();
		expect(el("ai-status").textContent).toBe("Connected: Claude");
		expect(el("stop-ai").closest("[hidden]")).toBeNull();
		render(caseState(c, ai({ status: "Not connected" })), noActions);
		expect(el("stop-ai").hidden).toBe(true);
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

	test("the connect button says what it does now", () => {
		render(caseState(sampleCase("c_b1")), noActions);
		expect(el("connect").textContent).toBe("Connect AI app");
		// The status at the top is a button too, saying what a click does.
		expect(el("ai-button").contains(el("ai-status"))).toBe(true);
		expect(el("ai-action").textContent).toBe("Connect");
		render(caseState(sampleCase("c_b1"), ai({ connected: true })), noActions);
		expect(el("connect").textContent).toBe("Manage AI connection");
		expect(el("ai-action").textContent).toBe("Manage");
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

describe("the annotate button", () => {
	const label = (change: (s: PanelState) => void) => {
		const state = initialState();
		change(state);
		render(state, noActions);
		return el<HTMLButtonElement>("annotate").textContent;
	};
	const c = sampleCase();
	const overlay = {
		visible: false,
		url: "https://example.com/",
		title: "",
		drafts: 0,
		saving: false,
		target: { caseId: c.id, title: c.title, nextAnnotation: 2 },
	};

	test("says it goes on with the case the tab was adding to", () => {
		expect(
			label((s) => {
				s.overlay = overlay;
				s.cases = [c];
			}),
		).toBe("Continue annotating");
	});

	test("starts afresh once that case is gone", () => {
		expect(label((s) => (s.overlay = overlay))).toBe("Annotate this page");
	});

	test("stops while the toolbar is up", () => {
		expect(
			label((s) => {
				s.overlay = { ...overlay, visible: true };
				s.cases = [c];
			}),
		).toBe("Stop annotating");
	});
});

test("the panel's mark colours are the page's", async () => {
	const css = await Bun.file(
		new URL("../src/sidepanel/style.css", import.meta.url),
	).text();
	expect(css).toContain(`--mark: ${MARK_COLOUR};`);
	expect(css).toContain(`--mark-found: ${FOUND_COLOUR};`);
	expect(css).toContain(`--mark-unsure: ${PROBABLE_COLOUR};`);
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

	test("names another element, and says when one is hidden", () => {
		render(shownAs("a link"), noActions);
		expect(said()).toBe("a link");
		render(shownAs("a span", false), noActions);
		expect(said()).toBe("a span, hidden at this width");
		render(shownAs(summarize(element), false), noActions);
		expect(said()).toBe("Hidden at this width");
	});
});
