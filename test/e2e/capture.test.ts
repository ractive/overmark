/**
 * End to end: what a mark records of the page (DEC-047), on a copy of
 * Sitegloss's demo page (`pages/demo.html`): a link's fragment, the heading
 * of the card a mark is in, and the element a note, an arrow, a box and a
 * pen stroke are about, with an arrow's two ends.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Case, ElementDetails } from "../../src/lib/case.ts";
import type { Page } from "./browser.ts";
import { browserBinary, type Harness, startHarness } from "./harness.ts";
import {
	comment,
	type Db,
	markElement,
	marksIn,
	READ_DB,
	shadow,
	showToolbar,
} from "./steps.ts";

type Box = { x: number; y: number; width: number; height: number };

const boxOf = (page: Page, selector: string) =>
	page.eval<Box>(
		`(() => { const { x, y, width, height } = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x, y, width, height }; })()`,
	);

/** Choose a drawing tool and wait until it is on. */
async function tool(page: Page, name: string): Promise<void> {
	const button = shadow(`[data-action="tool-${name}"]`);
	await page.click(button);
	await page.waitFor(`${button}.getAttribute("aria-pressed") === "true"`);
}

describe.skipIf(browserBinary === undefined)(
	"what a drawn mark records, on the demo page",
	() => {
		let h: Harness;

		beforeAll(async () => {
			h = await startHarness(browserBinary as string);
		}, 60_000);

		afterAll(async () => {
			await h?.stop();
		});

		test("a link's place on the page, the card's own title, and the element each kind of mark is about", async () => {
			const { page, tabId } = await h.open("demo");
			await page.send("Emulation.setDeviceMetricsOverride", {
				width: 1200,
				height: 900,
				deviceScaleFactor: 1,
				mobile: false,
			});
			await showToolbar(h, page, tabId);
			// 1. The city bike's Book link, with the Element tool.
			await markElement(page, "[data-testid=card-city-book]", "Book link");
			await page.eval(
				`document.querySelector("#bikes").scrollIntoView({ block: "start" })`,
			);
			await page.eval(
				"new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
			);
			// 2. A note on the e-bike's "New" badge, which comes before its title.
			await tool(page, "note");
			const badge = await boxOf(page, ".pp-card-new .pp-badge");
			await page.clickAt(badge.x + badge.width / 2, badge.y + badge.height / 2);
			await comment(page, "Badge");
			// 3. An arrow from that badge to the gravel bike's price, ending on
			// its bold amount.
			await tool(page, "arrow");
			// Measured again: the comment's field may have scrolled the page.
			const from = await boxOf(page, ".pp-card-new .pp-badge");
			const amount = await boxOf(
				page,
				"[data-testid=card-gravel-price] strong",
			);
			await page.drag(
				{ x: from.x + from.width / 2, y: from.y + from.height / 2 },
				{ x: amount.x + amount.width / 2, y: amount.y + amount.height / 2 },
			);
			await comment(page, "Arrow");
			// 4. A box round the gravel bike's picture.
			await tool(page, "box");
			const bike = await boxOf(page, "[data-testid=card-gravel] svg");
			await page.drag(
				{ x: bike.x - 6, y: bike.y - 6 },
				{ x: bike.x + bike.width + 6, y: bike.y + bike.height + 6 },
			);
			await comment(page, "Box");
			// 5. The city bike's price underlined.
			await tool(page, "pen");
			const price = await boxOf(page, "[data-testid=card-city-price]");
			const words = await page.eval<Box>(
				`(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector("[data-testid=card-city-price]")); const { x, y, width, height } = r.getBoundingClientRect(); return { x, y, width, height }; })()`,
			);
			await page.drag(
				{ x: words.x, y: price.y + price.height + 2 },
				{ x: words.x + words.width, y: price.y + price.height + 4 },
			);
			await comment(page, "Underline");

			const caseId = await marksIn(page);
			const db = await h.control.eval<Db>(READ_DB);
			const c = db.cases.find((x) => x.id === caseId) as unknown as Case;
			const mark = (n: number) =>
				c.annotations.find(
					(a) => a.number === n,
				) as Case["annotations"][number];
			const el = (n: number) => mark(n).element as ElementDetails;
			const path = new URL(await page.eval<string>("location.href")).pathname;

			// The link keeps where on the page it goes; its title is the card's.
			expect(el(1).attributes["href"]).toBe(`${path}#book`);
			expect(el(1).heading).toBe("City bike");
			// The badge is a thing of its own, under the card it is in.
			expect(el(2).classes).toContain("pp-badge");
			expect(el(2).heading).toBe("E-bike");
			// The arrow is about the price it points at (not the bold word in
			// it), and says where it starts.
			expect(mark(3).shape.kind).toBe("arrow");
			expect(el(3).testId).toBe("card-gravel-price");
			expect(el(3).heading).toBe("Gravel bike");
			expect(mark(3).ends?.end?.testId).toBe("card-gravel-price");
			expect(mark(3).ends?.start?.classes).toContain("pp-badge");
			// The box is about the picture, not a wheel of it.
			expect(el(4).tag).toBe("svg");
			expect(el(4).heading).toBe("Gravel bike");
			// The underline is about the text over it, and has no ends.
			expect(el(5).testId).toBe("card-city-price");
			expect(mark(5).ends).toBeUndefined();
			// A note has no ends either.
			expect(mark(2).ends).toBeUndefined();
			await page.send("Page.close");
		}, 120_000);
	},
);
