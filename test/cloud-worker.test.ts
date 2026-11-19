/**
 * The service worker's part of the account and the sync (DEC-039): what the
 * side panel asks (`CloudRequest`) and what comes of it, with the server in
 * memory reached over HTTP as the real one is: the sign-in's two halves, the
 * tokens, the alarms, and a worker that starts often.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { withComment } from "../src/lib/case.ts";
import {
	CLIENT_ID,
	PENDING_KEY,
	TOKENS_KEY,
	type Tokens,
} from "../src/lib/cloud/auth.ts";
import {
	type Account,
	type CaseBook,
	type CloudStatus,
	KEYS,
} from "../src/lib/cloud/book.ts";
import { scopeOf } from "../src/lib/cloud/servers.ts";
import { memoryKv } from "../src/lib/kv.ts";
import { MemoryStore } from "../src/lib/store.ts";
import {
	CLOUD_ALARM,
	CLOUD_RETRY_ALARM,
	Cloud,
	LOOK_EVERY_MINUTES,
} from "../src/worker/cloud.ts";
import { FakeServer, fakeHttp, TEAM } from "./cloud-fake.ts";
import {
	addMark,
	change,
	type Device,
	device,
	startCase,
} from "./cloud-helpers.ts";

const SERVER = "https://app.sitegloss.dev";
const REDIRECT = "https://ldmcfigcnobhnbaigehcaodheklibeon.chromiumapp.org/";
const TESS = { id: "u_tess", name: "Tess Tester", email: "tess@example.com" };

/** The development server: another server, with an account and a team of its own. */
const DEV = "https://app.dev.sitegloss.dev";

let server: FakeServer;
let http: ReturnType<typeof fakeHttp>;
let dev: FakeServer;
let devHttp: ReturnType<typeof fakeHttp>;
let store: MemoryStore;
let kv: ReturnType<typeof memoryKv>;
let cloud: Cloud;
let changed: string[];
let news: number;
let now: number;
let alarms: Map<string, chrome.alarms.AlarmCreateInfo>;
let kept: number;

/** A worker: the same store and database, as after a restart. */
function worker(): Cloud {
	return new Cloud({
		store,
		kv,
		changed: (id) => changed.push(id),
		news: () => news++,
		redirect: () => REDIRECT,
		// Each address is its own server; any other address answers nothing.
		fetch: (input, init) =>
			(input.startsWith(`${DEV}/`) ? devHttp : http).fetch(input, init),
		now: () => now,
		alarms: {
			create: (async (name: string, info: chrome.alarms.AlarmCreateInfo) => {
				alarms.set(name, info);
			}) as never,
			clear: (async (name: string) => alarms.delete(name)) as never,
			get: (async (name: string) =>
				alarms.has(name) ? { name, scheduledTime: 0 } : undefined) as never,
		},
		keepAlive: () => kept++,
	});
}

beforeEach(() => {
	server = new FakeServer();
	http = fakeHttp(server, SERVER, { tess: TESS });
	dev = new FakeServer();
	devHttp = fakeHttp(dev, DEV, { tess: TESS });
	store = new MemoryStore();
	kv = memoryKv();
	changed = [];
	news = 0;
	now = Date.parse("2026-11-19T10:00:00.000Z");
	alarms = new Map();
	kept = 0;
	chosen = SERVER;
	cloud = worker();
});

/** The server chosen now, and its part of the database. */
let chosen = SERVER;
const data = {
	get: (key: string) => kv.data.get(scopeOf(chosen) + key),
	has: (key: string) => kv.data.has(scopeOf(chosen) + key),
};

/** The engine's runs are over: nothing is under way. */
const settled = async () => (await cloud.current()).engine.request();
const status = () => data.get(KEYS.status) as CloudStatus | undefined;

/** Sign in as the panel does: begin, the browser's window, finish. */
async function signIn(code = "code-tess"): Promise<void> {
	const begun = await cloud.handle({ type: "cloud:begin" });
	if (!begun.ok || begun.url === undefined) throw new Error("no sign-in");
	const state = new URL(begun.url).searchParams.get("state");
	const done = await cloud.handle({
		type: "cloud:finish",
		redirect: `${REDIRECT}?code=${code}&state=${state}`,
	});
	if (!done.ok) throw new Error(done.error);
	await settled();
}

/** A device's helpers, on the worker's own store. */
const here = (): Device =>
	({ ...device("here", server.api(TESS)), store }) as Device;

