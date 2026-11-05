/**
 * A small Chrome DevTools Protocol driver for the end-to-end tests, after
 * tab-mcp's `test/cdp.ts`: launch Chromium with the unpacked extension, open
 * pages, evaluate, click and type. Uses Bun's WebSocket; no Playwright.
 *
 * Branded Google Chrome ignores `--load-extension` (since Chrome 137), so the
 * tests need Chrome for Testing or Chromium: `CHROME_PATH`, else Playwright's
 * download.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

/** Chrome for Testing or Chromium; `undefined` if there is none. */
export function findBrowser(): string | undefined {
	const fromEnv = process.env["CHROME_PATH"];
	if (fromEnv) return fromEnv;
	const caches = [
		join(homedir(), "Library/Caches/ms-playwright"),
		join(homedir(), ".cache/ms-playwright"),
	];
	const binaries = [
		"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
		"chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
		"chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
		"chrome-mac/Chromium.app/Contents/MacOS/Chromium",
		"chrome-linux64/chrome",
		"chrome-linux/chrome",
	];
	for (const cache of caches) {
		let dirs: string[];
		try {
			dirs = readdirSync(cache)
				.filter((d) => /^chromium-\d+$/.test(d))
				.sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
		} catch {
			continue;
		}
		for (const dir of dirs) {
			for (const binary of binaries) {
				const path = join(cache, dir, binary);
				if (Bun.file(path).size > 0) return path;
			}
		}
	}
	return undefined;
}

type Pending = {
	resolve: (v: Record<string, unknown>) => void;
	reject: (e: Error) => void;
};

type Listener = (
	method: string,
	params: Record<string, unknown>,
	sessionId?: string,
) => void;

export class Browser {
	readonly #proc: Subprocess<"ignore", "ignore", "pipe">;
	readonly #profile: string;
	readonly #ws: WebSocket;
	readonly #pending = new Map<number, Pending>();
	readonly #listeners = new Set<Listener>();
	#nextId = 0;

