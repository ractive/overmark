/**
 * The end-to-end setup: a test build of the extension (or the store package,
 * `startShipped`), a server for the test pages, Chromium with the extension
 * loaded, and an extension page to call `chrome.*` APIs from (it stays alive,
 * unlike the service worker).
 */

import { setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BuildOptions,
	type BuildResult,
	build,
} from "../../scripts/build.ts";
import { Browser, findBrowser, type Page } from "./browser.ts";

// A timed-out test also loses the browser, and with it the rest of its file:
// on a busy machine a first screenshot alone can take longer than the default.
setDefaultTimeout(30_000);

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
	manifest: BuildResult["manifest"];
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

function servePages(): ReturnType<typeof Bun.serve> {
	const pages = join(import.meta.dir, "pages");
	return Bun.serve({
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
}

/** What differs between the test build and the store package. */
interface Launch {
	options: BuildOptions;
	browser(outdir: string): Promise<Browser>;
	extensionId(
		browser: Browser,
		outdir: string,
		built: BuildResult,
	): Promise<string>;
	tabIdOf(control: Page, page: Page, url: string): Promise<number>;
}

async function start(binary: string, launch: Launch): Promise<Harness> {
	const outdir = mkdtempSync(join(tmpdir(), "overmark-dist-"));
	let server: ReturnType<typeof Bun.serve> | undefined;
	let browser: Browser | undefined;
	const cleanUp = async () => {
		await browser?.close();
		await server?.stop(true);
		rmSync(outdir, { recursive: true, force: true });
	};
	try {
		const built = await build({ outdir, ...launch.options });
		server = servePages();
		const base = `http://127.0.0.1:${server.port}`;
		const launched = await launch.browser(outdir);
		browser = launched;
		const extensionId = await launch.extensionId(launched, outdir, built);
		const control = await openControl(launched, extensionId).catch(
			(error: unknown) => {
				throw new Error(
					`the extension did not load; is ${binary} Chrome for Testing or Chromium? (branded Chrome ignores --load-extension)`,
					{ cause: error },
				);
			},
		);
		return {
			browser: launched,
			base,
			extensionId,
			manifest: built.manifest,
			control,
			async open(path) {
				const url = `${base}/${path}`;
				const page = await launched.newPage(url);
				return { page, tabId: await launch.tabIdOf(control, page, url) };
			},
			stop: cleanUp,
		};
	} catch (error) {
		await cleanUp();
		throw error;
	}
}

export function startHarness(binary: string): Promise<Harness> {
	return start(binary, {
		options: { test: true, minify: false },
		browser: (outdir) => Browser.launch(binary, outdir),
		async extensionId(_browser, _outdir, built) {
			if (built.id === undefined) throw new Error("test build without a key");
			return built.id;
		},
		tabIdOf: (control, _page, url) =>
			control.eval<number>(
				`chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url === ${JSON.stringify(url)})?.id)`,
			),
	});
}

/**
 * The store package as it ships: minified, the real manifest, no host access.
 * Extension pages see no tab's address, so `open` brings the tab to the front.
 */
export function startShipped(binary: string): Promise<Harness> {
	return start(binary, {
		options: { store: true },
		browser: () => Browser.launchPiped(binary),
		extensionId: (browser, outdir) => browser.loadExtension(outdir),
		async tabIdOf(control, page) {
			await page.activate();
			return control.eval<number>(
				`chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab.id)`,
			);
		},
	});
}
