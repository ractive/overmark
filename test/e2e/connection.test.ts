/**
 * End to end: the AI connection in the service worker (DEC-015). It stays
 * while the side panel is closed; a question shows in the side panel of the
 * window in front, or else as a Chrome notification (answered through the
 * worker's own button handler); only the side panel's own page may command
 * the connection; the panel's old address is kept.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import { startTestRelay } from "@ractive-ch/tab-mcp/testing";
import { TabMcp } from "@ractive-ch/tab-mcp-client";
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
import { READ_DB, worker } from "./steps.ts";

interface CallResult {
	isError?: boolean;
	content: { type: string; text?: string }[];
}

/** Write these cases into the store. */
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

const verdictOf = async (h: Harness, caseId: string) =>
	(await h.control.eval<{ cases: Case[] }>(READ_DB)).cases.find(
		(c) => c.id === caseId,
	)?.verdict;

describe.skipIf(browserBinary === undefined)(
	"the AI connection without the side panel",
	() => {
		let h: Harness;
		let panel: Page;
		let client: Client;
		let address: string;
		let tab: { page: Page; tabId: number };
		const relay = startTestRelay();

		const call = (name: string, args: Record<string, unknown> = {}) =>
			client.callTool({ name, arguments: args }) as Promise<CallResult>;
		const badge = async () =>
			(await worker(h)).eval<string>("chrome.action.getBadgeText({})");

		beforeAll(async () => {
			h = await startHarness(browserBinary as string);
			await putCases(h, [sampleCase("c_1")]);
			tab = await h.open("v1");
			await tab.page.activate();
			panel = await openSidePanel(h);
			address = await connectAi(panel, relay.url);
			client = await mcpClient(relay.store, address);
		}, 60_000);

		afterAll(async () => {
			await client?.close();
			await h?.stop();
			await relay.stop();
		});

		test("a question with the side panel of the window in front open: there, and no notification", async () => {
			// Every notification the worker makes, also one cleared at once.
			const w = await worker(h);
			await w.eval(`(() => {
				globalThis.e2eCreated = [];
				const create = chrome.notifications.create.bind(chrome.notifications);
				chrome.notifications.create = (...args) => {
					globalThis.e2eCreated.push(args[0]);
					return create(...args);
				};
			})()`);
			const asked = call("set_verdict", { caseId: "c_1", verdict: "Panel" });
			await panel.waitFor(`document.querySelector("[data-question]")`, 10_000);
			expect(await badge()).toBe("?");
			// It names the case, and offers no "Always allow" (DEC-008).
			const text = await panel.eval<string>(
				`document.querySelector("[data-question]").textContent`,
			);
			expect(text).toContain("Case: “");
			expect(
				await panel.eval<string[]>(
					`[...document.querySelectorAll("[data-question] button")].map((b) => b.textContent)`,
				),
			).toEqual(["Don't allow", "Allow"]);
			await answerInPanel(panel, "allow");
			expect((await asked).isError).toBeFalsy();
			expect(await verdictOf(h, "c_1")).toBe("Panel");
			expect(await badge()).toBe("on");
			expect(await w.eval("globalThis.e2eCreated")).toEqual([]);
			await panel.waitFor(`!document.querySelector("[data-question]")`);
		});

		test("a panel closed during a question hands it to a notification", async () => {
			const asked = call("set_verdict", { caseId: "c_1", verdict: "Handed" });
			await panel.waitFor(`document.querySelector("[data-question]")`, 10_000);
			await closeSidePanel(h, panel);
			const id = await newNotification(h);
			// After the guard against an Allow that came too soon.
			await Bun.sleep(600);
			await clickNotification(h, id, 1);
			expect((await asked).isError).toBeFalsy();
			expect(await verdictOf(h, "c_1")).toBe("Handed");
			// Answered: the notification is gone.
			expect(await notifications(h)).toEqual([]);
		});

		test("with the side panel closed the AI app still calls the tools", async () => {
			const result = await call("list_cases");
			expect(result.isError).toBeFalsy();
			expect(result.content[0]?.text).toContain("c_1");
			expect(await badge()).toBe("on");
		});

		test("Blur form fields, changed while connected, holds for the next screenshot", async () => {
			const w = await worker(h);
			// What the tools ask the page to blur.
			await w.eval(`(() => {
				globalThis.e2eBlur = [];
				const send = chrome.tabs.sendMessage.bind(chrome.tabs);
				chrome.tabs.sendMessage = (tabId, message, ...rest) => {
					if (message?.type === "page:blur") globalThis.e2eBlur.push(message.blurForms);
					return send(tabId, message, ...rest);
				};
			})()`);
			await tab.page.activate();
			const blurBox = byId("blur-forms");
			const set = async (on: boolean) => {
				await h.control.waitFor(`${blurBox}.checked !== undefined`);
				if ((await h.control.eval<boolean>(`${blurBox}.checked`)) !== on)
					await h.control.eval(`${blurBox}.click()`);
				await h.control.waitFor(
					`chrome.storage.local.get("blurForms").then((s) => s.blurForms === ${on})`,
				);
			};
			/** What the page was asked to blur for one screenshot. */
			const blurOfCapture = async () => {
				await w.eval("globalThis.e2eBlur = []");
				expect((await call("capture")).isError).toBeFalsy();
				return [...new Set(await w.eval<boolean[]>("globalThis.e2eBlur"))];
			};
			for (const on of [true, false, true]) {
				await set(on);
				expect(await blurOfCapture()).toEqual([on]);
			}
			await set(false);
		});

		test("with the side panel closed a question is a notification: Don't allow, Allow, late clicks", async () => {
			const denied = call("set_verdict", { caseId: "c_1", verdict: "No" });
			const first = await newNotification(h);
			expect(await badge()).toBe("?");
			await clickNotification(h, first, 0);
			expect((await denied).isError).toBe(true);
			expect(await verdictOf(h, "c_1")).toBe("Handed");
			// A click on a notification whose call is settled answers nothing.
			const allowed = call("set_verdict", { caseId: "c_1", verdict: "Yes" });
			const second = await newNotification(h, [first]);
			await Bun.sleep(600);
			await clickNotification(h, first, 1);
			await Bun.sleep(200);
			expect(await notifications(h)).toEqual([second]);
			await clickNotification(h, second, 1);
			expect((await allowed).isError).toBeFalsy();
			expect(await verdictOf(h, "c_1")).toBe("Yes");
		});

		test("reopening the side panel shows the same connection and the last call", async () => {
			panel = await openSidePanel(h);
			await panel.waitFor(
				`document.documentElement.dataset.aiState === "connected"`,
			);
			expect(
				await panel.eval<string>(`${byId("ai-call")}.textContent`),
			).toContain("Last AI call: Record the verdict");
			expect(await panel.eval(`${byId("relay")}.value`)).toBe(relay.url);
			expect(await panel.eval(`${byId("stop-ai")}.hidden`)).toBe(false);
			await panel.eval(`${byId("ai-button")}.click()`);
			await panel.waitFor(
				`${byId("pair-address")}.textContent === ${JSON.stringify(address)}`,
			);
			await panel.eval(`${byId("pair-close")}.click()`);
		});

		test("the worker stopped by Chrome connects again by itself, with the same address", async () => {
			const { targetId } = await h.browser.waitForTarget(
				(t) =>
					t.type === "service_worker" &&
					t.url === `chrome-extension://${h.extensionId}/background.js`,
			);
			await (await worker(h)).eval("globalThis.e2eBefore = true");
			await h.browser.send("Target.closeTarget", { targetId });
			await Bun.sleep(500);
			// The side panel's port wakes it again, as the alarm would.
			const end = Date.now() + 20_000;
			for (;;) {
				const result = await call("list_cases").catch(() => undefined);
				if (result !== undefined && !result.isError) break;
				if (Date.now() > end) throw new Error("the address did not answer");
				await Bun.sleep(250);
			}
			// A new worker, not the old one.
			expect(
				await (await worker(h)).eval("globalThis.e2eBefore ?? false"),
			).toBe(false);
		}, 40_000);

		test("Stop AI access ends the session, keeps the pairing and turns Keep AI access off", async () => {
			await panel.eval(`${byId("stop-ai")}.click()`);
			await panel.waitFor(
				`document.documentElement.dataset.aiState === "disconnected"`,
			);
			await panel.waitFor(
				`${byId("ai-status")}.textContent === "Not connected"`,
			);
			expect(relay.relay.sessionCount).toBe(0);
			expect(
				await (await worker(h)).eval(
					`chrome.storage.local.get("keepAiOn").then((s) => s.keepAiOn)`,
				),
			).toBe(false);
			expect(await badge()).toBe("");
			// The pairing is still there: the same token works after a connect.
			await panel.eval(`${byId("connect")}.click()`);
			await panel.waitFor(
				`document.documentElement.dataset.aiState === "connected"`,
				10_000,
			);
			expect((await call("list_cases")).isError).toBeFalsy();
		});
	},
);