describe("signing in", () => {
	test("begin makes the window's address and keeps the sign-in's secrets until it is back", async () => {
		const begun = await cloud.handle({ type: "cloud:begin" });
		expect(begun.ok).toBe(true);
		const url = new URL((begun as { url: string }).url);
		expect(url.origin).toBe(SERVER);
		expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
		expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
		expect(data.has(PENDING_KEY)).toBe(true);
		expect(data.has(TOKENS_KEY)).toBe(false);
	});

	test("finish takes only its own sign-in's answer; then the tokens, who it is, the team, a first sync", async () => {
		await cloud.handle({ type: "cloud:begin" });
		const wrong = await cloud.handle({
			type: "cloud:finish",
			redirect: `${REDIRECT}?code=code-tess&state=someone-elses`,
		});
		expect(wrong).toEqual({
			ok: false,
			error: "The sign-in's answer is not for this sign-in.",
		});
		expect(data.has(TOKENS_KEY)).toBe(false);
		// One try per sign-in: its secrets are gone.
		expect(data.has(PENDING_KEY)).toBe(false);
		expect(
			await cloud.handle({ type: "cloud:finish", redirect: REDIRECT }),
		).toEqual({ ok: false, error: "No sign-in is under way. Try again." });

		await signIn();
		expect((data.get(TOKENS_KEY) as Tokens).refresh).toStartWith("rt_tess");
		const account = data.get(KEYS.account) as Account;
		expect(account.user).toEqual(TESS);
		expect(account.server).toBe(SERVER);
		expect(account.teamId).toBe(TEAM);
		expect(status()?.state).toBe("synced");
		expect(news).toBeGreaterThan(0);
		// It looks now and then from here on.
		expect(alarms.get(CLOUD_ALARM)).toEqual({
			periodInMinutes: LOOK_EVERY_MINUTES,
		});
	});

	test("a code the server does not take is said, and nobody is signed in", async () => {
		await expect(signIn("code-nobody")).rejects.toThrow("no longer valid");
		expect(data.has(KEYS.account)).toBe(false);
		expect(data.has(TOKENS_KEY)).toBe(false);
	});

	test("the token for the events stream: only for who is signed in, renewed when it was refused", async () => {
		expect(await cloud.handle({ type: "cloud:token" })).toEqual({
			ok: false,
			error: "Not signed in.",
		});
		await signIn();
		const first = await cloud.handle({ type: "cloud:token" });
		expect(first).toEqual({ ok: true, token: "at_tess_1" });
		const fresh = await cloud.handle({ type: "cloud:token", fresh: true });
		expect(fresh).toEqual({ ok: true, token: "at_tess_2" });
		expect((data.get(TOKENS_KEY) as Tokens).refresh).toBe("rt_tess_2");
	});
});

describe("syncing from the worker", () => {
	test("a change here goes after a quiet moment; a change there comes when the stream tells of it", async () => {
		await signIn();
		const d = here();
		await startCase(d, "c_1");
		await addMark(d, "c_1", "One");
		cloud.request();
		cloud.request();
		await Bun.sleep(400);
		await settled();
		expect(server.marksOf("c_1").map((m) => m.comment)).toEqual(["One"]);

		// A teammate changes it: the panel hears the team's revision and says so.
		const other = device("dana", server.api({ id: "u_dana", name: "Dana" }));
		await other.engine.signedIn(SERVER, await other.api.me());
		await change(other, "c_1", (c, at) =>
			withComment(c, "a1", "Dana's words", at),
		);
		await other.engine.request();
		const seen = data.get(KEYS.cursor) as number;
		http.state.requests.length = 0;
		// Where this device is already: nothing is asked.
		await cloud.handle({ type: "cloud:run", cursor: seen });
		await Bun.sleep(400);
		expect(http.state.requests).toEqual([]);
		changed.length = 0;
		await cloud.handle({ type: "cloud:run", cursor: seen + 1 });
		await Bun.sleep(400);
		await settled();
		expect((await store.getCase("c_1"))?.annotations[0]?.comment).toBe(
			"Dana's words",
		);
		// The panels and the folder sync are told of the case.
		expect(changed).toEqual(["c_1"]);
	});

	test("a worker that starts again soon after a sync does not ask the server; one with work left does", async () => {
		await signIn();
		http.state.requests.length = 0;
		now += 10_000;
		cloud = worker();
		cloud.start();
		await Bun.sleep(400);
		expect(http.state.requests).toEqual([]);
		// Minutes later: it looks.
		now += 5 * 60_000;
		cloud = worker();
		cloud.start();
		await Bun.sleep(400);
		await settled();
		expect(http.state.requests.some((r) => r.endsWith("/changes"))).toBe(true);
		// The alarm was not made anew: its wait goes on.
		expect(alarms.size).toBe(1);
	});

	test("the alarms are the sync's: its own start a run, another's is left", async () => {
		await signIn();
		expect(cloud.alarm("sitegloss-keep-ai-on")).toBe(false);
		http.state.requests.length = 0;
		expect(cloud.alarm(CLOUD_ALARM)).toBe(true);
		await Bun.sleep(400);
		await settled();
		expect(http.state.requests.some((r) => r.endsWith("/changes"))).toBe(true);
	});

	test("the server away: tried again in half a minute, then a minute; back: no more", async () => {
		await signIn();
		http.state.offline = true;
		cloud.request();
		await Bun.sleep(400);
		await settled();
		expect(status()?.state).toBe("offline");
		expect(alarms.get(CLOUD_RETRY_ALARM)).toEqual({ delayInMinutes: 1 });
		http.state.offline = false;
		cloud.alarm(CLOUD_RETRY_ALARM);
		await Bun.sleep(400);
		await settled();
		expect(status()?.state).toBe("synced");
		expect(alarms.has(CLOUD_RETRY_ALARM)).toBe(false);
	});

	test("tokens the server refuses: once with new ones; refused again, the user is asked to sign in, and signing in goes on", async () => {
		await signIn();
		const d = here();
		await startCase(d, "c_1");
		await addMark(d, "c_1", "One");
		http.state.expired = true;
		cloud.request();
		await Bun.sleep(400);
		await settled();
		expect(status()?.state).toBe("signed-out");
		expect((data.get(KEYS.account) as Account).expired).toBe(true);
		// It tried a new token before it gave up.
		expect(http.state.requests).toContain("POST /api/auth/oauth2/token");
		// No look while signed out; the alarm is gone.
		http.state.expired = false;
		await signIn();
		expect(status()?.state).toBe("synced");
		expect(server.marksOf("c_1")).toHaveLength(1);
	});
});

