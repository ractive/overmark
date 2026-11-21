/**
 * Filling in the code on the relay's pairing page (DEC-044 and its review):
 * which pages count, what is read of the form and what is filled in, which
 * code, and the rules of the question (`CodeFiller`). Against a fixture with
 * the relay's markup (tab-mcp's `oauth/server.ts`, relay 0.12, the hooks of
 * its DEC-199): the testing package's relay cannot show the form for a test
 * client (it fetches the AI app's metadata over HTTPS).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { CodeFiller, type FillHost } from "../src/worker/code-filler.ts";
import {
	CODE_MARGIN_MS,
	type CodeNow,
	codeToFill,
	fillPairingForm,
	HOSTED_ORIGIN,
	isCode,
	isPairingPage,
	PAIR_FILL_SITE,
	type PairingForm,
	readPairingForm,
} from "../src/worker/pair-fill.ts";
import { fillAppLabel } from "../src/worker/protocol.ts";
import { pairingPage } from "./pair-fill-page.ts";

const globals = globalThis as Record<string, unknown>;
const PAGE_GLOBALS = ["document", "Event", "window", "location"] as const;

/** One tab of a fake browser: its address and its document. */
interface Tab {
	url: string;
	window: Window;
	/** The codes its form posted (Connect clicked). */
	submitted: string[];
	/** The page is in a frame of another page (its `window.top` is another). */
	framed?: boolean;
}

const open: Window[] = [];
afterEach(() => {
	for (const w of open.splice(0)) void w.happyDOM.close();
});

/** A tab at `url` showing `html`. */
function tab(url: string, html: string, framed = false): Tab {
	const window = new Window({ url });
	open.push(window);
	window.document.write(html);
	const t: Tab = { url, window, submitted: [], framed };
	window.document.querySelector("form")?.addEventListener("submit", (e) => {
		e.preventDefault();
		const field = window.document.querySelector(
			"[data-tab-mcp-field=code]",
		) as unknown as HTMLInputElement | null;
		t.submitted.push(field?.value ?? "");
	});
	return t;
}

/** Run `f` in `t`'s page, as `executeScript` runs the functions there. */
function inPage<T>(t: Tab, f: () => T): T {
	const before = PAGE_GLOBALS.map((k) => [k, globals[k]] as const);
	globals["document"] = t.window.document;
	globals["Event"] = t.window.Event;
	globals["location"] = t.window.location;
	globals["window"] = t.framed
		? { top: {}, location: t.window.location }
		: { top: undefined, location: t.window.location };
	// `window.top === window` in a top frame.
	if (!t.framed)
		(globals["window"] as { top: unknown }).top = globals["window"];
	try {
		return f();
	} finally {
		for (const [k, v] of before) globals[k] = v;
	}
}

const field = (t: Tab) =>
	(
		t.window.document.querySelector(
			"[data-tab-mcp-field=code]",
		) as unknown as HTMLInputElement
	).value;

const PAGE = `${HOSTED_ORIGIN}/authorize?response_type=code&x=1`;

describe("which page counts", () => {
	test("only the hosted relay's /authorize, exactly", () => {
		expect(HOSTED_ORIGIN).toBe("https://tab-mcp.ractive.ch");
		expect(PAIR_FILL_SITE).toEqual({
			origins: ["https://tab-mcp.ractive.ch/*"],
		});
		const ok = [HOSTED_ORIGIN];
		expect(isPairingPage(`${HOSTED_ORIGIN}/authorize`, ok)).toBe(true);
		expect(
			isPairingPage(`${HOSTED_ORIGIN}/authorize?response_type=code`, ok),
		).toBe(true);
		for (const url of [
			"https://tab-mcp.ractive.ch.example.com/authorize",
			"https://example.com/tab-mcp.ractive.ch/authorize",
			"http://tab-mcp.ractive.ch/authorize",
			"https://tab-mcp.ractive.ch:8443/authorize",
			"https://xtab-mcp.ractive.ch/authorize",
			"https://tab-mcp.ractive.ch/authorize/",
			"https://tab-mcp.ractive.ch/x/authorize",
			"https://tab-mcp.ractive.ch/",
			"https://tab-mcp.ractive.ch@example.com/authorize",
			"not a url",
			undefined,
		])
			expect(isPairingPage(url, ok)).toBe(false);
		// With no origin allowed (another relay set), nothing counts.
		expect(isPairingPage(`${HOSTED_ORIGIN}/authorize`, [])).toBe(false);
	});

	test("a code is 8 letters as the relay sends it", () => {
		expect(isCode("BCDF-GHJK")).toBe(true);
		for (const code of ["BCDFGHJK", "bcdf-ghjk", "BCD-GHJK", "", undefined])
			expect(isCode(code)).toBe(false);
	});
});

