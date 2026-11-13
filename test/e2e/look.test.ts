/**
 * End to end: the look (DEC-024) where only a real browser can tell. The side
 * panel never scrolls sideways at its narrowest and at a common width, a view
 * has at most one amber button, the dark scheme's tokens arrive, every stroke
 * on the page has its casing, and the toolbar's rows are the ones meant.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestRelay } from "@ractive-ch/tab-mcp/testing";
import {
	ALL_ICONS_BELOW,
	CASING_EXTRA,
	PAGE_LOOK,
	STATUS_COLOUR,
	TOOL_ICONS_BELOW,
	TWO_ROWS_BELOW,
} from "../../src/content/overlay.ts";
import { MARK_COLOUR } from "../../src/lib/marks.ts";
import { openSidePanel, setRelay } from "./ai.ts";
import type { Page } from "./browser.ts";
import { browserBinary, type Harness, startHarness } from "./harness.ts";
import { markElement, saveAs, shadow } from "./steps.ts";

const id = (name: string) => `document.getElementById(${JSON.stringify(name)})`;

/** The panel's widths: Chrome's narrowest side panel, and a common one. */
const WIDTHS = [360, 420];

describe.skipIf(browserBinary === undefined)("the look", () => {
	let h: Harness;
	let panel: Page;
	let page: Page;

	beforeAll(async () => {
		h = await startHarness(browserBinary as string);
		({ page } = await h.open("v1"));
		await page.activate();
		panel = await openSidePanel(h);
	}, 60_000);

	afterAll(async () => {
		await h?.stop();
	});

	async function panelWidth(width: number): Promise<void> {
		await panel.send("Emulation.setDeviceMetricsOverride", {
			width,
			height: 800,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await panel.waitFor(`innerWidth === ${width}`);
	}

	/** What reaches past the panel's right edge, and the view's amber buttons. */
	const measure = () =>
		panel.eval<{
			scroll: number;
			inner: number;
			past: string[];
			amber: string[];
		}>(
			`(() => {
				const shown = (e) => e.getClientRects().length > 0;
				return {
					scroll: document.documentElement.scrollWidth,
					inner: innerWidth,
					past: [...document.querySelectorAll("body *")]
						.filter((e) => shown(e) && !e.closest(".visually-hidden") && e.getBoundingClientRect().right > innerWidth + 0.5)
						.map((e) => e.tagName + "#" + e.id + "." + e.className),
					amber: [...document.querySelectorAll("button.primary")].filter(shown).map((e) => e.id || e.textContent),
				};
			})()`,
		);

	/** At each width: no sideways scroll, nothing past the edge, `amber` the amber buttons. */
	async function holds(amber: string[]): Promise<void> {
		for (const width of WIDTHS) {
			await panelWidth(width);
			const seen = await measure();
			expect(seen.scroll).toBe(width);
			expect(seen.past).toEqual([]);
			expect(seen.amber).toEqual(amber);
		}
	}

	test("Home, a case with its marks open, and Settings: no sideways scroll at 360 and 420 px, at most one amber button", async () => {
		await panel.waitFor(`!${id("annotate")}.disabled`);
		// Home, empty.
		await holds(["annotate"]);

		// A case with a long title and three marks, drawn on the page.
		await panel.eval(`${id("annotate")}.click()`);
		await page.waitFor(shadow('[data-action="tool-box"]'));
		// The toolbar is up: Stop annotating is no amber button.
		await holds([]);
		await markElement(
			page,
			"[data-truth=submit]",
			"Too pale: the label is hard to read on yellow, and averyveryverylongwordwithoutanybreakinitatallthatmustwrapsomewhere",
		);
		await markElement(page, "[data-truth=tip]", "Amount is outdated");
		await markElement(page, "h1", "Headline should say 2027");
		await saveAs(
			page,
			"Premium form: contrast, copy and a title that takes more than one line of the panel",
		);
		// The panel opens the case the toolbar saved (DEC-023), adding to it.
		await panel.waitFor(
			`!${id("case-view")}.hidden && ${id("add-marks")}?.textContent === "Done adding"`,
			20_000,
		);
		await holds([]);
		await panel.eval(`${id("add-marks")}.click()`);
		await panel.waitFor(
			`${id("add-marks")}.textContent === "Add marks"`,
			20_000,
		);

		// Home, with the case in its list.
		await panel.eval(`${id("back")}.click()`);
		await panel.waitFor(
			`!${id("home")}.hidden && document.querySelectorAll("[data-case]").length === 1`,
			20_000,
		);
		await holds(["annotate"]);

		// The case, opened from the list: its marks are drawn on the page.
		await panel.eval(`document.querySelector("[data-case]").click()`);
		await panel.waitFor(
			`${id("case-hint")}?.textContent.includes("3 of 3 marks found")`,
			20_000,
		);
		// The found line names no colour: a mark's colour is its status.
		expect(await panel.eval<string>(`${id("case-hint")}.textContent`)).toMatch(
			/^3 of 3 marks found on [^ ]+\.$/,
		);
		await panel.eval(`${id("toggle-marks")}.click()`);
		await panel.waitFor(
			`document.querySelectorAll(".annotation[data-open]").length === 3`,
		);
		// One mark fixed: its second row has the pill, Verified and Reopen….
		const first = `document.querySelector(".annotation")`;
		await panel.eval(
			`${first}.querySelector('[data-mark-action="resolve"]').click()`,
		);
		await panel.waitFor(
			`document.querySelector('[data-mark-action="resolve-done"]')`,
		);
		await panel.eval(
			`document.querySelector('[data-mark-action="resolve-done"]').click()`,
		);
		await panel.waitFor(
			`${first}.dataset.status === "fixed" && ${first}.querySelector('.mark-sub [data-mark-action="verify"]') !== null`,
			20_000,
		);
		await holds(["add-marks"]);
		// The status block: a chip per status with marks, tinted in its colour.
		expect(
			await panel.eval<string[][]>(
				`[...document.querySelectorAll("#case-status .chip")].map((c) => [c.dataset.group, getComputedStyle(c).color, getComputedStyle(c).backgroundColor])`,
			),
		).toEqual([
			["open", "rgb(194, 15, 76)", "rgb(252, 228, 236)"],
			["toVerify", "rgb(67, 71, 201)", "rgb(232, 233, 253)"],
		]);
		// The pins: the status's colour, on the rail.
		expect(
			await panel.eval<string[]>(
				`[...document.querySelectorAll(".annotation .number")].map((n) => getComputedStyle(n).backgroundColor)`,
			),
		).toEqual(["rgb(67, 71, 201)", "rgb(194, 15, 76)", "rgb(194, 15, 76)"]);

		// Settings, over the case: the pill turns AI access on, and the card
		// shows the address and the code, its widest content.
		const relay = startTestRelay({ pageWaitMs: 0 });
		try {
			await setRelay(panel, relay.url);
			await panel.eval(`${id("ai-button")}.click()`);
			await panel.waitFor(
				`!${id("settings")}.hidden && ${id("pair-address")}.textContent.endsWith("/mcp")`,
				20_000,
			);
			expect(await panel.eval<string>(`${id("ai-label")}.textContent`)).toBe(
				"AI on, no app yet",
			);
			await holds([]);
			await panel.eval(`${id("setup")}.open = true`);
			await holds([]);
			await panel.eval(`${id("stop-ai")}.click()`);
			await panel.waitFor(`${id("ai-label")}.textContent === "AI off"`, 20_000);
		} finally {
			await relay.stop();
		}
		// The steps above take less than half a second: a click on the back
		// button that soon after "All cases" counts as a double click's second.
		await Bun.sleep(600);
		await panel.eval(`${id("back")}.click()`);
		await panel.waitFor(`!${id("case-view")}.hidden`);
		await panel.send("Emulation.clearDeviceMetricsOverride");
	}, 120_000);

	test("the top bar is paper, and the dark scheme's tokens arrive", async () => {
		const read = () =>
			panel.eval<Record<string, string>>(
				`(() => {
					const root = getComputedStyle(document.documentElement);
					return {
						paper: root.getPropertyValue("--paper").trim(),
						ink: root.getPropertyValue("--ink").trim(),
						body: getComputedStyle(document.body).backgroundColor,
						text: getComputedStyle(document.body).color,
						bar: getComputedStyle(${id("bar")}).backgroundColor,
						rule: getComputedStyle(${id("bar")}).borderBottomColor,
					};
				})()`,
			);
		const scheme = (value: string) =>
			panel.send("Emulation.setEmulatedMedia", {
				features: [{ name: "prefers-color-scheme", value }],
			});
		await scheme("light");
		expect(await read()).toEqual({
			paper: "#f6f4ee",
			ink: "#1b2130",
			body: "rgb(246, 244, 238)",
			text: "rgb(27, 33, 48)",
			bar: "rgb(246, 244, 238)",
			rule: "rgb(222, 218, 208)",
		});
		await scheme("dark");
		expect(await read()).toEqual({
			paper: "#11141a",
			ink: "#eceef3",
			body: "rgb(17, 20, 26)",
			text: "rgb(236, 238, 243)",
			bar: "rgb(17, 20, 26)",
			rule: "rgb(43, 49, 61)",
		});
		await panel.send("Emulation.setEmulatedMedia", { features: [] });
	}, 60_000);

	test("on the page every mark's shape has its casing, a draft's and a loaded mark's", async () => {
		await page.activate();
		/** Per group of `selector`: its stroked parts as [casing?, stroke, width]. */
		const shapes = (selector: string) =>
			page.eval<[boolean, string | null, number][][]>(
				`[...${shadow("svg.marks")}.querySelectorAll(${JSON.stringify(selector)})].map((g) =>
					[...g.querySelectorAll("rect, line, polyline")].map((e) => [e.hasAttribute("data-casing"), e.getAttribute("stroke"), Number(e.getAttribute("stroke-width"))]))`,
			);
		const cased: [boolean, string | null, number][] = [
			[true, PAGE_LOOK.casing, 3 + CASING_EXTRA],
			[false, MARK_COLOUR, 3],
		];
		// The case of the test before is open: its marks are drawn on the page,
		// the first one fixed and to verify, in its colour.
		await page.waitFor(
			`${shadow("svg.marks")}.querySelectorAll("[data-review]").length === 3`,
			20_000,
		);
		const toVerify: typeof cased = [
			[true, PAGE_LOOK.casing, 3 + CASING_EXTRA],
			[false, STATUS_COLOUR.toVerify, 3],
		];
		expect(await shapes("[data-review]")).toEqual([toVerify, cased, cased]);
		// The bars have their white ring before the shadow.
		expect(
			await page.eval<string>(
				`getComputedStyle(${shadow(".reviewbar")}).boxShadow`,
			),
		).toStartWith("rgba(255, 255, 255, 0.75) 0px 0px 0px 1px");

		// A draft, drawn now.
		await panel.eval(`${id("add-marks")}.click()`);
		await page.waitFor(shadow('[data-action="tool-element"]'));
		await page.click(shadow('[data-action="tool-element"]'));
		const at = await page.eval<{ x: number; y: number }>(
			`(() => { const r = document.querySelector("label, p, a").getBoundingClientRect(); return { x: r.x + 4, y: r.y + r.height / 2 }; })()`,
		);
		await page.mouse("mouseMoved", at.x, at.y);
		await page.waitFor(
			`${shadow("svg.marks")}.querySelectorAll(".drafts rect.hover").length === 2`,
		);
		await page.clickAt(at.x, at.y);
		await page.waitFor(shadow(".popover textarea"));
		const drafts = await page.eval<[boolean, string | null, number][]>(
			`[...${shadow("svg.marks")}.querySelectorAll(".drafts > rect:not(.hover)")].map((e) => [e.hasAttribute("data-casing"), e.getAttribute("stroke"), Number(e.getAttribute("stroke-width"))])`,
		);
		expect(drafts).toEqual(cased);
		// The popover is light on any page, with its ring.
		expect(
			await page.eval<string[]>(
				`(() => { const s = getComputedStyle(${shadow(".popover")}); return [s.colorScheme, s.backgroundColor, s.boxShadow.slice(0, 41)]; })()`,
			),
		).toEqual([
			"light",
			"rgb(255, 255, 255)",
			"rgba(255, 255, 255, 0.75) 0px 0px 0px 1px",
		]);
		await page.click(shadow('[data-action="comment-remove"]'));
		await panel.eval(`${id("add-marks")}.click()`);
		await panel.waitFor(
			`${id("add-marks")}.textContent === "Add marks"`,
			20_000,
		);
	}, 120_000);

	test("the toolbar: one row on a wide page, the status on a second row on a narrower one, and the tools never wrap", async () => {
		await page.activate();
		await panel.eval(`${id("add-marks")}.click()`);
		await page.waitFor(shadow('[data-action="tool-box"]'));
		const rows = (width: number) =>
			page
				.send("Emulation.setDeviceMetricsOverride", {
					width,
					height: 600,
					deviceScaleFactor: 1,
					mobile: false,
				})
				.then(() => page.waitFor(`innerWidth === ${width}`))
				.then(() =>
					page.eval<{
						buttons: number;
						status: number;
						fits: boolean;
						words: number;
						named: boolean;
					}>(
						`(() => {
							const bar = ${shadow(".toolbar")};
							const all = [...bar.querySelectorAll("button")];
							const top = (e) => Math.round(e.getBoundingClientRect().top);
							const box = bar.getBoundingClientRect();
							const tops = [...new Set(all.map(top))];
							const under = Math.max(...all.map((e) => e.getBoundingClientRect().bottom));
							return {
								buttons: tops.length,
								status: bar.querySelector(".status").getBoundingClientRect().top >= under - 1 ? 2 : 1,
								fits: box.left >= 0 && box.right <= innerWidth,
								words: all.filter((b) => { const w = b.querySelector(".word"); return w && w.getBoundingClientRect().width > 2; }).length,
								named: all.every((b) => (b.textContent || b.getAttribute("aria-label") || "").trim() !== ""),
							};
						})()`,
					),
				);
		// Adding to a case: five tools, Undo and Done have an icon and a word.
		expect(await rows(TWO_ROWS_BELOW + 240)).toEqual({
			buttons: 1,
			status: 1,
			fits: true,
			words: 7,
			named: true,
		});
		expect(await rows(TWO_ROWS_BELOW - 1)).toEqual({
			buttons: 1,
			status: 2,
			fits: true,
			words: 7,
			named: true,
		});
		// The tools are their icons; their names stay for a screen reader.
		expect(await rows(TOOL_ICONS_BELOW - 1)).toEqual({
			buttons: 1,
			status: 2,
			fits: true,
			words: 2,
			named: true,
		});
		expect(await rows(ALL_ICONS_BELOW - 1)).toEqual({
			buttons: 1,
			status: 2,
			fits: true,
			words: 0,
			named: true,
		});
		expect(await rows(420)).toEqual({
			buttons: 1,
			status: 2,
			fits: true,
			words: 0,
			named: true,
		});
		await page.send("Emulation.clearDeviceMetricsOverride");
		await panel.eval(`${id("add-marks")}.click()`);
	}, 120_000);
});