describe("signing out, and the server's address", () => {
	test("signing out ends the grant at the server, wipes the tokens, and stops looking", async () => {
		await signIn();
		const refresh = (data.get(TOKENS_KEY) as Tokens).refresh;
		expect(await cloud.handle({ type: "cloud:sign-out" })).toEqual({
			ok: true,
		});
		expect(http.state.revoked).toEqual([refresh]);
		expect(data.has(TOKENS_KEY)).toBe(false);
		expect(data.has(KEYS.account)).toBe(false);
		expect(alarms.has(CLOUD_ALARM)).toBe(false);
		expect(status()?.state).toBe("off");
		// The server cannot be reached: wiped here all the same.
		await signIn();
		http.state.offline = true;
		expect(await cloud.handle({ type: "cloud:sign-out" })).toEqual({
			ok: true,
		});
		expect(data.has(TOKENS_KEY)).toBe(false);
	});

	test("another server: https, or this machine; only while nobody is signed in", async () => {
		expect(await cloud.server()).toBe(SERVER);
		expect(
			await cloud.handle({
				type: "cloud:server",
				server: "http://sitegloss.example",
			}),
		).toEqual({
			ok: false,
			error:
				"Plain http: works only for localhost; use https: for other hosts.",
		});
		expect(
			await cloud.handle({
				type: "cloud:server",
				server: " http://localhost:3200/app ",
			}),
		).toEqual({ ok: true });
		expect(await cloud.server()).toBe("http://localhost:3200");
		// Nothing there answers as a Sitegloss server: no sign-in starts.
		expect(await cloud.handle({ type: "cloud:begin" })).toEqual({
			ok: false,
			error:
				"localhost:3200 does not answer as a Sitegloss server (it answered 404).",
		});
		// Empty: sitegloss.dev's again.
		await cloud.handle({ type: "cloud:server", server: "" });
		expect(await cloud.server()).toBe(SERVER);
		await signIn();
		expect(
			await cloud.handle({
				type: "cloud:server",
				server: "https://other.example",
			}),
		).toEqual({ ok: false, error: "Sign out before choosing another server." });
		expect(await cloud.server()).toBe(SERVER);
	});
});