describe("the form, in the page", () => {
	test("its hooks and the relay's request id, as the relay writes them", () => {
		const t = tab(
			PAGE,
			pairingPage({ name: "Claude Code", host: "claude.ai" }),
		);
		expect(inPage(t, () => readPairingForm(HOSTED_ORIGIN))).toEqual({
			app: "sitegloss",
			clientName: "Claude Code",
			clientHost: "claude.ai",
			requestId: "r_1",
		});
	});

	test("not as documented: nothing", () => {
		const read = (html: string) =>
			inPage(tab(PAGE, html), () => readPairingForm(HOSTED_ORIGIN));
		expect(read(pairingPage({ forms: 2 }))).toBeNull();
		expect(
			read(pairingPage().replace(' data-tab-mcp-field="code"', "")),
		).toBeNull();
		expect(
			read(pairingPage().replace(' data-tab-mcp-action="connect"', "")),
		).toBeNull();
		expect(read(pairingPage({ host: "" }))).toBeNull();
		// No request id: not the relay's form.
		expect(read(pairingPage({ requestId: "" }))).toBeNull();
		expect(
			read(pairingPage().replace(' name="request_id"', ' name="request"')),
		).toBeNull();
		expect(
			read("<!doctype html><p>This connection request has expired.</p>"),
		).toBeNull();
	});

	test("Review 7: a document at another origin, port or path, or in a frame, is not read and gets no code, whatever its markup", () => {
		for (const url of [
			"https://tab-mcp.ractive.ch.example.com/authorize",
			"https://tab-mcp.ractive.ch:8443/authorize",
			"http://tab-mcp.ractive.ch/authorize",
			`${HOSTED_ORIGIN}/authorize/`,
		]) {
			const t = tab(url, pairingPage());
			expect(inPage(t, () => readPairingForm(HOSTED_ORIGIN))).toBeNull();
			const seen = {
				app: "sitegloss",
				clientName: "Claude",
				clientHost: "claude.ai",
				requestId: "r_1",
			};
			expect(
				inPage(t, () => fillPairingForm("BCDF-GHJK", seen, HOSTED_ORIGIN)),
			).toBe(false);
			expect(t.submitted).toEqual([]);
			expect(field(t)).toBe("");
		}
		const framed = tab(PAGE, pairingPage(), true);
		expect(inPage(framed, () => readPairingForm(HOSTED_ORIGIN))).toBeNull();
	});

	test("filled in: the code typed into the field, Connect clicked, nothing else written", () => {
		const t = tab(PAGE, pairingPage());
		const seen = inPage(t, () => readPairingForm(HOSTED_ORIGIN));
		expect(seen).not.toBeNull();
		const html = () => t.window.document.body.innerHTML;
		const markup = html();
		expect(
			inPage(t, () =>
				fillPairingForm("BCDF-GHJK", seen as PairingForm, HOSTED_ORIGIN),
			),
		).toBe(true);
		expect(t.submitted).toEqual(["BCDF-GHJK"]);
		// The value is the field's, not an attribute of the page.
		expect(html()).toBe(markup);
		expect(html()).not.toContain("BCDF-GHJK");
	});

	test("a form that changed since the question: nothing filled in", () => {
		const seen = inPage(tab(PAGE, pairingPage({ name: "Claude" })), () =>
			readPairingForm(HOSTED_ORIGIN),
		) as PairingForm;
		const other = tab(PAGE, pairingPage({ name: "Someone else" }));
		expect(
			inPage(other, () => fillPairingForm("BCDF-GHJK", seen, HOSTED_ORIGIN)),
		).toBe(false);
		expect(other.submitted).toEqual([]);
		expect(field(other)).toBe("");
	});

	test("Review 1: the same AI app with another request of the relay: nothing filled in", () => {
		const seen = inPage(tab(PAGE, pairingPage({ requestId: "r_1" })), () =>
			readPairingForm(HOSTED_ORIGIN),
		) as PairingForm;
		const next = tab(PAGE, pairingPage({ requestId: "r_2" }));
		expect(
			inPage(next, () => fillPairingForm("BCDF-GHJK", seen, HOSTED_ORIGIN)),
		).toBe(false);
		expect(next.submitted).toEqual([]);
	});
});

