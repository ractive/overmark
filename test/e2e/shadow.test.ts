/**
 * Picking and finding again inside web components, on Chromium's own hit test
 * and with a closed shadow root: happy-dom has neither.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browserBinary, type Harness, startHarness } from "./harness.ts";
import { comment, READ_DB, saveAs, shadow, showToolbar } from "./steps.ts";

interface Stored {
	title: string;
	annotations: {
		element: {
			tag: string;
			text?: string;
			ancestors: string[];
			selector: string;
		} | null;
	}[];
}

describe.skipIf(browserBinary === undefined)("web components", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startHarness(browserBinary as string);
	}, 60_000);

	afterAll(async () => {
		await h?.stop();
	});

	test("a mark in a shadow root is on the button, also on the next visit", async () => {
		const { page, tabId } = await h.open("shadow");
		await showToolbar(h, page, tabId);
		for (const host of ["app-panel", "app-vault", "app-send"]) {
			const pressed = await page.eval<string>(
				`${shadow('[data-action="tool-element"]')}.getAttribute("aria-pressed")`,
			);
			if (pressed !== "true")
				await page.click(shadow('[data-action="tool-element"]'));
			// The button sits inside the component's padding.
			const r = await page.eval<{ x: number; y: number }>(
				`(() => { const r = document.querySelector("${host}").getBoundingClientRect(); return { x: r.x + 60, y: r.y + 60 }; })()`,
			);
			await page.mouse("mouseMoved", r.x, r.y);
			await page.waitFor(
				`Number(${shadow("svg.marks")}.querySelector(".hover")?.getAttribute("width")) < 400`,
			);
			await page.clickAt(r.x, r.y);
			await comment(page, `In ${host}`);
		}
		await saveAs(page, "Components");

		const db = await h.control.eval<{ cases: Stored[] }>(READ_DB);
		const saved = db.cases.find((c) => c.title === "Components");
		const elements = saved?.annotations.map((a) => a.element);
		expect(elements?.map((e) => e?.tag)).toEqual([
			"button",
			"button",
			"button",
		]);
		expect(elements?.map((e) => e?.text)).toEqual([
			"Offen speichern",
			"Geschlossen speichern",
			"Offerte senden",
		]);
		expect(elements?.[1]?.ancestors).toEqual(["section", "app-vault", "main"]);
		expect(elements?.map((e) => e?.selector)).toEqual(["", "", ""]);

		const result = await h.control.eval<{
			matches: { status: string; candidates: { summary: string }[] }[];
		}>(
			`chrome.tabs.sendMessage(${tabId}, { type: "case:load", case: ${JSON.stringify(saved)} })`,
		);
		expect(result.matches.map((m) => m.status)).toEqual([
			"found",
			"found",
			"found",
		]);
		expect(result.matches[1]?.candidates[0]?.summary).toContain(
			"Geschlossen speichern",
		);
		// Outlined around the button, not the whole component.
		const widths = await page.eval<number[]>(
			`[...${shadow("svg.marks")}.querySelectorAll("[data-review]")].map((r) => Number(r.getAttribute("width")))`,
		);
		expect(widths.length).toBe(3);
		expect(Math.max(...widths)).toBeLessThan(400);
	}, 40_000);
});