describe("each server is kept apart (DEC-041)", () => {
	const modes = () => data.get(KEYS.modes) as Record<string, string>;
	const book = (caseId: string) =>
		data.get(`case:${caseId}`) as CaseBook | undefined;
	const choose = async (to: string) => {
		expect(
			await cloud.handle({
				type: "cloud:server",
				server: to === SERVER ? "" : to,
			}),
		).toEqual({ ok: true });
		chosen = to;
	};
	const signOut = async () => {
		expect(await cloud.handle({ type: "cloud:sign-out" })).toEqual({
			ok: true,
		});
	};

	test("what synced with one server never reaches another; switching back finds it as it was", async () => {
		// With the service: a case, synced with the team there.
		await signIn();
		await startCase(here(), "c_prod");
		await addMark(here(), "c_prod", "For the real team");
		await settled();
		expect(server.marksOf("c_prod").map((m) => m.comment)).toEqual([
			"For the real team",
		]);
		const before = structuredClone(book("c_prod"));
		expect(before?.mode).toBe("synced");
		const prodTokens = data.get(TOKENS_KEY) as Tokens;

		// The development server: signed out here first, then chosen.
		await signOut();
		await choose(DEV);
		expect(await cloud.server()).toBe(DEV);
		// Nothing of the service's is this server's: no account, no tokens.
		expect(data.has(KEYS.account)).toBe(false);
		expect(data.has(TOKENS_KEY)).toBe(false);
		const asked = http.state.requests.length;
		await signIn();
		expect((data.get(KEYS.account) as Account).server).toBe(DEV);
		// The case of the service's team is on this device only here, and is
		// not among the cases the user is asked about in one go.
		expect(modes()).toEqual({ c_prod: "local" });
		expect(status()?.undecided).toBe(0);
		expect(dev.cases.size).toBe(0);

		// A case made now is the development team's, and no one else's.
		await startCase(here(), "c_dev");
		await addMark(here(), "c_dev", "Only a test");
		await settled();
		expect([...dev.cases.keys()]).toEqual(["c_dev"]);
		expect([...server.cases.keys()]).toEqual(["c_prod"]);
		// A change to the service's case here stays here.
		await change(here(), "c_prod", (c, at) =>
			withComment(c, c.annotations[0]?.id ?? "", "Changed while on dev", at),
		);
		await settled();
		expect(dev.cases.has("c_prod")).toBe(false);
		// The service was not asked anything all the while, and its tokens
		// went nowhere else.
		expect(http.state.requests.length).toBe(asked);
		expect(JSON.stringify(devHttp.state.requests)).not.toContain(
			prodTokens.access,
		);
		// Its book is as it was left: which mark is which, what was confirmed.
		chosen = SERVER;
		expect(book("c_prod")?.marks).toEqual(before?.marks ?? {});
		expect(book("c_prod")?.shadow).toEqual(before?.shadow);
		expect(book("c_prod")?.mode).toBe("local");
		chosen = DEV;

		// Shared there by the user, one case, in so many words: then it goes.
		expect(
			await cloud.handle({ type: "cloud:share", caseId: "c_prod" }),
		).toEqual({ ok: true });
		await settled();
		expect(dev.marksOf("c_prod").map((m) => m.comment)).toEqual([
			"Changed while on dev",
		]);

		// Back to the service: the case goes on where it was, with the same
		// marks at the server; the development server's case stays out.
		await signOut();
		await choose(SERVER);
		await signIn();
		expect(modes()).toEqual({ c_prod: "synced", c_dev: "local" });
		expect(status()?.undecided).toBe(0);
		expect(book("c_prod")?.marks).toEqual(before?.marks ?? {});
		expect(server.marksOf("c_prod").map((m) => m.comment)).toEqual([
			"Changed while on dev",
		]);
		expect([...server.cases.keys()]).toEqual(["c_prod"]);
		expect(status()?.state).toBe("synced");
		// The development server's part is still there, for the next time.
		chosen = DEV;
		expect(book("c_dev")?.shadow).toBeDefined();
		expect(data.has(TOKENS_KEY)).toBe(false);
	});

	test("the server is chosen only while nobody is signed in, and choosing asks no server anything", async () => {
		await choose(DEV);
		expect(http.state.requests).toEqual([]);
		expect(devHttp.state.requests).toEqual([]);
		await signIn();
		expect(await cloud.handle({ type: "cloud:server", server: "" })).toEqual({
			ok: false,
			error: "Sign out before choosing another server.",
		});
		expect(await cloud.server()).toBe(DEV);
	});

	test("a case deleted here while signed out is not deleted for the team by signing in again", async () => {
		await signIn();
		await startCase(here(), "c_gone");
		await addMark(here(), "c_gone", "Still the team's");
		await settled();
		await signOut();
		await store.deleteCase("c_gone");
		await signIn();
		expect(server.cases.get("c_gone")?.deleted).toBe(false);
		// It is the team's, so it is here again.
		expect((await store.getCase("c_gone"))?.annotations).toHaveLength(1);
	});
});
