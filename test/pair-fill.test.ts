/**
 * Filling in the code on the relay's pairing page (DEC-044): which pages
 * count, what is read of the form and what is filled in. Against a fixture
 * with the relay's markup (tab-mcp's `oauth/server.ts`, relay 0.12.0, the
 * hooks of its DEC-199): the testing package's relay cannot show the form
 * for a test client (it fetches the AI app's metadata over HTTPS).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
	fillPairingForm,
	HOSTED_ORIGIN,
	isCode,
	isPairingPage,
	PAIR_FILL_SITE,
	readPairingForm,
} from "../src/worker/pair-fill.ts";
import { pairingPage } from "./pair-fill-page.ts";

const globals = globalThis as Record<string, unknown>;
let window: Window;
let before: { document: unknown; Event: unknown };

// The page's own globals, as `executeScript` runs the functions there.
beforeEach(() => {
	window = new Window({ url: `${HOSTED_ORIGIN}/authorize?x=1` });
	before = { document: globals["document"], Event: globals["Event"] };
	globals["document"] = window.document;
	globals["Event"] = window.Event;
});
afterEach(() => {
	globals["document"] = before.document;
	globals["Event"] = before.Event;
	void window.happyDOM.close();
});

function load(html: string) {
	window.document.write(html);
	const submitted: string[] = [];
	window.document.querySelector("form")?.addEventListener("submit", (e) => {
		e.preventDefault();
		const field = window.document.querySelector(
			"[data-tab-mcp-field=code]",
		) as unknown as HTMLInputElement | null;
		submitted.push(field?.value ?? "");
	});
	return submitted;
}

describe("which page counts", () => {
	test("only the hosted relay's /authorize, exactly", () => {
		expect(HOSTED_ORIGIN).toBe("https://tab-mcp.ractive.ch");
		expect(PAIR_FILL_SITE).toEqual({
			origins: ["https://tab-mcp.ractive.ch/*"],
		});
		const ok = [HOSTED_ORIGIN];
		expect(isPairingPage(`${HOSTED_ORIGIN}/authorize`, ok)).toBe(true);
		expect(
			isPairingPage(`${HOSTED_ORIGIN}/authorize?response_type=code`, ok),
		).toBe(true);
		for (const url of [
			"https://tab-mcp.ractive.ch.example.com/authorize",
			"https://example.com/tab-mcp.ractive.ch/authorize",
			"http://tab-mcp.ractive.ch/authorize",
			"https://tab-mcp.ractive.ch:8443/authorize",
			"https://xtab-mcp.ractive.ch/authorize",
			"https://tab-mcp.ractive.ch/authorize/",
			"https://tab-mcp.ractive.ch/x/authorize",
			"https://tab-mcp.ractive.ch/",
			"https://tab-mcp.ractive.ch@example.com/authorize",
			"not a url",
			undefined,
		])
			expect(isPairingPage(url, ok)).toBe(false);
		// With no origin allowed (another relay set), nothing counts.
		expect(isPairingPage(`${HOSTED_ORIGIN}/authorize`, [])).toBe(false);
	});

	test("a code is 8 letters as the relay sends it", () => {
		expect(isCode("BCDF-GHJK")).toBe(true);
		for (const code of ["BCDFGHJK", "bcdf-ghjk", "BCD-GHJK", "", undefined])
			expect(isCode(code)).toBe(false);
	});
});

describe("the form", () => {
	test("its hooks, as the relay writes them", () => {
		load(pairingPage({ name: "Claude Code", host: "claude.ai" }));
		expect(readPairingForm()).toEqual({
			app: "sitegloss",
			clientName: "Claude Code",
			clientHost: "claude.ai",
		});
	});

	test("not as documented: nothing", () => {
		load(pairingPage({ forms: 2 }));
		expect(readPairingForm()).toBeNull();
		load(pairingPage().replace(' data-tab-mcp-field="code"', ""));
		expect(readPairingForm()).toBeNull();
		load(pairingPage().replace(' data-tab-mcp-action="connect"', ""));
		expect(readPairingForm()).toBeNull();
		load(pairingPage({ host: "" }));
		expect(readPairingForm()).toBeNull();
		load("<!doctype html><p>This connection request has expired.</p>");
		expect(readPairingForm()).toBeNull();
	});

	test("filled in: the code typed into the field, Connect clicked, nothing else written", () => {
		const submitted = load(pairingPage());
		const seen = readPairingForm();
		expect(seen).not.toBeNull();
		const html = () => window.document.body.innerHTML;
		const markup = html();
		expect(fillPairingForm("BCDF-GHJK", seen as never)).toBe(true);
		expect(submitted).toEqual(["BCDF-GHJK"]);
		// The value is the field's, not an attribute of the page.
		expect(html()).toBe(markup);
		expect(html()).not.toContain("BCDF-GHJK");
	});

	test("a form that changed since the question: nothing filled in", () => {
		const submitted = load(pairingPage({ name: "Claude" }));
		const seen = readPairingForm();
		load(pairingPage({ name: "Someone else" }));
		expect(fillPairingForm("BCDF-GHJK", seen as never)).toBe(false);
		expect(submitted).toEqual([]);
		const field = window.document.querySelector(
			"[data-tab-mcp-field=code]",
		) as unknown as HTMLInputElement | null;
		expect(field?.value).toBe("");
	});
});
