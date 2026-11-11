/**
 * End to end: Always allow and Allow all changes (DEC-018). Always allow in
 * a question lets that tool of that AI app run without asking, and no other;
 * Allow all changes in the AI app card lets every tool through; Ask again
 * takes a tool back; the notification's Always allow counts too; it survives
 * a worker restart; Disconnect forgets it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import { startTestRelay } from "@ractive-ch/tab-mcp/testing";
import type { Case } from "../../src/lib/case.ts";
import { sampleCase } from "../fixtures.ts";
import {
	answerInPanel,
	byId,
	clickNotification,
	closeSidePanel,
	connectAi,
	mcpClient,
	newNotification,
	notifications,
	openSidePanel,
} from "./ai.ts";
import type { Page } from "./browser.ts";
import { browserBinary, type Harness, startHarness } from "./harness.ts";
import { READ_DB, settingsOf, until, worker } from "./steps.ts";

interface CallResult {
	isError?: boolean;
	content: { type: string; text?: string }[];
}

const putCases = (h: Harness, cases: Case[]) =>
	h.control.eval(`new Promise((resolve, reject) => {
		const open = indexedDB.open("overmark");
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const tx = open.result.transaction("cases", "readwrite");
			for (const c of ${JSON.stringify(cases)}) tx.objectStore("cases").put(c);
			tx.oncomplete = () => { open.result.close(); resolve(); };
			tx.onerror = () => reject(tx.error);
		};
	})`);

const caseIds = async (h: Harness) =>
	(await h.control.eval<{ cases: Case[] }>(READ_DB)).cases.map((c) => c.id);

const QUESTION = `document.querySelector("[data-question]")`;
const GRANT = `document.querySelector("#pair-grants li[data-grant]")`;

describe.skipIf(browserBinary === undefined)(
	"Always allow, per tool or for all, until the AI app is disconnected",
	() => {
		let h: Harness;
		let panel: Page;
		let client: Client;
		let address: string;
		let tab: { page: Page; tabId: number };
		const relay = startTestRelay();

		const call = (name: string, args: Record<string, unknown> = {}) =>
			client.callTool({ name, arguments: args }) as Promise<CallResult>;
		/** A call that must run without a question in the panel. */
		const runs = async (name: string, args: Record<string, unknown>) => {
			const result = await call(name, args);
			expect(result.isError).toBeFalsy();
			expect(await panel.eval(`!${QUESTION}`)).toBe(true);
		};
		/** A call that must ask: answered in the panel with `answer`. */
		const asks = async (
			name: string,
			args: Record<string, unknown>,
			answer: "allow" | "deny" | "always",
		) => {
			const result = call(name, args);
			await panel.waitFor(QUESTION, 10_000);
			await answerInPanel(panel, answer);
			await panel.waitFor(`!${QUESTION}`);
			return result;
		};
		const kept = async () =>
			(await settingsOf(h))["alwaysAllowed"] as
				| Record<string, { all: boolean; tools: string[] }>
				| undefined;

		/**
		 * A new AI app paired with the address. The test token comes straight
		 * from the relay's store, which tells no session: connecting again makes
		 * the relay list it, as pairing would.
		 */
		const pairApp = async () => {
			client = await mcpClient(relay.store, address);
			await panel.eval(`${byId("stop-ai")}.click()`);
			await panel.waitFor(
				`document.documentElement.dataset.aiState === "disconnected"`,
				10_000,
			);
			await panel.eval(`${byId("connect")}.click()`);
			await panel.waitFor(GRANT, 10_000);
		};

		beforeAll(async () => {
			h = await startHarness(browserBinary as string);
			await putCases(h, [
				sampleCase("c_1"),
				sampleCase("c_2"),
				sampleCase("c_3"),
			]);
			tab = await h.open("v1");
			await tab.page.activate();
			panel = await openSidePanel(h);
			address = await connectAi(panel, relay.url);
			await pairApp();
		}, 60_000);

		afterAll(async () => {
			await client?.close();
			await h?.stop();
			await relay.stop();
		});

		test("the question explains Always allow, which arms with Allow", async () => {
			const result = call("set_summary", { caseId: "c_1", summary: "One" });
			await panel.waitFor(QUESTION, 10_000);
			expect(await panel.eval<string>(`${QUESTION}.textContent`)).toContain(
				"Always allow: Record the summary for the developer runs without asking for Test client (client.example), until you disconnect it.",
			);
			expect(
				await panel.eval(
					`${QUESTION}.querySelector('button[data-answer="always"]').disabled`,
				),
			).toBe(true);
			await answerInPanel(panel, "allow");
			expect((await result).isError).toBeFalsy();
		});

		test("Always allow skips the next question of that tool for that app, not of another tool", async () => {
			expect(
				(await asks("set_summary", { caseId: "c_1", summary: "Two" }, "always"))
					.isError,
			).toBeFalsy();
			await runs("set_summary", { caseId: "c_1", summary: "Three" });
			// Another tool still asks.
			expect(
				(await asks("delete_case", { caseId: "c_2" }, "deny")).isError,
			).toBe(true);
			expect(await caseIds(h)).toContain("c_2");
			// The card lists it under the app.
			await panel.waitFor(
				`${GRANT}.textContent.includes("Always allowed: Record the summary for the developer")`,
			);
		});

		test("Ask again in the card takes it back: the tool asks again", async () => {
			await panel.eval(
				`(() => { const b = ${GRANT}.querySelector('[data-focus="ask-again:set_summary"]'); b.focus(); b.click(); })()`,
			);
			await panel.waitFor(
				`!${GRANT}.textContent.includes("Always allowed")`,
				10_000,
			);
			// Its button went with it: the focus stays in that app's card.
			expect(
				await panel.eval<string | undefined>(
					"document.activeElement?.dataset.focus",
				),
			).toBe("allow-all");
			expect(await kept()).toBeUndefined();
			expect(
				(await asks("set_summary", { caseId: "c_1", summary: "Four" }, "deny"))
					.isError,
			).toBe(true);
		});

		test("Allow all changes skips every tool's question until it is off", async () => {
			const allowAll = `${GRANT}.querySelector('[data-focus="allow-all"]')`;
			expect(await panel.eval(`${allowAll}.checked`)).toBe(false);
			await panel.eval(`${allowAll}.click()`);
			await until(
				kept,
				(k) => Object.values(k ?? {}).some((e) => e.all),
				10_000,
			);
			await panel.waitFor(`${allowAll}.checked`);
			await runs("set_summary", { caseId: "c_1", summary: "Five" });
			await runs("delete_case", { caseId: "c_2" });
			expect(await caseIds(h)).not.toContain("c_2");
			await panel.eval(`${allowAll}.click()`);
			await until(kept, (k) => k === undefined, 10_000);
			expect(
				(await asks("set_summary", { caseId: "c_1", summary: "Six" }, "deny"))
					.isError,
			).toBe(true);
		});

		test("the notification's Always allow counts, and survives a worker restart", async () => {
			// The panel's window in front: the one closing it acts on.
			await tab.page.activate();
			await closeSidePanel(h, panel);
			const result = call("set_summary", { caseId: "c_1", summary: "Seven" });
			const id = await newNotification(h);
			// After the guard against a click that came too soon.
			await Bun.sleep(600);
			await clickNotification(h, id, 1);
			expect((await result).isError).toBeFalsy();
			await until(
				kept,
				(k) =>
					Object.values(k ?? {}).some((e) => e.tools.includes("set_summary")),
				10_000,
			);
			// No notification for the next call.
			expect(
				(await call("set_summary", { caseId: "c_1", summary: "Eight" }))
					.isError,
			).toBeFalsy();
			expect(await notifications(h)).toEqual([]);
			// A new worker reads it from its database. Stopped as Chrome does
			// (the sessions on it would keep it alive otherwise).
			const { targetId } = await h.browser.waitForTarget(
				(t) =>
					t.type === "service_worker" &&
					t.url === `chrome-extension://${h.extensionId}/background.js`,
			);
			await (await worker(h)).eval("globalThis.e2eBefore = true");
			await h.browser.send("Target.closeTarget", { targetId });
			await Bun.sleep(500);
			// With no side panel open, a message wakes it (as the alarm would).
			await h.control.eval(
				`chrome.runtime.sendMessage({ type: "images:discard", caseId: "c_none", shotIds: [] })`,
			);
			const end = Date.now() + 20_000;
			for (;;) {
				const again = await call("set_summary", {
					caseId: "c_1",
					summary: "Nine",
				}).catch(() => undefined);
				if (again !== undefined && !again.isError) break;
				if (Date.now() > end) throw new Error("the address did not answer");
				await Bun.sleep(250);
			}
			expect(await notifications(h)).toEqual([]);
			expect(
				await (await worker(h)).eval("globalThis.e2eBefore ?? false"),
			).toBe(false);
			await tab.page.activate();
			panel = await openSidePanel(h);
			await panel.waitFor(
				`${GRANT}?.textContent.includes("Always allowed: Record the summary for the developer")`,
				10_000,
			);
		}, 60_000);

		test("Disconnect forgets it: the app paired again is asked", async () => {
			const before = await kept();
			expect(Object.keys(before ?? {})).toHaveLength(1);
			const disconnect = `${GRANT}.querySelector('[data-focus="disconnect"]')`;
			await panel.eval(`${disconnect}.click()`);
			// The second click confirms only after a moment (no double click).
			await Bun.sleep(800);
			await panel.eval(`${disconnect}.click()`);
			await panel.waitFor(`!${GRANT}`, 10_000);
			await until(kept, (k) => k === undefined, 10_000);
			await client.close();
			await pairApp();
			expect(
				(await asks("set_summary", { caseId: "c_3", summary: "Ten" }, "deny"))
					.isError,
			).toBe(true);
		}, 60_000);
	},
);
