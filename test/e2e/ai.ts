/**
 * The AI connection in the end-to-end tests: the real side panel (the worker
 * talks only to it, DEC-015), connecting it to a test relay, an MCP client
 * as the AI app, and the worker's notifications.
 */

import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { tokenFor } from "@ractive-ch/tab-mcp/testing";
import type { Page } from "./browser.ts";
import type { Harness } from "./harness.ts";
import { worker } from "./steps.ts";

const PANEL = "/sidepanel/index.html";

export const byId = (name: string) =>
	`document.getElementById(${JSON.stringify(name)})`;

/** Pages at the panel's address, but the control page. */
async function panelPages(h: Harness): Promise<string[]> {
	const url = `chrome-extension://${h.extensionId}${PANEL}`;
	return (await h.browser.targets())
		.filter(
			(t) =>
				t.type === "page" && t.url === url && t.targetId !== h.control.targetId,
		)
		.map((t) => t.targetId);
}

/**
 * Open the side panel of the window in front, as a click on the icon does
 * (`sidePanel.open` with the DevTools Protocol's user gesture), once its
 * page has the worker's state.
 */
export async function openSidePanel(h: Harness): Promise<Page> {
	const before = new Set(await panelPages(h));
	const opened = (await h.control.send("Runtime.evaluate", {
		expression: `chrome.windows.getLastFocused({ windowTypes: ["normal"] }).then((w) => chrome.sidePanel.open({ windowId: w.id })).then(() => "", (e) => String(e))`,
		awaitPromise: true,
		returnByValue: true,
		userGesture: true,
	})) as { result: { value?: string } };
	if (opened.result.value) throw new Error(opened.result.value);
	const end = Date.now() + 10_000;
	const attached = new Map<string, Page>();
	for (;;) {
		for (const id of await panelPages(h)) {
			if (before.has(id)) continue;
			const page = attached.get(id) ?? (await h.browser.attachPage(id));
			attached.set(id, page);
			// The panel's page in a tab is no side panel. Under load the page
			// can be attached before its document has the extension's APIs:
			// asked again on the next round.
			const side = await page
				.eval<boolean>("chrome.tabs.getCurrent().then((t) => t === undefined)")
				.catch(() => undefined);
			if (side === undefined) continue;
			if (side) {
				await page.waitFor(`document.documentElement.dataset.aiState`, 10_000);
				return page;
			}
			before.add(id);
		}
		if (Date.now() > end) throw new Error("the side panel did not open");
		await Bun.sleep(50);
	}
}

/** Close the side panel of the window in front, as the user would. */
export async function closeSidePanel(h: Harness, panel: Page): Promise<void> {
	await h.control.eval(
		`chrome.windows.getLastFocused({ windowTypes: ["normal"] }).then((w) => chrome.sidePanel.close({ windowId: w.id }))`,
	);
	const end = Date.now() + 10_000;
	for (;;) {
		if (!(await panelPages(h)).includes(panel.targetId)) return;
		if (Date.now() > end) throw new Error("the side panel stayed open");
		await Bun.sleep(50);
	}
}

/** Set the relay in the panel's field, as typing it and leaving the field does. */
export async function setRelay(panel: Page, relay: string): Promise<void> {
	await panel.eval(
		`(() => { const r = ${byId("relay")}; r.value = ${JSON.stringify(relay)}; r.dispatchEvent(new Event("change")); })()`,
	);
	await panel.waitFor(`${byId("relay")}.value === ${JSON.stringify(relay)}`);
}

/**
 * Connect the panel to `relay` (optionally with "Keep AI access on") and
 * return the address the card shows: at once, with no AI app paired yet.
 */
export async function connectAi(
	panel: Page,
	relay: string,
	options: { keepOn?: boolean } = {},
): Promise<string> {
	await setRelay(panel, relay);
	if (options.keepOn)
		await panel.eval(
			`${byId("keep-on")}.checked || ${byId("keep-on")}.click()`,
		);
	// "Turn on AI access", unless Keep AI access on turned it on already.
	await panel.eval(`${byId("connect")}.hidden || ${byId("connect")}.click()`);
	await panel.waitFor(
		`${byId("pair-address")}.textContent.startsWith(${JSON.stringify(relay)}) && ${byId("pair-address")}.textContent.endsWith("/mcp")`,
		10_000,
	);
	return panel.eval<string>(`${byId("pair-address")}.textContent`);
}

/** An MCP client paired with `address` (a token straight from the relay's store). */
export async function mcpClient(
	store: Parameters<typeof tokenFor>[0],
	address: string,
): Promise<Client> {
	const token = await tokenFor(store, address);
	const client = new Client(
		{ name: "e2e", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	await client.connect(
		new StreamableHTTPClientTransport(new URL(address), {
			requestInit: { headers: { Authorization: `Bearer ${token}` } },
		}),
	);
	return client;
}

/** The worker's notifications now. */
export async function notifications(h: Harness): Promise<string[]> {
	const w = await worker(h);
	return Object.keys(
		await w.eval<Record<string, unknown>>("chrome.notifications.getAll()"),
	);
}

/** The first notification not in `seen`, once there is one. */
export async function newNotification(
	h: Harness,
	seen: string[] = [],
): Promise<string> {
	const end = Date.now() + 10_000;
	for (;;) {
		const id = (await notifications(h)).find((n) => !seen.includes(n));
		if (id !== undefined) return id;
		if (Date.now() > end) throw new Error("no notification came");
		await Bun.sleep(100);
	}
}

/**
 * A click on a notification's button (0 Allow, 1 Always allow): the worker's
 * own handler, which the DevTools Protocol can call; it cannot click one.
 */
export async function clickNotification(
	h: Harness,
	id: string,
	index: number,
): Promise<void> {
	const w = await worker(h);
	await w.eval(`overmarkNotificationButton(${JSON.stringify(id)}, ${index})`);
}

/**
 * Closing a notification, or a click on its body: Don't allow. The worker's
 * own handler, as for `clickNotification`.
 */
export async function dismissNotification(
	h: Harness,
	id: string,
): Promise<void> {
	const w = await worker(h);
	await w.eval(`overmarkNotificationDismissed(${JSON.stringify(id)})`);
}

/** Answer the panel's oldest question, once its Allow (or Always allow) counts. */
export async function answerInPanel(
	panel: Page,
	answer: "allow" | "deny" | "always",
): Promise<void> {
	await panel.send("Emulation.setFocusEmulationEnabled", { enabled: true });
	const button = `document.querySelector('[data-question] button[data-answer="${answer}"]')`;
	await panel.waitFor(`${button} && !${button}.disabled`, 10_000);
	await panel.eval(`${button}.click()`);
}