describe("Review 4: which code is filled in", () => {
	const at = (ms: number) => new Date(ms).toISOString();

	test("the current one while it has time left by this clock", async () => {
		const now = 1_000_000;
		const code = await codeToFill(
			() => ({ code: "AAAA-AAAA", expiresAt: at(now + CODE_MARGIN_MS) }),
			{ now: () => now, waitMs: 1000 },
		);
		expect(code).toBe("AAAA-AAAA");
	});

	test("about to end: the next one the relay sends", async () => {
		const now = 1_000_000;
		let current: CodeNow = { code: "AAAA-AAAA", expiresAt: at(now + 1000) };
		setTimeout(() => {
			current = { code: "BBBB-BBBB", expiresAt: at(now + 61_000) };
		}, 30);
		const code = await codeToFill(() => current, {
			now: () => now,
			waitMs: 2000,
			pollMs: 5,
		});
		expect(code).toBe("BBBB-BBBB");
	});

	test("a clock that runs ahead (every code looks expired): when no fresh code comes within the wait by that clock, the current one after all", async () => {
		// An hour ahead, and it moves past the wait's end at once: the
		// wait is by this clock, so the test ends long before 10 s.
		const ahead = Date.now() + 3_600_000;
		let clock = ahead;
		setTimeout(() => {
			clock = ahead + 20_000;
		}, 20);
		const code = await codeToFill(
			() => ({ code: "AAAA-AAAA", expiresAt: at(Date.now() + 60_000) }),
			{ now: () => clock, waitMs: 10_000, pollMs: 5 },
		);
		expect(code).toBe("AAAA-AAAA");
	}, 1000);

	test("no code yet: the first that comes; none: nothing", async () => {
		let current: CodeNow | undefined;
		setTimeout(() => {
			current = { code: "CCCC-CCCC", expiresAt: at(Date.now() + 60_000) };
		}, 20);
		expect(await codeToFill(() => current, { waitMs: 2000, pollMs: 5 })).toBe(
			"CCCC-CCCC",
		);
		expect(
			await codeToFill(() => undefined, { waitMs: 30, pollMs: 5 }),
		).toBeUndefined();
	});

	test("cancelled (the fill withdrawn): nothing, at once", async () => {
		let cancelled = false;
		setTimeout(() => {
			cancelled = true;
		}, 20);
		expect(
			await codeToFill(() => undefined, {
				waitMs: 10_000,
				pollMs: 5,
				cancelled: () => cancelled,
			}),
		).toBeUndefined();
	}, 1000);

	test("an end it cannot read: the current one", async () => {
		expect(
			await codeToFill(() => ({ code: "AAAA-AAAA", expiresAt: "?" }), {
				waitMs: 1000,
			}),
		).toBe("AAAA-AAAA");
	});
});

/** A fake browser and library around a `CodeFiller`. */
function setup(
	options: { holdMs?: number; askMs?: number; problemMs?: number } = {},
) {
	const tabs = new Map<number, Tab>();
	const holds: boolean[] = [];
	const notices: (string | undefined)[] = [];
	const reads: number[] = [];
	let code: () => Promise<string | undefined> = async () => "BCDF-GHJK";
	/** Called as the fill starts, before the page's function runs. */
	let duringFill = () => {};
	const state = {
		ready: true,
		origins: [HOSTED_ORIGIN] as string[],
		sites: [HOSTED_ORIGIN] as string[],
	};
	const host: FillHost = {
		app: "sitegloss",
		origins: () => state.origins,
		ready: () => state.ready,
		hasSite: async (origin) => state.sites.includes(origin),
		tabUrl: async (id) => tabs.get(id)?.url,
		read: async (id, origin) => {
			reads.push(id);
			const t = tabs.get(id);
			return t ? inPage(t, () => readPairingForm(origin)) : undefined;
		},
		fill: async (id, value, form, origin) => {
			duringFill();
			const t = tabs.get(id);
			return t ? inPage(t, () => fillPairingForm(value, form, origin)) : false;
		},
		code: () => code(),
		hold: (on) => holds.push(on),
		notify: (view) => notices.push(view?.id),
		changed: () => {},
		visible: (text) => text,
	};
	const filler = new CodeFiller(host, options);
	return {
		filler,
		state,
		holds,
		notices,
		reads,
		/** Tab `id` loads `url` with `html`, and Chrome says it is complete. */
		async load(id: number, url: string, html: string) {
			const t = tab(url, html);
			tabs.set(id, t);
			await filler.page(id, url);
			return t;
		},
		/** Tab `id`'s document becomes another, with no event (yet). */
		swap(id: number, url: string, html: string) {
			const t = tab(url, html);
			tabs.set(id, t);
			return t;
		},
		close(id: number) {
			tabs.delete(id);
			filler.tabLeft(id);
		},
		setCode(f: () => Promise<string | undefined>) {
			code = f;
		},
		onFill(f: () => void) {
			duringFill = f;
		},
	};
}