describe.skipIf(browserBinary === undefined)("who may command it", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startHarness(browserBinary as string);
	}, 60_000);

	afterAll(async () => {
		await h?.stop();
	});

	/** What a port named like the panel's gets: `"closed"` once the worker closed it, else its first message. */
	const PROBE = `new Promise((resolve) => {
		const port = chrome.runtime.connect({ name: "ai" });
		port.onMessage.addListener((m) => resolve(m.type));
		port.onDisconnect.addListener(() => resolve("closed"));
		port.postMessage({ type: "keep-on", on: true });
		port.postMessage({ type: "connect" });
		setTimeout(() => resolve("open"), 3000);
	})`;

	test("a content script's port is closed at once and changes nothing", async () => {
		const { tabId } = await h.open("v1");
		const answer = await h.control.eval<string>(
			`chrome.scripting.executeScript({
				target: { tabId: ${tabId} },
				func: () => ${PROBE},
			}).then(([injected]) => injected.result)`,
		);
		expect(answer).toBe("closed");
		const w = await worker(h);
		expect(
			await w.eval(
				`chrome.storage.local.get("keepAiOn").then((s) => s.keepAiOn ?? null)`,
			),
		).toBeNull();
		// The settings and the secret are neither readable nor writable there.
		const tried = await h.control.eval<string[]>(
			`chrome.scripting.executeScript({
				target: { tabId: ${tabId} },
				func: () => Promise.all([
					chrome.storage.local.get(null).then(() => "read", (e) => e.message),
					chrome.storage.local.set({ keepAiOn: true }).then(() => "written", (e) => e.message),
				]),
			}).then(([injected]) => injected.result)`,
		);
		expect(tried).toEqual([
			"Access to storage is not allowed from this context.",
			"Access to storage is not allowed from this context.",
		]);
		expect(
			await w.eval(
				`chrome.storage.local.get("keepAiOn").then((s) => s.keepAiOn ?? null)`,
			),
		).toBeNull();
	});

	test("the panel's page in a tab is no side panel: closed too, and its AI buttons are off", async () => {
		expect(await h.control.eval<string>(PROBE)).toBe("closed");
		await h.control.waitFor(`${byId("connect")}.disabled`);
		expect(await h.control.eval(`${byId("ai-status")}.textContent`)).toContain(
			"side panel",
		);
	});

	test("the side panel's port gets the state", async () => {
		await (await h.open("v1")).page.activate();
		const panel = await openSidePanel(h);
		expect(
			await panel.eval<string>(`new Promise((resolve) => {
				const port = chrome.runtime.connect({ name: "ai" });
				port.onMessage.addListener((m) => resolve(m.type));
				port.onDisconnect.addListener(() => resolve("closed"));
			})`),
		).toBe("state");
	});
});

