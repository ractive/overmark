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

/**
 * Open an extension page to call `chrome.*` from, waiting for the extension
 * to be installed (after launch, or after `chrome.runtime.reload()`).
 */
export async function openControl(
	browser: Browser,
	extensionId: string,
): Promise<Page> {
	const control = await browser.newPage();
	for (let attempt = 0; ; attempt++) {
		try {
			await control.goto(
				`chrome-extension://${extensionId}/sidepanel/index.html`,
			);
			if (
				await control.eval<boolean>("typeof chrome?.tabs?.query === 'function'")
			)
				return control;
		} catch (error) {
			if (attempt >= 40) throw error;
		}
		if (attempt >= 40) throw new Error("extension pages have no chrome.tabs");
		await Bun.sleep(100);
	}
}

export async function startHarness(binary: string): Promise<Harness> {
	const outdir = mkdtempSync(join(tmpdir(), "overmark-dist-"));
	let server: ReturnType<typeof Bun.serve> | undefined;
	let browser: Browser | undefined;
	const cleanUp = async () => {
		await browser?.close();
		await server?.stop(true);
		rmSync(outdir, { recursive: true, force: true });
	};
	try {
		const { id } = await build({ outdir, test: true, minify: false });
		if (id === undefined) throw new Error("test build without a key");
		const pages = join(import.meta.dir, "pages");
		server = Bun.serve({
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
		const launched = await Browser.launch(binary, outdir);
		browser = launched;
		const control = await openControl(launched, id).catch((error: unknown) => {
			throw new Error(
				`the extension did not load; is ${binary} Chrome for Testing or Chromium? (branded Chrome ignores --load-extension)`,
				{ cause: error },
			);
		});
		return {
			browser: launched,
			base,
			extensionId: id,
			control,
			async open(path) {
				const page = await launched.newPage(`${base}/${path}`);
				const tabId = await control.eval<number>(
					`chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url === ${JSON.stringify(`${base}/${path}`)})?.id)`,
				);
				return { page, tabId };
			},
			stop: cleanUp,
		};
	} catch (error) {
		await cleanUp();
		throw error;
	}
}
