/**
 * End to end: the sync to a folder (DEC-021). Chrome's folder picker cannot
 * be answered over the DevTools Protocol, so the test build hands the side
 * panel a folder of the extension's private file system (`overmarkUseFolder`)
 * instead, through the same code as after the picker. The service worker
 * writes: a case saved on a page, then changed by an AI app, shows up in the
 * folder as Export's file and is written again; a case deleted in the panel
 * keeps its file; after Stop syncing nothing more is written.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import { startTestRelay } from "@ractive-ch/tab-mcp/testing";
import type { Case } from "../../src/lib/case.ts";
import { readZip } from "../../src/lib/zip.ts";
import { answerInPanel, connectAi, mcpClient, openSidePanel } from "./ai.ts";
import type { Page } from "./browser.ts";
import { browserBinary, type Harness, startHarness } from "./harness.ts";
import {
	type Db,
	markElement,
	panelHome,
	READ_DB,
	saveAs,
	showToolbar,
	until,
} from "./steps.ts";

const FOLDER = "synced";

/** The folder of the private file system, as the panel gets it. */
const FOLDER_HANDLE = `navigator.storage.getDirectory().then((root) => root.getDirectoryHandle(${JSON.stringify(FOLDER)}, { create: true }))`;

/** The folder's files: name and bytes (base64), read in an extension page. */
const LIST_FILES = `${FOLDER_HANDLE}.then(async (dir) => {
	const out = {};
	for await (const [name, entry] of dir.entries()) {
		if (entry.kind !== "file") continue;
		let bytes;
		try {
			bytes = new Uint8Array(await (await entry.getFile()).arrayBuffer());
		} catch {
			// Being written just now: read again.
			out[name] = null;
			continue;
		}
		let text = "";
		for (let i = 0; i < bytes.length; i += 0x8000)
			text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		out[name] = btoa(text);
	}
	return out;
})`;

const FILE = "synced-case.overmark.zip";

const SYNC = `document.getElementById("sync")`;

describe.skipIf(browserBinary === undefined)("the sync to a folder", () => {
	let h: Harness;
	let panel: Page;
	let claude: Client;
	let caseId: string;
	const relay = startTestRelay();

	const files = () => h.control.eval<Record<string, string | null>>(LIST_FILES);
	/** The case in the folder's file `name`, as Import a case… would read it. */
	const zipIn = async (name: string) => {
		const data = (await files())[name];
		if (data === undefined || data === null) return undefined;
		return readZip(Buffer.from(data, "base64"));
	};
	const caseIn = async (name: string): Promise<Case | undefined> => {
		const zip = await zipIn(name);
		return zip && JSON.parse(new TextDecoder().decode(zip.get("case.json")));
	};

	beforeAll(async () => {
		h = await startHarness(browserBinary as string);
		// Not v1: a test's tab is found by its address.
		const tab = await h.open("v2");
		await tab.page.activate();
		panel = await openSidePanel(h);
		await panel.eval(
			`${FOLDER_HANDLE}.then((dir) => window.overmarkUseFolder(dir))`,
		);
		await panel.waitFor(
			`${SYNC}.querySelector(".sync-state")?.textContent === "Syncing to ${FOLDER}"`,
			10_000,
		);
		const address = await connectAi(panel, relay.url);
		claude = await mcpClient(relay.store, address);
	}, 60_000);

	afterAll(async () => {
		await claude?.close();
		await h?.stop();
		await relay.stop();
	});

	test("a case saved on a page is written to the folder as its export", async () => {
		const { page, tabId } = await h.open("v1");
		await showToolbar(h, page, tabId);
		await markElement(page, "[data-truth=submit]", "Too pale");
		await saveAs(page, "Synced case");
		await page.send("Page.close");
		const saved = (await h.control.eval<Db>(READ_DB)).cases.find(
			(c) => c.title === "Synced case",
		);
		if (saved === undefined) throw new Error("not saved");
		caseId = saved.id;
		const written = await until(
			() => caseIn(FILE),
			(c) => c !== undefined,
			15_000,
		);
		expect(written?.id).toBe(caseId);
		const zip = await until(
			() => zipIn(FILE),
			(z) => z !== undefined,
		);
		expect([...(zip?.keys() ?? [])]).toContain("case.md");
		expect([...(zip?.keys() ?? [])]).toContain("crops/a1.webp");
		await panel.waitFor(
			`${SYNC}.querySelector(".sync-line")?.textContent.startsWith("Last synced ")`,
			10_000,
		);
	}, 60_000);

	test("an AI app's change is written again, by the worker", async () => {
		const result = claude.callTool({
			name: "set_summary",
			arguments: { caseId, summary: "Darker button, as agreed" },
		});
		await answerInPanel(panel, "allow");
		expect(((await result) as { isError?: boolean }).isError).toBeFalsy();
		const written = await until(
			() => caseIn(FILE),
			(c) => c?.verdict === "Darker button, as agreed",
			15_000,
		);
		expect(written?.id).toBe(caseId);
	}, 60_000);

	test("a case deleted in the panel keeps its file", async () => {
		const home = await panelHome(h);
		const item = `[...document.querySelectorAll("[data-case]")].find((e) => e.textContent.includes("Synced case"))`;
		await home.click(item);
		await home.waitFor(`document.getElementById("delete-case")`);
		await home.click(`document.getElementById("delete-case")`);
		await home.waitFor(
			`document.getElementById("delete-case")?.textContent === "Really delete?"`,
		);
		await Bun.sleep(600); // a confirming click this soon counts as a double-click
		await home.click(`document.getElementById("delete-case")`);
		await until(
			() => h.control.eval<Db>(READ_DB),
			(db) => db.cases.length === 0,
		);
		// The worker heard of it; the folder keeps the case as it last was.
		await Bun.sleep(1000);
		expect((await caseIn(FILE))?.verdict).toBe("Darker button, as agreed");
	}, 60_000);

	test("after Stop syncing nothing more is written", async () => {
		await panel.waitFor(`${SYNC}.querySelector('[data-action="sync-stop"]')`);
		await panel.click(`${SYNC}.querySelector('[data-action="sync-stop"]')`);
		await panel.waitFor(
			`${SYNC}.querySelector('[data-action="sync-choose"]')?.textContent === "Sync to a folder…"`,
		);
		const { page, tabId } = await h.open("v1");
		await showToolbar(h, page, tabId);
		await markElement(page, "[data-truth=submit]", "Again");
		await saveAs(page, "Not synced");
		await page.send("Page.close");
		await until(
			() => h.control.eval<Db>(READ_DB),
			(db) => db.cases.some((c) => c.title === "Not synced"),
		);
		await Bun.sleep(1000);
		expect(Object.keys(await files())).toEqual([FILE]);
	}, 60_000);
});