/** A promise and its resolve. */
function later<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("the question and the fill (CodeFiller)", () => {
	test("a form for Sitegloss gets the question, naming the verified host first; a yes fills in that page", async () => {
		const f = setup();
		const t = await f.load(
			1,
			PAGE,
			pairingPage({ name: "Claude (claude.ai)", host: "evil.example" }),
		);
		const q = f.filler.question;
		expect(q).toMatchObject({
			name: "Claude (claude.ai)",
			host: "evil.example",
		});
		expect(fillAppLabel(q as never)).toBe(
			"An AI app at evil.example (it calls itself “Claude (claude.ai)”)",
		);
		expect(field(t)).toBe("");
		await f.filler.answer(q?.id as string, true);
		expect(t.submitted).toEqual(["BCDF-GHJK"]);
		expect(f.filler.question).toBeUndefined();
		expect(f.filler.problem).toBeUndefined();
	});

	test("No fills in nothing; a stale id does nothing", async () => {
		const f = setup();
		const t = await f.load(1, PAGE, pairingPage());
		await f.filler.answer("not-the-id", true);
		expect(t.submitted).toEqual([]);
		await f.filler.answer(f.filler.question?.id as string, false);
		expect(t.submitted).toEqual([]);
		expect(f.filler.question).toBeUndefined();
	});

	test("Review 1: the relay's wrong-code page (same tab, same request) asks again: nothing is ever filled in without a yes", async () => {
		const f = setup();
		const first = await f.load(1, PAGE, pairingPage({ requestId: "r_1" }));
		await f.filler.answer(f.filler.question?.id as string, true);
		expect(first.submitted).toHaveLength(1);
		// The relay answers the post with the same form, an error above it.
		const again = await f.load(
			1,
			`${HOSTED_ORIGIN}/authorize`,
			pairingPage({ requestId: "r_1", error: "Wrong code" }),
		);
		expect(f.filler.question).toBeDefined();
		await Bun.sleep(20);
		expect(again.submitted).toEqual([]);
		// The AI app sends the tab back with a new request: asked too.
		const next = await f.load(1, PAGE, pairingPage({ requestId: "r_2" }));
		await Bun.sleep(20);
		expect(next.submitted).toEqual([]);
		expect(f.filler.question).toBeDefined();
	});

	test("Review 1: a yes for one request does not fill in another that took its tab's place meanwhile", async () => {
		const f = setup();
		await f.load(1, PAGE, pairingPage({ requestId: "r_1" }));
		const id = f.filler.question?.id as string;
		// The new document is there; Chrome has not said it is complete yet.
		const next = f.swap(1, PAGE, pairingPage({ requestId: "r_2" }));
		await f.filler.answer(id, true);
		expect(next.submitted).toEqual([]);
		expect(f.filler.problem).toContain("could not fill in the code");
		// Nothing went into a page: pairing is let go at once.
		expect(f.holds).toEqual([true, false]);
	});

	test("Review 2: withdrawn (AI access off, turned off, another relay), the question goes at once, and a yes waiting for its code fills in nothing", async () => {
		const f = setup();
		await f.load(1, PAGE, pairingPage());
		expect(f.filler.question).toBeDefined();
		f.filler.withdraw();
		expect(f.filler.question).toBeUndefined();

		const t = await f.load(1, PAGE, pairingPage());
		const code = later<string | undefined>();
		f.setCode(() => code.promise);
		const answered = f.filler.answer(f.filler.question?.id as string, true);
		await Bun.sleep(10);
		expect(f.filler.busy).toBe(true);
		f.filler.withdraw();
		code.resolve("BCDF-GHJK");
		await answered;
		expect(t.submitted).toEqual([]);
		expect(f.filler.problem).toBeUndefined();
		// Pairing is let go at once, not after the hold.
		expect(f.holds).toEqual([true, false]);
	});

	test("Review 2: the tab leaving the page while the code is on its way: nothing filled in, also when it is back on the same request by then", async () => {
		const f = setup();
		await f.load(1, PAGE, pairingPage());
		const code = later<string | undefined>();
		f.setCode(() => code.promise);
		const answered = f.filler.answer(f.filler.question?.id as string, true);
		await Bun.sleep(10);
		// The tab goes elsewhere and comes back to the same request before
		// Chrome says it is complete: only the withdrawal stops the fill.
		f.filler.tabLeft(1, `${HOSTED_ORIGIN}/elsewhere`);
		const back = f.swap(1, PAGE, pairingPage());
		code.resolve("BCDF-GHJK");
		await answered;
		expect(back.submitted).toEqual([]);
		expect(f.holds).toEqual([true, false]);
	});

	test("Review of #27, 2: the tab reloading the same request while the first yes waits for its code: one fill, not two", async () => {
		const f = setup();
		await f.load(1, PAGE, pairingPage());
		const first = later<string | undefined>();
		f.setCode(() => first.promise);
		const answered = f.filler.answer(f.filler.question?.id as string, true);
		await Bun.sleep(10);
		// Reloaded: the same address and request, a new document (Chrome
		// sends no new address for a reload).
		const again = await f.load(1, PAGE, pairingPage());
		expect(f.filler.question).toBeDefined();
		f.setCode(async () => "BCDF-GHJK");
		await f.filler.answer(f.filler.question?.id as string, true);
		first.resolve("BCDF-GHJK");
		await answered;
		expect(again.submitted).toEqual(["BCDF-GHJK"]);
	});

	test("Review of #27, 3: the question's tab loading a relay page that cannot be asked about ends the question", async () => {
		const f = setup();
		await f.load(1, PAGE, pairingPage());
		await f.load(
			1,
			PAGE,
			"<!doctype html><p>This connection request has expired.</p>",
		);
		expect(f.filler.question).toBeUndefined();
		await f.load(1, PAGE, pairingPage());
		await f.load(1, PAGE, pairingPage({ app: "tab-mcp-extension" }));
		expect(f.filler.question).toBeUndefined();
		await f.load(1, PAGE, pairingPage());
		f.state.sites = [];
		await f.load(1, PAGE, pairingPage());
		expect(f.filler.question).toBeUndefined();
	});

	test("Review of #27, 4: a page while only a fill is on its way says so, not 'answer the question above', and not for long", async () => {
		const f = setup({ problemMs: 40 });
		await f.load(1, PAGE, pairingPage());
		const code = later<string | undefined>();
		f.setCode(() => code.promise);
		const answered = f.filler.answer(f.filler.question?.id as string, true);
		await Bun.sleep(10);
		expect(f.filler.question).toBeUndefined();
		await f.load(2, PAGE, pairingPage({ host: "second.example" }));
		expect(f.filler.problem).toBe(
			"An AI app at second.example (it calls itself “Claude”) also opened the relay's page while Sitegloss was filling in the code on another one. Reload that page in a moment to be asked, or type the code there.",
		);
		code.resolve(undefined);
		await answered;
		await Bun.sleep(80);
		expect(f.filler.problem).toBeUndefined();
	});

	test("Review of #27, 5: with two relay origins, a fill's tab is judged by its own page's origin", async () => {
		const OTHER = "https://other-relay.example";
		const OTHER_PAGE = `${OTHER}/authorize?x=1`;
		const fillWith = async () => {
			const f = setup();
			f.state.origins = [HOSTED_ORIGIN, OTHER];
			f.state.sites = [HOSTED_ORIGIN, OTHER];
			await f.load(1, OTHER_PAGE, pairingPage());
			const code = later<string | undefined>();
			f.setCode(() => code.promise);
			const answered = f.filler.answer(f.filler.question?.id as string, true);
			await Bun.sleep(10);
			return { f, code, answered };
		};
		// To the other origin's own pairing page (the same request): it stays.
		const own = await fillWith();
		own.f.filler.tabLeft(1, `${OTHER}/authorize?y=2`);
		const same = own.f.swap(1, `${OTHER}/authorize?y=2`, pairingPage());
		own.code.resolve("BCDF-GHJK");
		await own.answered;
		expect(same.submitted).toEqual(["BCDF-GHJK"]);
		// To the hosted relay's pairing page, which is not its own: withdrawn,
		// also when the tab is back on its request by the time the code comes.
		const away = await fillWith();
		away.f.filler.tabLeft(1, `${HOSTED_ORIGIN}/authorize`);
		const back = away.f.swap(1, OTHER_PAGE, pairingPage());
		away.code.resolve("BCDF-GHJK");
		await away.answered;
		expect(back.submitted).toEqual([]);
	});

	test("Review 3: not turned on (or AI access not connected): no page is read and nothing is asked, also with the site allowed", async () => {
		const f = setup();
		f.state.ready = false;
		await f.load(1, PAGE, pairingPage());
		expect(f.reads).toEqual([]);
		expect(f.filler.question).toBeUndefined();
		// Without the site: neither.
		f.state.ready = true;
		f.state.sites = [];
		await f.load(2, PAGE, pairingPage());
		expect(f.reads).toEqual([]);
		expect(f.filler.question).toBeUndefined();
	});

	test("Review 5: a pairing page in another tab while a question waits is not asked about, and the panel says so; the same tab's new page replaces its question", async () => {
		const f = setup();
		await f.load(1, PAGE, pairingPage({ host: "first.example" }));
		const first = f.filler.question?.id;
		const second = await f.load(
			2,
			PAGE,
			pairingPage({ host: "second.example" }),
		);
		expect(f.filler.question?.id).toBe(first as string);
		expect(f.filler.question?.host).toBe("first.example");
		expect(f.filler.problem).toBe(
			"An AI app at second.example (it calls itself “Claude”) also opened the relay's page. Sitegloss asks about one at a time: answer the question above first, then reload that page; or type the code there.",
		);
		expect(second.submitted).toEqual([]);
		// Tab 1 loads a pairing page again: a new question, with a new id.
		await f.load(1, PAGE, pairingPage({ host: "third.example" }));
		expect(f.filler.question?.host).toBe("third.example");
		expect(f.filler.question?.id).not.toBe(first as string);
	});

	test("Review 6: pairing is held on from the yes until a while after the fill, also when Connect's post leaves the page", async () => {
		const f = setup({ holdMs: 40 });
		const t = await f.load(1, PAGE, pairingPage());
		// Connect's own post leaves the page while the fill is under way.
		f.onFill(() => f.filler.tabLeft(1, `${HOSTED_ORIGIN}/callback`));
		await f.filler.answer(f.filler.question?.id as string, true);
		expect(t.submitted).toEqual(["BCDF-GHJK"]);
		expect(f.holds).toEqual([true]);
		await Bun.sleep(80);
		expect(f.holds).toEqual([true, false]);
		expect(f.filler.busy).toBe(false);
	});

	test("Review 7: a look-alike origin or another port of the relay's host is not read at all; a form for another app gets nothing", async () => {
		const f = setup();
		f.state.sites = [
			HOSTED_ORIGIN,
			"https://tab-mcp.ractive.ch:8443",
			"https://tab-mcp.ractive.ch.example.com",
		];
		await f.load(1, "https://tab-mcp.ractive.ch:8443/authorize", pairingPage());
		await f.load(
			2,
			"https://tab-mcp.ractive.ch.example.com/authorize",
			pairingPage(),
		);
		expect(f.reads).toEqual([]);
		await f.load(3, PAGE, pairingPage({ app: "tab-mcp-extension" }));
		expect(f.reads).toEqual([3]);
		expect(f.filler.question).toBeUndefined();
	});

	test("Review 7: a tab that says it is the relay's page but holds another document gets no code", async () => {
		const f = setup();
		await f.load(1, PAGE, pairingPage());
		const id = f.filler.question?.id as string;
		// Chrome's address still says the relay; the document is elsewhere.
		const evil = f.swap(1, "https://evil.example/authorize", pairingPage());
		// The fake's address follows the document: make it lie.
		evil.url = PAGE;
		await f.filler.answer(id, true);
		expect(evil.submitted).toEqual([]);
		expect(f.filler.problem).toContain("could not fill in the code");
	});

	test("the question runs out with a code's life", async () => {
		const f = setup({ askMs: 30 });
		await f.load(1, PAGE, pairingPage());
		expect(f.filler.question).toBeDefined();
		await Bun.sleep(60);
		expect(f.filler.question).toBeUndefined();
	});

	test("the tab closing ends its question", async () => {
		const f = setup();
		await f.load(1, PAGE, pairingPage());
		f.close(1);
		expect(f.filler.question).toBeUndefined();
	});
});
