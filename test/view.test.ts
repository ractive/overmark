import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Case } from "../src/lib/case.ts";
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
		home({ id: 1, url: "", title: "" });
		expect(text("page")).toBe("This page");
		home({ id: 1, url: "", title: "Kasse" });
		expect(text("page")).toBe("Kasse");
	});

	test("without an address: says that a click on the icon is needed", () => {
		home({ id: 1, url: "", title: "" });
		expect(el("hint").hidden).toBe(false);
		expect(text("hint")).toContain("Click the Overmark icon");
	});

	test("with an address: no such hint", () => {
		home({ id: 1, url: "https://www.example.com/kk", title: "KK" });
		expect(text("page")).toBe("www.example.com/kk");
		expect(el("hint").hidden).toBe(true);
	});

	test("a hint of its own goes first", () => {
		const state = initialState();
		state.tab = { id: 1, url: "", title: "" };
		state.hint = "Saving";
		render(state, noActions);
		expect(text("hint")).toBe("Saving");
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
