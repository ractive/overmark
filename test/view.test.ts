import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { FOUND_COLOUR, PROBABLE_COLOUR } from "../src/content/overlay.ts";
import type { Annotation, Case } from "../src/lib/case.ts";
import { summarize } from "../src/lib/element.ts";
import { MARK_COLOUR } from "../src/lib/marks.ts";
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
			expect(el("open-page").parentElement?.textContent).toStartWith(
				`${url}, `,
			);
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
		render(caseState(sampleCase("c_b1"), ai({ connected: true })), noActions);
		expect(el("connect").textContent).toBe("AI connection…");
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
