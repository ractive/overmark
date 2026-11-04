/**
 * End to end: the unpacked extension in Chromium. Skipped without Chrome for
 * Testing or Chromium locally, required in CI (see harness.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { startTestRelay, tokenFor } from "@ractive-ch/tab-mcp/testing";
import { webpSize } from "../../src/lib/export.ts";
import { browserBinary, type Harness, startHarness } from "./harness.ts";
import {
	countColour,
	type Db,
	HOST,
	imageBytes,
	markElement,
	READ_DB,
	saveAs,
	shadow,
	showToolbar,
} from "./steps.ts";

describe.skipIf(browserBinary === undefined)("extension", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startHarness(browserBinary as string);
	}, 60_000);

	afterAll(async () => {
		await h?.stop();
	});

	test("has the fixed extension ID", () => {
		expect(h.extensionId).toBe("fphhchhlgklidhnodoleiebmdhnfdadg");
	});

	test("the content script shows and hides the overlay, once per page", async () => {
		const { page, tabId } = await h.open("v1");
		const inject = `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ["content.js"] })`;
		// What extension pages hear when the overlay changes by itself.
		await h.control.eval(
			`globalThis.changes = []; chrome.runtime.onMessage.addListener((m) => { if (m.type === "overlay:changed") globalThis.changes.push(m.state.visible); })`,
		);
		await h.control.eval(inject);
		await h.control.eval(inject);
		const state = await h.control.eval<{ visible: boolean; title: string }>(
			`chrome.tabs.sendMessage(${tabId}, { type: "overlay:show" })`,
		);
		expect(state.visible).toBe(true);
		expect(state.title).toBe("Krankenkasse vergleichen (v1)");
		expect(
			await page.eval<number>(
				`document.querySelectorAll("#overmark-root").length`,
			),
		).toBe(1);
		await page.click(
			`${HOST}.shadowRoot.querySelector('[data-action="close"]')`,
		);
		await h.control.waitFor("globalThis.changes?.includes(false)");
		const after = await h.control.eval<{ visible: boolean }>(
			`chrome.tabs.sendMessage(${tabId}, { type: "overlay:state" })`,
		);
		expect(after.visible).toBe(false);
		await page.send("Page.close");
	});

	test("replaces an overlay that an orphaned instance left behind", async () => {
		// After an extension reload or update the old content script can no
		// longer be reached, but its overlay stays in the page.
		const { page, tabId } = await h.open("v1");
		await page.eval(
			`(() => { const old = document.createElement("div"); old.id = "overmark-root"; old.dataset.orphan = "true"; document.documentElement.append(old); })()`,
		);
		const state = await h.control.eval<{ visible: boolean }>(
			`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ["content.js"] }).then(() => chrome.tabs.sendMessage(${tabId}, { type: "overlay:show" }))`,
		);
		expect(state.visible).toBe(true);
		expect(
			await page.eval<string[]>(
				`[...document.querySelectorAll("#overmark-root")].map((e) => e.dataset.orphan ?? "live")`,
			),
		).toEqual(["live"]);
		await page.send("Page.close");
	});
});

describe.skipIf(browserBinary === undefined)("annotating and saving", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startHarness(browserBinary as string);
	}, 60_000);

	afterAll(async () => {
		await h?.stop();
	});

	test("marks drawn with the toolbar are saved as a case with screenshots", async () => {
		const { page, tabId } = await h.open("v1");
		await page.activate();
		await h.control.eval(
			`chrome.tabs.sendMessage(${tabId}, { type: "overlay:show" }).catch(() => chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ["content.js"] }).then(() => chrome.tabs.sendMessage(${tabId}, { type: "overlay:show" })))`,
		);
		await page.waitFor(shadow('[data-action="tool-box"]'));

		// 1: a box around the submit button
		await page.click(shadow('[data-action="tool-box"]'));
		const button = await page.eval<{
			x: number;
			y: number;
			width: number;
			height: number;
		}>(
			`(() => { const r = document.querySelector("[data-truth=submit]").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
		);
		await page.drag(
			{ x: button.x - 6, y: button.y - 6 },
			{ x: button.x + button.width + 6, y: button.y + button.height + 6 },
		);
		await page.waitFor(shadow(".popover textarea"));
		await page.type("Contrast too low");
		await page.click(shadow('[data-action="comment-done"]'));

		// 2: a note on the tip
		await page.click(shadow('[data-action="tool-note"]'));
		await page.click(`document.querySelector("[data-truth=tip]")`);
		await page.waitFor(shadow(".popover textarea"));
		await page.type("Say how much exactly");
		await page.click(shadow('[data-action="comment-done"]'));

		// 3: far below, the contact paragraph picked as an element
		await page.eval(
			`window.scrollTo(0, document.querySelector("[data-truth=contact]").getBoundingClientRect().top + scrollY - 200)`,
		);
		await page.click(shadow('[data-action="tool-element"]'));
		const contact = await page.centreOf(
			`document.querySelector("[data-truth=contact]")`,
		);
		await page.mouse("mouseMoved", contact.x, contact.y);
		await page.clickAt(contact.x, contact.y);
		await page.waitFor(shadow(".popover textarea"));
		await page.type("Add a phone number");
		await page.click(shadow('[data-action="comment-done"]'));

		expect(
			await page.eval<number>(
				`${shadow("svg.marks")}.querySelectorAll("g[data-number]").length`,
			),
		).toBe(3);

		// Save
		await page.click(shadow('[data-action="save"]'));
		await page.waitFor(shadow('input[aria-label="Case title"]'));
		await page.eval(
			`(() => { const i = ${shadow('input[aria-label="Case title"]')}; i.focus(); i.select(); })()`,
		);
		await page.type("Prämienrechner");
		await page.click(shadow('[data-action="save-confirm"]'));
		await page.waitFor(
			`${shadow('[data-role="status"]')}?.textContent.startsWith("Saved")`,
			20_000,
		);

		const db = await h.control.eval<Db>(READ_DB);
		expect(db.cases).toHaveLength(1);
		const saved = db.cases[0];
		expect(saved?.title).toBe("Prämienrechner");
		expect(saved?.shots).toHaveLength(2);
		const [a1, a2, a3] = saved?.annotations ?? [];
		expect(a1?.shape.kind).toBe("box");
		expect(a1?.comment).toBe("Contrast too low");
		expect(a1?.element?.tag).toBe("button");
		expect(a1?.element?.name).toBe("Prämien berechnen");
		expect(a2?.shape.kind).toBe("note");
		expect(a2?.element?.text).toContain("höheren Franchise");
		expect(a3?.shape.kind).toBe("element");
		expect(a3?.element?.text).toBe("Unser Team hilft Ihnen gerne weiter.");
		expect(a3?.shot).not.toBe(a1?.shot);
		const keys = db.images
			.map((i) => i.key.split("/").slice(1).join("/"))
			.sort();
		expect(keys).toEqual([
			"crops/a1.webp",
			"crops/a2.webp",
			"crops/a3.webp",
			"shots/s1.webp",
			"shots/s2.webp",
		]);
		for (const image of db.images) {
			expect(image.type).toBe("image/webp");
			expect(image.size).toBeGreaterThan(500);
		}

		// Chrome's own WebP passes the header check imports use.
		const shot = await imageBytes(h.control, "Prämienrechner", "shots/s1.webp");
		expect(webpSize(Buffer.from(shot.base64, "base64"))).toEqual({
			width: shot.width,
			height: shot.height,
		});

		// The side panel lists it.
		await h.control.waitFor(`document.querySelector("[data-case]")`);
		expect(
			await h.control.eval<string>(
				`document.querySelector("[data-case] .title").textContent`,
			),
		).toBe("Prämienrechner");
		await page.send("Page.close");
	}, 60_000);

	test("marks drawn before choosing a case are renumbered for it and added", async () => {
		const before = (await h.control.eval<Db>(READ_DB)).cases[0];
		if (before === undefined) throw new Error("the previous test saves a case");
		const { page, tabId } = await h.open("v1");
		await page.activate();
		await h.control.eval(
			`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ["content.js"] }).then(() => chrome.tabs.sendMessage(${tabId}, { type: "overlay:show" }))`,
		);
		await page.waitFor(shadow('[data-action="tool-note"]'));
		await page.click(shadow('[data-action="tool-note"]'));
		await page.click(`document.querySelector("h1")`);
		await page.waitFor(shadow(".popover textarea"));
		await page.type("Larger heading");
		await page.click(shadow('[data-action="comment-done"]'));
		const numbers = () =>
			page.eval<string[]>(
				`[...${shadow("svg.marks")}.querySelectorAll("g[data-number]")].map((g) => g.dataset.number)`,
			);
		expect(await numbers()).toEqual(["1"]);

		// "Add marks on this tab" for the saved case (marks 1–3).
		await h.control.eval(
			`chrome.tabs.sendMessage(${tabId}, { type: "overlay:show", target: { caseId: ${JSON.stringify(before.id)}, title: ${JSON.stringify(before.title)}, nextAnnotation: 4 } })`,
		);
		expect(await numbers()).toEqual(["4"]);

		await page.click(shadow('[data-action="save"]'));
		await page.click(shadow('[data-action="save-confirm"]'));
		await page.waitFor(
			`${shadow('[data-role="status"]')}?.textContent.startsWith("Saved")`,
			20_000,
		);
		const db = await h.control.eval<Db>(READ_DB);
		const after = db.cases.find((c) => c.id === before.id);
		expect(after?.annotations.map((a) => a.number)).toEqual([1, 2, 3, 4]);
		expect(after?.shots.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
		expect(after?.annotations[3]?.shot).toBe("s3");
		expect(db.images.some((i) => i.key.includes("/pending/"))).toBe(false);
		expect(db.images.some((i) => i.key.endsWith("/crops/a4.webp"))).toBe(true);
		await page.send("Page.close");
	}, 60_000);
});

describe.skipIf(browserBinary === undefined)(
	"loading onto another build",
	() => {
		let h: Harness;

		beforeAll(async () => {
			h = await startHarness(browserBinary as string);
		}, 60_000);

		afterAll(async () => {
			await h?.stop();
		});

		test("a case from v1 finds its elements on v2 through the side panel", async () => {
			const v1 = await h.open("v1");
			await showToolbar(h, v1.page, v1.tabId);
			await markElement(v1.page, "[data-truth=submit]", "Too pale");
			await markElement(v1.page, "[data-truth=tip]", "Say how much");
			await markElement(v1.page, "[data-truth=contact]", "Add a phone number");
			await markElement(v1.page, "footer", "Footer is gone in v2");
			await saveAs(v1.page, "Reload test");
			await v1.page.send("Page.close");

			const v2 = await h.open("v2");
			await v2.page.eval(`document.querySelector("footer").remove()`);
			await v2.page.activate();
			await h.control.eval(
				`chrome.scripting.executeScript({ target: { tabId: ${v2.tabId} }, files: ["content.js"] })`,
			);
			// The side panel (the control page) acts on the tab in front: v2.
			// goto waits for the new document; a reload through eval would not.
			await h.control.goto(
				`chrome-extension://${h.extensionId}/sidepanel/index.html`,
			);
			await h.control.waitFor(`document.querySelector("[data-case]")`);
			await h.control.eval(`document.querySelector("[data-case]").click()`);
			await h.control.waitFor(`document.getElementById("load-case")`);
			await h.control.eval(`document.getElementById("load-case").click()`);
			await h.control.waitFor(
				`document.querySelectorAll(".match").length === 4`,
				10_000,
			);

			const statuses = await h.control.eval<string[]>(
				`[...document.querySelectorAll(".match")].map((m) => m.dataset.status)`,
			);
			expect(
				statuses.slice(0, 3).every((s) => s === "found" || s === "probable"),
			).toBe(true);
			expect(statuses[3]).toBe("lost");

			// Each found mark is outlined on the right element of v2.
			const db = await h.control.eval<Db>(READ_DB);
			const saved = db.cases.find((c) => c.title === "Reload test");
			const result = await h.control.eval<{
				matches: { number: number; candidates: { selector: string }[] }[];
			}>(
				`chrome.tabs.sendMessage(${v2.tabId}, { type: "case:load", case: ${JSON.stringify(saved)} })`,
			);
			const truths = ["submit", "tip", "contact"];
			for (const [i, truth] of truths.entries()) {
				const selector = result.matches[i]?.candidates[0]?.selector ?? "";
				expect(
					await v2.page.eval<string | null>(
						`document.querySelector(${JSON.stringify(selector)})?.dataset.truth ?? null`,
					),
				).toBe(truth);
			}
			expect(
				await v2.page.eval<number>(
					`${shadow("svg.marks")}.querySelectorAll("[data-review]").length`,
				),
			).toBe(3);

			// "Show" scrolls the page to the contact paragraph.
			await h.control.eval(
				`document.querySelectorAll(".match")[2].querySelector("[data-action=show]").click()`,
			);
			await v2.page.waitFor(
				`Math.abs(document.querySelector("[data-truth=contact]").getBoundingClientRect().top - innerHeight / 2) < innerHeight / 2`,
			);

			// Marks drawn while a case is loaded: its outlines stay out of the screenshot.
			await showToolbar(h, v2.page, v2.tabId);
			await markElement(v2.page, "[data-truth=tip]", "Still unclear");
			expect(
				await v2.page.eval<number>(
					`${shadow("svg.marks")}.querySelectorAll("[data-review]").length`,
				),
			).toBe(3);
			await saveAs(v2.page, "With outlines loaded");
			expect(
				await countColour(
					h.control,
					"With outlines loaded",
					"shots/s1.webp",
					[0x1e, 0x8e, 0x3e],
				),
			).toBe(0);
			await v2.page.send("Page.close");
		}, 90_000);
	},
);

describe.skipIf(browserBinary === undefined)(
	"an AI app through a relay",
	() => {
		let h: Harness;
		const relay = startTestRelay();

		beforeAll(async () => {
			h = await startHarness(browserBinary as string);
		}, 60_000);

		afterAll(async () => {
			await h?.stop();
			await relay.stop();
		});

		test("the side panel's tools serve real cases to an MCP client", async () => {
			const v1 = await h.open("v1");
			await showToolbar(h, v1.page, v1.tabId);
			await markElement(v1.page, "[data-truth=submit]", "Too pale");
			await markElement(v1.page, "[data-truth=tip]", "Say how much");
			await saveAs(v1.page, "AI test");
			await v1.page.send("Page.close");
			const v2 = await h.open("v2");
			await v2.page.activate();
			await h.control.eval(
				`chrome.scripting.executeScript({ target: { tabId: ${v2.tabId} }, files: ["content.js"] })`,
			);

			// A saved relay the library refuses must not stop the panel.
			await h.control.eval(
				`localStorage.setItem("overmark:relay", "http://192.168.1.20:8080")`,
			);
			await h.control.goto(
				`chrome-extension://${h.extensionId}/sidepanel/index.html`,
			);
			await h.control.waitFor(`document.querySelector("[data-case]")`);
			expect(
				await h.control.eval<string>(
					`document.getElementById("ai-status").textContent`,
				),
			).toContain("cannot be used");
			expect(
				await h.control.eval<string>(`document.getElementById("relay").value`),
			).toBe("http://localhost:8080");

			// The side panel connects to the test relay by itself ("keep AI access on").
			await h.control.eval(
				`localStorage.setItem("overmark:relay", ${JSON.stringify(relay.url)}); localStorage.setItem("overmark:keep-ai-on", "true")`,
			);
			// goto waits for the new document; a reload through eval would not.
			await h.control.goto(
				`chrome-extension://${h.extensionId}/sidepanel/index.html`,
			);
			await h.control.waitFor(
				`document.getElementById("ai-status")?.textContent === "Waiting for an AI app to pair"`,
				10_000,
			);
			await h.control.eval(`document.getElementById("connect").click()`);
			// The library's connect dialog shows the address in a read-only field.
			await h.control.waitFor(
				`document.querySelector(".tab-mcp-address-input")?.value.endsWith("/mcp")`,
			);
			const address = await h.control.eval<string>(
				`document.querySelector(".tab-mcp-address-input").value`,
			);
			const token = await tokenFor(relay.store, address);
			const client = new Client(
				{ name: "e2e", version: "1.0.0" },
				{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
			);
			await client.connect(
				new StreamableHTTPClientTransport(new URL(address), {
					requestInit: { headers: { Authorization: `Bearer ${token}` } },
				}),
			);
			try {
				const cases = await client.callTool({
					name: "list_cases",
					arguments: {},
				});
				const [listed] = JSON.parse(
					(cases.content as { text: string }[])[0]?.text ?? "[]",
				) as { caseId: string; title: string }[];
				expect(listed?.title).toBe("AI test");

				const read = await client.callTool({
					name: "get_case",
					arguments: { caseId: listed?.caseId },
				});
				const images = (
					read.content as { type: string; data?: string; mimeType?: string }[]
				).filter((c) => c.type === "image");
				expect(images).toHaveLength(2);
				const bytes = Buffer.from(images[0]?.data ?? "", "base64");
				expect(images[0]?.mimeType).toBe("image/webp");
				expect(bytes.subarray(8, 12).toString()).toBe("WEBP");

				const load = await client.callTool({
					name: "load_case",
					arguments: { caseId: listed?.caseId },
				});
				const loaded = JSON.parse(
					(load.content as { text: string }[])[0]?.text ?? "{}",
				) as {
					url: string;
					marks: { status: string }[];
				};
				expect(loaded.url).toContain("/v2");
				expect(loaded.marks.map((m) => m.status)).toEqual(["found", "found"]);

				const shot = await client.callTool({ name: "capture", arguments: {} });
				expect((shot.content as { type: string }[])[1]?.type).toBe("image");

				// A change asks in the side panel, names the case, and offers no
				// "Always allow" (DEC-008).
				const verdict = client.callTool({
					name: "set_verdict",
					arguments: { caseId: listed?.caseId, verdict: "Darker" },
				});
				// The newest dialog: the connect dialog may still be open under it.
				const dialog = `[...document.querySelectorAll("dialog[open]")].at(-1)`;
				const buttons = `[...(${dialog}?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim())`;
				await h.control.waitFor(`${buttons}.includes("Don't allow")`, 10_000);
				expect(await h.control.eval<string[]>(buttons)).not.toContain(
					"Always allow",
				);
				expect(await h.control.eval<string>(`${dialog}.textContent`)).toContain(
					"Case: “AI test”",
				);
				// A hidden page gets no dialog "close" event: the panel's tab must
				// be in front to answer (a real side panel is visible).
				await h.control.activate();
				await h.control.eval(
					`[...${dialog}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Don't allow").click()`,
				);
				expect((await verdict).isError).toBe(true);
				await v2.page.activate();
			} finally {
				await client.close();
			}

			// The temporary mark for an AI app's screenshot.
			const described = await h.control.eval<{
				ok: boolean;
				details: { tag: string };
			}>(
				`chrome.tabs.sendMessage(${v2.tabId}, { type: "element:mark", selector: "[data-truth=submit]", number: 9, blurForms: true })`,
			);
			expect(described.ok).toBe(true);
			expect(described.details.tag).toBe("button");
			// Its own mode (not a save's "capturing"), form fields blurred.
			expect(
				await v2.page.eval<string>(
					`${HOST}.shadowRoot.querySelector(".layer").className`,
				),
			).toBe("layer marking");
			expect(
				await v2.page.eval<string>(
					`document.querySelector("input[name=zip]").style.filter`,
				),
			).toBe("blur(6px)");
			expect(
				await v2.page.eval<number>(
					`${shadow("g.temporary")}.childElementCount`,
				),
			).toBeGreaterThan(0);
			await h.control.eval(
				`chrome.tabs.sendMessage(${v2.tabId}, { type: "element:unmark" })`,
			);
			expect(
				await v2.page.eval<number>(
					`${shadow("g.temporary")}.childElementCount`,
				),
			).toBe(0);
			expect(
				await v2.page.eval<string>(
					`document.querySelector("input[name=zip]").style.filter`,
				),
			).toBe("");
			await v2.page.send("Page.close");
		}, 90_000);
	},
);