describe.skipIf(browserBinary === undefined)(
	"the address the panel had",
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

		test("the side panel hands its localStorage secret and settings to the worker once", async () => {
			// The address of a secret the panel kept before this version.
			const secret = "Q".repeat(43);
			const key = `tab-mcp:secret:${relay.url}:overmark`;
			const before = new TabMcp({
				relay: relay.url,
				server: { name: "overmark", version: "1.0.0" },
				storage: { getItem: (k) => (k === key ? secret : null), setItem() {} },
			});
			const { address } = await before.connect({ resume: true });
			before.disconnect();
			await h.control.eval(`(() => {
			localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(secret)});
			localStorage.setItem("overmark:relay", ${JSON.stringify(relay.url)});
			localStorage.setItem("overmark:keep-ai-on", "true");
			localStorage.setItem("overmark:blur-forms", "true");
		})()`);
			await (await h.open("v1")).page.activate();
			const panel = await openSidePanel(h);
			// Keep AI access on: it connects by itself, with the old address.
			await panel.waitFor(
				`document.documentElement.dataset.aiState === "connected"`,
				10_000,
			);
			await panel.eval(`${byId("ai-button")}.click()`);
			await panel.waitFor(
				`${byId("pair-address")}.textContent === ${JSON.stringify(address)}`,
			);
			expect(await panel.eval(`${byId("keep-on")}.checked`)).toBe(true);
			expect(await panel.eval(`${byId("blur-forms")}.checked`)).toBe(true);
			// Taken over: the panel keeps nothing of it any more.
			await panel.waitFor(`localStorage.length === 0`);
			const client = await mcpClient(relay.store, address);
			try {
				expect(
					(
						(await client.callTool({
							name: "list_cases",
							arguments: {},
						})) as CallResult
					).isError,
				).toBeFalsy();
			} finally {
				await client.close();
			}
			// Only once: what a panel sends later changes nothing.
			await panel.eval(`(() => {
			const port = chrome.runtime.connect({ name: "ai" });
			port.postMessage({ type: "migrate", keepOn: false, secrets: {} });
		})()`);
			await Bun.sleep(300);
			expect(
				await (await worker(h)).eval(
					`chrome.storage.local.get("keepAiOn").then((s) => s.keepAiOn)`,
				),
			).toBe(true);
		}, 60_000);
	},
);
