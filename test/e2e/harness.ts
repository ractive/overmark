/**
 * The end-to-end setup: a test build of the extension, a server for the test
 * pages, Chromium with the extension loaded, and an extension page to call
 * `chrome.*` APIs from (it stays alive, unlike the service worker).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../scripts/build.ts";
import { Browser, findBrowser, type Page } from "./browser.ts";

export const browserBinary = findBrowser();

if (browserBinary === undefined && process.env["CI"])
	throw new Error(
		"Chrome for Testing is needed for the end-to-end tests in CI",
	);

export interface Harness {
	browser: Browser;
	/** `http://127.0.0.1:<port>` serving `test/e2e/pages/`. */
	base: string;
	extensionId: string;
	/** An extension page for calling `chrome.*` (the side panel's document, in a tab). */
	control: Page;
	/** Open a test page in a new tab and return it with its tab id. */
	open(path: string): Promise<{ page: Page; tabId: number }>;
	stop(): Promise<void>;
}

export async function startHarness(binary: string): Promise<Harness> {
	const outdir = mkdtempSync(join(tmpdir(), "overmark-dist-"));
	const { id } = await build({ outdir, test: true, minify: false });
	if (id === undefined) throw new Error("test build without a key");
	const pages = join(import.meta.dir, "pages");
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname.replace(/^\/+/, "") || "v1";
			const file = Bun.file(
				join(pages, path.endsWith(".html") ? path : `${path}.html`),
			);
			if (!(await file.exists()) || path.includes(".."))
				return new Response("not found", { status: 404 });
			return new Response(file, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		},
	});
	const base = `http://127.0.0.1:${server.port}`;
	const browser = await Browser.launch(binary, outdir);
	const control = await browser.newPage();
	// The extension may take a moment to install after launch.
	for (let attempt = 0; ; attempt++) {
		try {
			await control.goto(`chrome-extension://${id}/sidepanel/index.html`);
			if (
				await control.eval<boolean>("typeof chrome?.tabs?.query === 'function'")
			)
				break;
		} catch (error) {
			if (attempt > 40) throw error;
		}
		await Bun.sleep(100);
	}
	return {
		browser,
		base,
		extensionId: id,
		control,
		async open(path) {
			const page = await browser.newPage(`${base}/${path}`);
			const tabId = await control.eval<number>(
				`chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url === ${JSON.stringify(`${base}/${path}`)})?.id)`,
			);
			return { page, tabId };
		},
		async stop() {
			await browser.close();
			await server.stop(true);
			rmSync(outdir, { recursive: true, force: true });
		},
	};
}