	private constructor(
		proc: Subprocess<"ignore", "ignore", "pipe">,
		profile: string,
		ws: WebSocket,
	) {
		this.#proc = proc;
		this.#profile = profile;
		this.#ws = ws;
		ws.addEventListener("message", (e) => {
			const msg = JSON.parse(String(e.data)) as {
				id?: number;
				result?: Record<string, unknown>;
				error?: { message: string };
				method?: string;
				params?: Record<string, unknown>;
				sessionId?: string;
			};
			if (msg.id !== undefined) {
				const p = this.#pending.get(msg.id);
				this.#pending.delete(msg.id);
				if (msg.error) p?.reject(new Error(msg.error.message));
				else p?.resolve(msg.result ?? {});
			} else if (msg.method !== undefined) {
				for (const l of this.#listeners)
					l(msg.method, msg.params ?? {}, msg.sessionId);
			}
		});
	}

	static async launch(binary: string, extensionDir: string): Promise<Browser> {
		const profile = mkdtempSync(join(tmpdir(), "overmark-chrome-"));
		const proc = Bun.spawn(
			[
				binary,
				"--headless=new",
				"--remote-debugging-port=0",
				`--user-data-dir=${profile}`,
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-gpu",
				"--disable-background-networking",
				"--window-size=1280,800",
				`--disable-extensions-except=${extensionDir}`,
				`--load-extension=${extensionDir}`,
				...(process.platform === "linux" ? ["--no-sandbox"] : []),
				"about:blank",
			],
			{ stdin: "ignore", stdout: "ignore", stderr: "pipe" },
		);
		const endpoint = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Chrome did not start")),
				20_000,
			);
			void (async () => {
				const decoder = new TextDecoder();
				let text = "";
				for await (const chunk of proc.stderr) {
					text += decoder.decode(chunk, { stream: true });
					const m = /DevTools listening on (ws:\/\/\S+)/.exec(text);
					if (m?.[1] !== undefined) {
						clearTimeout(timer);
						resolve(m[1]);
						return;
					}
				}
				reject(new Error(`Chrome exited: ${text.slice(-500)}`));
			})();
		});
		const ws = new WebSocket(endpoint);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener(
				"error",
				() => reject(new Error("CDP connection failed")),
				{ once: true },
			);
		});
		return new Browser(proc, profile, ws);
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<Record<string, unknown>> {
		const id = ++this.#nextId;
		this.#ws.send(
			JSON.stringify({
				id,
				method,
				params,
				...(sessionId ? { sessionId } : {}),
			}),
		);
		return new Promise((resolve, reject) =>
			this.#pending.set(id, { resolve, reject }),
		);
	}

	/** The next event `method` (optionally for one session). */
	event(method: string, sessionId?: string): Promise<Record<string, unknown>> {
		return this.waitForEvent(method, sessionId).promise;
	}

	/** The next event `method`, and a way to stop waiting for it. */
	waitForEvent(
		method: string,
		sessionId?: string,
	): { promise: Promise<Record<string, unknown>>; cancel: () => void } {
		let listener: Listener | undefined;
		const promise = new Promise<Record<string, unknown>>((resolve) => {
			listener = (m, params, s) => {
				if (m === method && (sessionId === undefined || s === sessionId)) {
					if (listener) this.#listeners.delete(listener);
					resolve(params);
				}
			};
			this.#listeners.add(listener);
		});
		return {
			promise,
			cancel: () => {
				if (listener) this.#listeners.delete(listener);
			},
		};
	}

	/** Open `url` in a new tab. */
	async newPage(url = "about:blank"): Promise<Page> {
		const { targetId } = (await this.send("Target.createTarget", {
			url: "about:blank",
		})) as { targetId: string };
		const { sessionId } = (await this.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		})) as { sessionId: string };
		const page = new Page(this, sessionId, targetId);
		await page.send("Page.enable");
		await page.send("Runtime.enable");
		if (url !== "about:blank") await page.goto(url);
		return page;
	}

	async close(): Promise<void> {
		try {
			await Promise.race([this.send("Browser.close"), Bun.sleep(2000)]);
		} catch {
			// already gone
		}
		this.#ws.close();
		if (this.#proc.exitCode === null) this.#proc.kill("SIGKILL");
		await this.#proc.exited;
		rmSync(this.#profile, { recursive: true, force: true });
	}
}

export class Page {
	readonly #browser: Browser;
	readonly sessionId: string;
	readonly targetId: string;

	constructor(browser: Browser, sessionId: string, targetId: string) {
		this.#browser = browser;
		this.sessionId = sessionId;
		this.targetId = targetId;
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> {
		return this.#browser.send(method, params, this.sessionId);
	}

	async goto(url: string, timeoutMs = 15_000): Promise<void> {
		const loaded = this.#browser.waitForEvent(
			"Page.loadEventFired",
			this.sessionId,
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const { errorText } = (await this.send("Page.navigate", { url })) as {
				errorText?: string;
			};
			if (errorText) throw new Error(`cannot open ${url}: ${errorText}`);
			await Promise.race([
				loaded.promise,
				new Promise((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`${url} did not load`)),
						timeoutMs,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
			loaded.cancel(); // a navigation that failed leaves no listener behind
		}
	}

	/** Bring the tab to the front (the "active tab" of its window). */
	async activate(): Promise<void> {
		await this.#browser.send("Target.activateTarget", {
			targetId: this.targetId,
		});
		await this.send("Page.bringToFront");
	}

	/** Evaluate an expression (awaiting promises) and return its JSON value. */
	async eval<T = unknown>(expression: string): Promise<T> {
		const r = (await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		})) as {
			result: { value?: T };
			exceptionDetails?: { exception?: { description?: string }; text: string };
		};
		if (r.exceptionDetails) {
			throw new Error(
				r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
			);
		}
		return r.result.value as T;
	}

	/** Wait until `expression` is truthy. */
	async waitFor(expression: string, timeoutMs = 5000): Promise<void> {
		const end = Date.now() + timeoutMs;
		for (;;) {
			if (await this.eval<boolean>(`Boolean(${expression})`)) return;
			if (Date.now() > end)
				throw new Error(`timed out waiting for ${expression}`);
			await Bun.sleep(50);
		}
	}

	async mouse(
		type: "mouseMoved" | "mousePressed" | "mouseReleased",
		x: number,
		y: number,
	): Promise<void> {
		await this.send("Input.dispatchMouseEvent", {
			type,
			x,
			y,
			button: "left",
			buttons: type === "mouseReleased" ? 0 : 1,
			clickCount: type === "mouseMoved" ? 0 : 1,
		});
	}

	/** A real click at a point of the window. */
	async clickAt(x: number, y: number): Promise<void> {
		await this.mouse("mouseMoved", x, y);
		await this.mouse("mousePressed", x, y);
		await this.mouse("mouseReleased", x, y);
	}

	/** Press, move in steps and release: a drag from one point to another. */
	async drag(
		from: { x: number; y: number },
		to: { x: number; y: number },
		steps = 8,
	): Promise<void> {
		await this.mouse("mouseMoved", from.x, from.y);
		await this.mouse("mousePressed", from.x, from.y);
		for (let i = 1; i <= steps; i++) {
			await this.send("Input.dispatchMouseEvent", {
				type: "mouseMoved",
				x: from.x + ((to.x - from.x) * i) / steps,
				y: from.y + ((to.y - from.y) * i) / steps,
				button: "left",
				buttons: 1,
			});
		}
		await this.mouse("mouseReleased", to.x, to.y);
	}

	/** The centre of the element an expression returns, in window coordinates. */
	async centreOf(expression: string): Promise<{ x: number; y: number }> {
		return this.eval<{ x: number; y: number }>(
			`(() => { const e = ${expression}; e.scrollIntoView?.({ block: "nearest" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
		);
	}

	/** Click the element an expression returns (also inside a shadow root). */
	async click(expression: string): Promise<void> {
		const { x, y } = await this.centreOf(expression);
		await this.clickAt(x, y);
	}

	/** Type text into the focused element. */
	async type(text: string): Promise<void> {
		await this.send("Input.insertText", { text });
	}
}
