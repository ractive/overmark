/**
 * End to end: the AI connection in the service worker (DEC-015). It stays
 * while the side panel is closed; a question shows in the side panel of the
 * window in front, or else as a Chrome notification (answered through the
 * worker's own button handler); only the side panel's own page may command
 * the connection; the panel's old address is kept, and so is the one the
 * build before kept in chrome.storage.local (DEC-016); what is written there
 * later is not taken.
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
	dismissNotification,
	mcpClient,
	newNotification,
	notifications,
	openSidePanel,
} from "./ai.ts";
import type { Page } from "./browser.ts";
import { browserBinary, type Harness, startHarness } from "./harness.ts";
import {
	KV,
	READ_DB,
	restartWorker,
	settingsOf,
	until,
	worker,
} from "./steps.ts";

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
		const title = async () =>
			(await worker(h)).eval<string>("chrome.action.getTitle({})");
		/** The icon the worker last set: drawn and set without an error. */
		const icon = async () => {
			const w = await worker(h);
			for (let i = 0; i < 50; i++) {
				const shown = await w.eval<string | null>(
					"globalThis.overmarkIcon ?? null",
				);
				if (shown === "spark") return shown;
				await Bun.sleep(100);
			}
			return w.eval<string | null>("globalThis.overmarkIcon ?? null");
		};

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
			const asked = call("set_summary", { caseId: "c_1", summary: "Panel" });
			await panel.waitFor(`document.querySelector("[data-question]")`, 10_000);
			expect(await badge()).toBe("?");
			// It names the case, and offers Always allow (DEC-018).
			const text = await panel.eval<string>(
				`document.querySelector("[data-question]").textContent`,
			);
			expect(text).toContain("Case: “");
			expect(
				await panel.eval<string[]>(
					`[...document.querySelectorAll("[data-question] button")].map((b) => b.textContent)`,
				),
			).toEqual(["Don't allow", "Allow", "Always allow"]);
			await answerInPanel(panel, "allow");
			expect((await asked).isError).toBeFalsy();
			expect(await verdictOf(h, "c_1")).toBe("Panel");
			expect(await badge()).toBe("");
			expect(await title()).toBe("Overmark: AI access is on");
			expect(await icon()).toBe("spark");
			expect(await w.eval("globalThis.e2eCreated")).toEqual([]);
			await panel.waitFor(`!document.querySelector("[data-question]")`);
		});

		test("a long summary shows whole in the panel's question, scrolling (CR-03)", async () => {
			const summary = `${"Harmless. ".repeat(400)}${"Unseen before. ".repeat(1000)}END-OF-SUMMARY`;
			const asked = call("set_summary", { caseId: "c_1", summary });
			// The note follows the box's layout.
			await panel.waitFor(
				`document.querySelector("[data-question] [data-scroll-note]")?.textContent`,
				10_000,
			);
			const shown = await panel.eval<{
				text: string;
				meta: string;
				scrolls: boolean;
			}>(`(() => {
				const card = document.querySelector("[data-question]");
				const pre = card.querySelector("pre");
				return {
					text: pre.textContent,
					meta: [...card.querySelectorAll("p.meta")].map((p) => p.textContent).join(" "),
					scrolls: pre.scrollHeight > pre.clientHeight,
				};
			})()`);
			expect(shown.text).toContain(summary);
			expect(shown.text.endsWith('END-OF-SUMMARY"\n}')).toBe(true);
			expect(shown.scrolls).toBe(true);
			expect(shown.meta).toContain(
				`(${shown.text.length.toLocaleString("en-US")} characters: scroll to read all of them)`,
			);
			await answerInPanel(panel, "deny");
			expect((await asked).isError).toBe(true);
			await panel.waitFor(`!document.querySelector("[data-question]")`);
		});

		test("the scroll note goes by whether the box overflows, not by a length", async () => {
			const width = (w: number) =>
				panel.send("Emulation.setDeviceMetricsOverride", {
					width: w,
					height: 800,
					deviceScaleFactor: 1,
					mobile: false,
				});
			/** The note and the box once the layout has settled. */
			const box = async () => {
				await panel.eval(
					"new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
				);
				return panel.eval<{ note: string; scrolls: boolean }>(`(() => {
					const card = document.querySelector("[data-question]");
					const pre = card.querySelector("pre");
					return {
						note: card.querySelector("[data-scroll-note]")?.textContent ?? "",
						scrolls: pre.scrollHeight > pre.clientHeight,
					};
				})()`);
			};
			/** Ask, and wait for the question in the panel. */
			const ask = async (summary: string) => {
				const asked = call("set_summary", { caseId: "c_1", summary });
				await panel.waitFor(
					`document.querySelector("[data-question] pre")`,
					10_000,
				);
				return { asked };
			};
			const deny = async ({ asked }: { asked: Promise<unknown> }) => {
				await answerInPanel(panel, "deny");
				await asked;
				await panel.waitFor(`!document.querySelector("[data-question]")`);
			};
			try {
				// The side panel's width: about 500 characters do not fit the box.
				await width(380);
				const middle = await ask(
					"Lower the contrast of the button. ".repeat(15),
				);
				const narrow = await box();
				expect(narrow.scrolls).toBe(true);
				expect(narrow.note).toContain(
					"characters: scroll to read all of them)",
				);
				// Wider, the same text fits: the note goes.
				await width(2400);
				const wide = await box();
				expect(wide.scrolls).toBe(false);
				expect(wide.note).toBe("");
				await deny(middle);
				await width(380);
				const short = await ask("Fine.");
				expect(await box()).toEqual({ note: "", scrolls: false });
				await deny(short);
			} finally {
				await panel.send("Emulation.clearDeviceMetricsOverride");
			}
		});

		test("a panel closed during a question hands it to a notification", async () => {
			const asked = call("set_summary", { caseId: "c_1", summary: "Handed" });
			await panel.waitFor(`document.querySelector("[data-question]")`, 10_000);
			await closeSidePanel(h, panel);
			const id = await newNotification(h);
			// After the guard against an Allow that came too soon.
			await Bun.sleep(600);
			await clickNotification(h, id, 0);
			expect((await asked).isError).toBeFalsy();
			expect(await verdictOf(h, "c_1")).toBe("Handed");
			// Answered: the notification is gone.
			expect(await notifications(h)).toEqual([]);
		});

		test("with the side panel closed the AI app still calls the tools", async () => {
			const result = await call("list_cases");
			expect(result.isError).toBeFalsy();
			expect(result.content[0]?.text).toContain("c_1");
			expect(await badge()).toBe("");
			expect(await title()).toBe("Overmark: AI access is on");
			expect(await icon()).toBe("spark");
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
			// The box is the side panel's: it sends the change over its port.
			const side = await openSidePanel(h);
			const blurBox = byId("blur-forms");
			const set = async (on: boolean) => {
				if ((await side.eval<boolean>(`${blurBox}.checked`)) !== on)
					await side.eval(`${blurBox}.click()`);
				await until(
					() => settingsOf(h),
					(kv) => kv["blurForms"] === on,
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
			await closeSidePanel(h, side);
		});

		test("with the side panel closed a question is a notification: closing it is Don't allow, Allow, late clicks", async () => {
			const denied = call("set_summary", { caseId: "c_1", summary: "No" });
			const first = await newNotification(h);
			expect(await badge()).toBe("?");
			await dismissNotification(h, first);
			expect((await denied).isError).toBe(true);
			expect(await verdictOf(h, "c_1")).toBe("Handed");
			// A click on a notification whose call is settled answers nothing.
			const allowed = call("set_summary", { caseId: "c_1", summary: "Yes" });
			const second = await newNotification(h, [first]);
			await Bun.sleep(600);
			await clickNotification(h, first, 0);
			await Bun.sleep(200);
			expect(await notifications(h)).toEqual([second]);
			await clickNotification(h, second, 0);
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
			).toContain("Last AI call: Record the summary for the developer");
			expect(await panel.eval(`${byId("relay")}.value`)).toBe(relay.url);
			expect(await panel.eval(`${byId("stop-ai")}.hidden`)).toBe(false);
			// The same address: shown with the code at once with no app paired
			// (the relay lists it), else after "+ Add another AI app".
			const state = `${byId("ai-state")}.dataset.state`;
			await panel.waitFor(`["on", "waiting"].includes(${state})`);
			const paired = (await panel.eval<string>(state)) === "on";
			if (paired) {
				expect(await panel.eval(`${byId("pairing")}.hidden`)).toBe(true);
				await panel.eval(`${byId("add-app")}.click()`);
			}
			await panel.waitFor(
				`${byId("pair-address")}.textContent === ${JSON.stringify(address)}`,
			);
			// "How do I add it?" under it, collapsed, with the steps for this address.
			expect(
				await panel.eval(
					`[${byId("setup")}.hidden, ${byId("setup")}.open, ${byId("setup-steps")}.children.length]`,
				),
			).toEqual([false, false, 4]);
			expect(
				await panel.eval<string>(
					`${byId("setup-steps")}.querySelector('li[data-app="claude-code"] pre').textContent`,
				),
			).toBe(`claude mcp add --transport http overmark ${address}`);
			if (paired) {
				await panel.eval(`${byId("pair-done")}.click()`);
				expect(await panel.eval(`${byId("pairing")}.hidden`)).toBe(true);
			}
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
			expect((await settingsOf(h))["keepAiOn"]).toBe(false);
			expect(await badge()).toBe("");
			// The pairing is still there: the same token works after a connect.
			await panel.eval(`${byId("connect")}.click()`);
			await panel.waitFor(
				`document.documentElement.dataset.aiState === "connected"`,
				10_000,
			);
			expect((await call("list_cases")).isError).toBeFalsy();
		});

		test("a side panel covered by another extension's panel hands its questions to notifications", async () => {
			/**
			 * What Chrome does when another extension's panel for the tab (Claude
			 * in Chrome's) covers ours: the page stays open, hidden.
			 */
			const cover = (hidden: boolean) =>
				panel.eval(`(() => {
					Object.defineProperty(document, "visibilityState", {
						configurable: true,
						get: () => ${JSON.stringify(hidden ? "hidden" : "visible")},
					});
					document.dispatchEvent(new Event("visibilitychange"));
				})()`);
			// Asked while our panel is on screen: there, no notification.
			const first = call("set_summary", { caseId: "c_1", summary: "Covered" });
			await panel.waitFor(`document.querySelector("[data-question]")`, 10_000);
			expect(await notifications(h)).toEqual([]);
			await cover(true);
			const handed = await newNotification(h);
			await Bun.sleep(600);
			await clickNotification(h, handed, 0);
			expect((await first).isError).toBeFalsy();
			expect(await verdictOf(h, "c_1")).toBe("Covered");
			// Asked while covered: a notification at once.
			const second = call("set_summary", { caseId: "c_1", summary: "Hidden" });
			const asked = await newNotification(h, [handed]);
			await Bun.sleep(600);
			await clickNotification(h, asked, 0);
			expect((await second).isError).toBeFalsy();
			// On screen again: the panel asks, no notification.
			await cover(false);
			const third = call("set_summary", { caseId: "c_1", summary: "Shown" });
			await panel.waitFor(`document.querySelector("[data-question]")`, 10_000);
			expect(await notifications(h)).toEqual([]);
			await answerInPanel(panel, "allow");
			expect((await third).isError).toBeFalsy();
		});

		test("after a takeover, New address in the notice drops the address taken over", async () => {
			const key = `tab-mcp:secret:${relay.url}:overmark`;
			const secret = (await settingsOf(h))[key];
			expect(typeof secret).toBe("string");
			// Another program with a copy of the address secret takes it over.
			const other = new TabMcp({
				relay: relay.url,
				server: { name: "overmark", version: "1.0.0" },
				storage: {
					getItem: (k) => (k === key ? (secret as string) : null),
					setItem() {},
				},
			});
			const { address: taken } = await other.connect({ resume: true });
			try {
				expect(taken).toBe(address);
				await panel.waitFor(`!${byId("pair-replaced")}.hidden`, 10_000);
				// AI access is off: the code is hidden, the notice has the button.
				expect(await panel.eval(`${byId("pairing")}.hidden`)).toBe(true);
				const button = byId("pair-replaced-new-address");
				await panel.eval(`${button}.click()`);
				// With apps listed it asks first.
				if (
					(await panel.eval<string>(`${button}.textContent`)) !== "New address"
				) {
					await Bun.sleep(100);
					await panel.eval(`${button}.click()`);
				}
				await panel.waitFor(
					`${byId("pair-replaced")}.hidden && ${byId("pair-address")}.textContent.endsWith("/mcp") && ${byId("pair-address")}.textContent !== ${JSON.stringify(address)}`,
					10_000,
				);
			} finally {
				other.disconnect();
			}
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
		expect((await settingsOf(h))["keepAiOn"]).toBeUndefined();
		// chrome.storage.local is closed to content scripts where Chrome can
		// (best effort, DEC-016); nothing of the AI connection is kept there.
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
		expect((await settingsOf(h))["keepAiOn"]).toBeUndefined();
	});

	test("the panel's page in a tab is no side panel: closed too, and its AI buttons are off", async () => {
		expect(await h.control.eval<string>(PROBE)).toBe("closed");
		await h.control.waitFor(`${byId("connect")}.disabled`);
		// Nor can it change Blur form fields: that goes over the port too.
		expect(await h.control.eval(`${byId("blur-forms")}.disabled`)).toBe(true);
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
		let panel: Page;
		let address: string;
		const relay = startTestRelay();
		// A secret the panel kept before the connection moved into the worker.
		const secret = "Q".repeat(43);
		const key = () => `tab-mcp:secret:${relay.url}:overmark`;
		/** What the panel kept in its localStorage. */
		const OLD_PANEL = () => `(() => {
			localStorage.setItem(${JSON.stringify(key())}, ${JSON.stringify(secret)});
			localStorage.setItem("overmark:relay", ${JSON.stringify(relay.url)});
			localStorage.setItem("overmark:keep-ai-on", "true");
			localStorage.setItem("overmark:blur-forms", "true");
		})()`;

		beforeAll(async () => {
			h = await startHarness(browserBinary as string);
		}, 60_000);

		afterAll(async () => {
			await h?.stop();
			await relay.stop();
		});

		const answers = async () => {
			const client = await mcpClient(relay.store, address);
			try {
				return !(
					(await client.callTool({
						name: "list_cases",
						arguments: {},
					})) as CallResult
				).isError;
			} finally {
				await client.close();
			}
		};

		test("the side panel hands its localStorage secret and settings to the worker once", async () => {
			const key_ = key();
			const before = new TabMcp({
				relay: relay.url,
				server: { name: "overmark", version: "1.0.0" },
				storage: {
					getItem: (k) => (k === key_ ? secret : null),
					setItem() {},
				},
			});
			({ address } = await before.connect({ resume: true }));
			before.disconnect();
			await h.control.eval(OLD_PANEL());
			await (await h.open("v1")).page.activate();
			panel = await openSidePanel(h);
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
			expect((await settingsOf(h))["keepAiOn"]).toBe(true);
		}, 60_000);

		test("a handover cut short before its settings were written runs again, whole", async () => {
			// As a crash right after the secret's write left it: the secret, no
			// settings, no marker; the panel still has its copy.
			await h.control.eval(
				KV(
					`for (const k of ["panelHandedOver", "keepAiOn", "relay", "blurForms"]) store.delete(k)`,
					"readwrite",
				),
			);
			const settingKeys = (kv: Record<string, unknown>) =>
				Object.keys(kv).filter((k) => !k.startsWith("tab-mcp:secret:"));
			const left = await settingsOf(h);
			expect(settingKeys(left)).toEqual([]);
			expect(left[key()]).toBe(secret);
			await panel.eval(OLD_PANEL());
			// The next worker start: the panel's port connects again and hands over.
			await restartWorker(h);
			await until(
				() => settingsOf(h),
				(kv) => kv["panelHandedOver"] === true,
				10_000,
			);
			const after = await settingsOf(h);
			expect(after[key()]).toBe(secret);
			expect(
				Object.fromEntries(settingKeys(after).map((k) => [k, after[k]])),
			).toEqual({
				relay: relay.url,
				keepAiOn: true,
				blurForms: true,
				panelHandedOver: true,
			});
			await panel.waitFor(`localStorage.length === 0`);
			// Keep AI access on again: the same address answers.
			await until(
				() => answers().catch(() => false),
				(ok) => ok,
				20_000,
			);
		}, 60_000);
	},
);

describe.skipIf(browserBinary === undefined)(
	"what an unreleased build kept in chrome.storage.local",
	() => {
		let h: Harness;
		let address: string;
		const relay = startTestRelay();

		beforeAll(async () => {
			h = await startHarness(browserBinary as string);
			await (await h.open("v1")).page.activate();
			const panel = await openSidePanel(h);
			address = await connectAi(panel, relay.url, { keepOn: true });
			await closeSidePanel(h, panel);
		}, 60_000);

		afterAll(async () => {
			await h?.stop();
			await relay.stop();
		});

		// In the control page, an extension page too: a session on the worker
		// would keep Chrome from stopping it.
		const localAll = () =>
			h.control.eval<Record<string, unknown>>("chrome.storage.local.get(null)");

		test("is removed at the next start and never taken over: the relay and the address stay", async () => {
			const before = await settingsOf(h);
			expect(before["relay"]).toBe(relay.url);
			// overmark#26's layout (only the owner's build wrote it), here with a
			// relay and a secret of someone else's, as a content script could.
			const old = {
				"tab-mcp:secret:https://evil.example:overmark": "E".repeat(43),
				relay: "https://evil.example",
				keepAiOn: false,
				blurForms: true,
				replaced: { sibling: true },
				migrated: true,
			};
			// From a content script: Chrome refuses it where it closes the area.
			const { tabId } = await h.open("v1");
			await h.control.eval(
				`chrome.scripting.executeScript({
					target: { tabId: ${tabId} },
					func: (items) => chrome.storage.local.set(items).then(() => "written", (e) => e.message),
					args: [${JSON.stringify(old)}],
				})`,
			);
			// And as one could where Chrome lets it: written there all the same.
			await h.control.eval(`chrome.storage.local.set(${JSON.stringify(old)})`);
			await restartWorker(h);
			// The new worker only removes it from there.
			await until(localAll, (local) => Object.keys(local).length === 0, 10_000);
			expect(await settingsOf(h)).toEqual(before);
			// Keep AI access on: the same address answers, on the same relay.
			await until(
				async () => {
					const client = await mcpClient(relay.store, address).catch(
						() => undefined,
					);
					if (client === undefined) return false;
					try {
						return !(
							(await client.callTool({
								name: "list_cases",
								arguments: {},
							})) as CallResult
						).isError;
					} catch {
						return false;
					} finally {
						await client.close();
					}
				},
				(ok) => ok,
				20_000,
			);
			await (await h.open("v1")).page.activate();
			const panel = await openSidePanel(h);
			expect(await panel.eval(`${byId("relay")}.value`)).toBe(relay.url);
			expect(await panel.eval(`${byId("blur-forms")}.checked`)).toBe(false);
			await closeSidePanel(h, panel);
		}, 60_000);

		test("a Stop in this browser session holds over a stored Keep AI access on, in a new worker too", async () => {
			// What a Stop whose write of Keep AI access on failed leaves behind.
			expect((await settingsOf(h))["keepAiOn"]).toBe(true);
			await h.control.eval(`chrome.storage.session.set({ aiStopped: true })`);
			await restartWorker(h);
			await (await h.open("v1")).page.activate();
			const panel = await openSidePanel(h);
			const state = () =>
				panel.eval<string>("document.documentElement.dataset.aiState");
			await until(state, (s) => s !== undefined && s !== "", 10_000);
			// Long enough for Keep AI access on to have connected.
			await Bun.sleep(3000);
			expect(await state()).toBe("disconnected");
			expect(await panel.eval(`${byId("keep-on")}.checked`)).toBe(false);
			expect((await settingsOf(h))["keepAiOn"]).toBe(true);
			// The user's Connect ends it.
			await panel.eval(`${byId("connect")}.click()`);
			await panel.waitFor(
				`document.documentElement.dataset.aiState === "connected"`,
				20_000,
			);
			expect(
				await h.control.eval(
					`chrome.storage.session.get("aiStopped").then((s) => s.aiStopped)`,
				),
			).toBe(false);
			await closeSidePanel(h, panel);
		}, 60_000);
	},
);

describe.skipIf(browserBinary === undefined)(
	"Blur form fields for open overlays, and a worker that cannot start",
	() => {
		let h: Harness;

		beforeAll(async () => {
			h = await startHarness(browserBinary as string);
		}, 60_000);

		afterAll(async () => {
			await h?.stop();
		});

		/** In the tab's content-script world: what the extension tells it of these types. */
		const listen = (tabId: number) =>
			h.control.eval(
				`chrome.scripting.executeScript({
					target: { tabId: ${tabId} },
					func: () => {
						globalThis.e2eTold = [];
						chrome.runtime.onMessage.addListener((m) => {
							if (m?.type === "overlay:settings" || m?.type === "overlay:show")
								globalThis.e2eTold.push([m.type, m.blurForms]);
						});
					},
				})`,
			);
		const told = (tabId: number) =>
			h.control.eval<[string, boolean][]>(
				`chrome.scripting.executeScript({
					target: { tabId: ${tabId} },
					func: () => globalThis.e2eTold,
				}).then(([r]) => r.result)`,
			);
		const clear = (tabId: number) =>
			h.control.eval(
				`chrome.scripting.executeScript({
					target: { tabId: ${tabId} },
					func: () => { globalThis.e2eTold = []; },
				})`,
			);

		test("the worker tells open overlays its value when it starts and when a panel attaches", async () => {
			const { page, tabId } = await h.open("v1");
			await listen(tabId);
			// Stored on, as the side panel would have set it.
			await h.control.eval(KV(`store.put(true, "blurForms")`, "readwrite"));
			await restartWorker(h);
			await until(
				() => told(tabId),
				(t) => t.some(([type, on]) => type === "overlay:settings" && on),
				10_000,
			);
			await clear(tabId);
			await page.activate();
			const panel = await openSidePanel(h);
			await until(
				() => told(tabId),
				(t) => t.some(([type, on]) => type === "overlay:settings" && on),
				10_000,
			);
			await closeSidePanel(h, panel);
			await page.send("Page.close");
		}, 60_000);

		test("a worker that cannot start says so in the panel, and an overlay started then blurs", async () => {
			// Stored off; then the database is one the worker cannot open (a
			// newer version). The worker's open connection closes on request,
			// or this upgrade would be blocked.
			await h.control.eval(KV(`store.put(false, "blurForms")`, "readwrite"));
			await h.control.eval(`new Promise((resolve, reject) => {
				const open = indexedDB.open("overmark-settings", 2);
				open.onsuccess = () => { open.result.close(); resolve(true); };
				open.onerror = () => reject(open.error);
				open.onblocked = () => reject(new Error("blocked"));
			})`);
			await restartWorker(h);
			const { page, tabId } = await h.open("v1");
			await listen(tabId);
			await page.activate();
			const panel = await openSidePanel(h);
			await panel.waitFor(
				`document.documentElement.dataset.aiState === "failed"`,
				10_000,
			);
			expect(
				await panel.eval<string>(`${byId("ai-status")}.textContent`),
			).toContain("AI access is not available");
			expect(await panel.eval(`${byId("blur-forms")}.disabled`)).toBe(true);
			expect(await panel.eval(`${byId("connect")}.disabled`)).toBe(true);
			expect(await panel.eval(`${byId("ai-switch")}.disabled`)).toBe(true);
			// Without the worker's value the panel blurs: the safe side.
			await panel.eval(`${byId("annotate")}.click()`);
			await until(
				() => told(tabId),
				(t) => t.some(([type]) => type === "overlay:show"),
				10_000,
			);
			expect(
				(await told(tabId)).filter(([type]) => type === "overlay:show"),
			).toEqual([["overlay:show", true]]);
		}, 60_000);
	},
);
