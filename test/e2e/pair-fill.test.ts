/**
 * End to end, in Chromium: an AI app opens the relay's pairing page in this
 * browser, Sitegloss asks in its side panel, and only a yes fills in its
 * code and clicks Connect (DEC-044). The page is a fixture with the relay's
 * markup (`pairingPage`, as the unit tests use it) served on a port of its own:
 * the testing package's relay cannot show its form for a test client. The
 * test build takes that origin through `siteglossTestFillOrigins`; other
 * builds fill in only the hosted relay's page.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestRelay } from "@ractive-ch/tab-mcp/testing";
import { pairingPage } from "../pair-fill-page.ts";
import { byId, connectAi, openSidePanel } from "./ai.ts";
import type { Page } from "./browser.ts";
import { browserBinary, type Harness, startHarness } from "./harness.ts";
import { worker } from "./steps.ts";

describe.skipIf(browserBinary === undefined)(
	"filling in the code on the relay's pairing page",
	() => {
		let h: Harness;
		let panel: Page;
		const relay = startTestRelay();
		/** The codes the fixture's form posted. */
		const posted: string[] = [];
		const fixture = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (req) => {
				const url = new URL(req.url);
				if (req.method === "POST") {
					const form = await req.formData();
					posted.push(String(form.get("code")));
					return new Response("posted");
				}
				if (url.pathname !== "/authorize")
					return new Response("Not found", { status: 404 });
				return new Response(
					pairingPage({
						app: url.searchParams.get("app") ?? "sitegloss",
						name: "Test AI",
						host: "client.example",
					}),
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		const origin = `http://127.0.0.1:${fixture.port}`;
		const ASK = byId("pair-fill-ask");
		const close = (page: Page) =>
			h.browser.send("Target.closeTarget", { targetId: page.targetId });

		beforeAll(async () => {
			h = await startHarness(browserBinary as string);
			panel = await openSidePanel(h);
			await connectAi(panel, relay.url);
			const w = await worker(h);
			await w.eval(
				`globalThis.siteglossTestFillOrigins = [${JSON.stringify(origin)}]`,
			);
			await panel.send("Emulation.setFocusEmulationEnabled", {
				enabled: true,
			});
		}, 60_000);

		afterAll(async () => {
			await h?.stop();
			await relay.stop();
			await fixture.stop(true);
		});

		test("a form for Sitegloss: the panel asks, naming the app as the form does; Fill in the code types the code and clicks Connect", async () => {
			const tab = await h.browser.newPage(`${origin}/authorize?r=1`);
			await panel.waitFor(`!${ASK}.hidden`, 10_000);
			expect(
				await panel.eval<string>(`${byId("pair-fill-ask-text")}.textContent`),
			).toBe(
				"Test AI (client.example) wants to connect to Sitegloss on the relay's page in this browser. Fill in the code there?",
			);
			// The code is shown by the card (no app paired: the pairing view is open).
			await panel.waitFor(
				`/^[A-Z]{4}-[A-Z]{4}$/.test(${byId("pair-code")}.textContent)`,
				10_000,
			);
			const code = await panel.eval<string>(`${byId("pair-code")}.textContent`);
			// Nothing was filled in before the answer.
			expect(posted).toEqual([]);
			expect(
				await tab.eval<string>(
					`document.querySelector("[data-tab-mcp-field=code]").value`,
				),
			).toBe("");
			const yes = byId("pair-fill-yes");
			await panel.waitFor(`!${yes}.disabled`, 10_000);
			await panel.eval(`${yes}.click()`);
			await panel.waitFor(`${ASK}.hidden`, 10_000);
			const end = Date.now() + 10_000;
			while (posted.length === 0 && Date.now() < end) await Bun.sleep(50);
			expect(posted).toEqual([code]);
			await close(tab);
		});

		test("No: nothing is filled in, the form stays as it was", async () => {
			const tab = await h.browser.newPage(`${origin}/authorize?r=2`);
			await panel.waitFor(`!${ASK}.hidden`, 10_000);
			await panel.eval(`${byId("pair-fill-no")}.click()`);
			await panel.waitFor(`${ASK}.hidden`, 10_000);
			await Bun.sleep(500);
			expect(posted).toHaveLength(1);
			expect(
				await tab.eval<string>(
					`document.querySelector("[data-tab-mcp-field=code]").value`,
				),
			).toBe("");
			await close(tab);
		});

		test("a form for another app, or a page of another origin: no question", async () => {
			const other = await h.browser.newPage(`${origin}/authorize?app=other`);
			const elsewhere = await h.browser.newPage(`${h.base}/v1?/authorize`);
			await Bun.sleep(1500);
			expect(await panel.eval(`${ASK}.hidden`)).toBe(true);
			expect(posted).toHaveLength(1);
			await close(other);
			await close(elsewhere);
		});
	},
);
