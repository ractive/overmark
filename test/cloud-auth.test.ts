/**
 * Signing in to sitegloss.dev and talking to it (DEC-039): PKCE, the tokens
 * and their rotation, the API over HTTP, and the events stream. The server
 * here is a `fetch` that answers as the real one's token endpoint does.
 */

import { describe, expect, test } from "bun:test";
import { ApiFailure, httpApi } from "../src/lib/cloud/api.ts";
import {
	AuthError,
	beginSignIn,
	CLIENT_ID,
	challengeOf,
	codeFrom,
	exchangeCode,
	OfflineError,
	type PendingSignIn,
	Session,
	serverOrigin,
	serverProblem,
	TOKENS_KEY,
	type Tokens,
} from "../src/lib/cloud/auth.ts";
import { changeCursor, EventParser, listen } from "../src/lib/cloud/sse.ts";
import { memoryKv } from "../src/lib/kv.ts";

const SERVER = "https://app.sitegloss.dev";
const REDIRECT = "https://ldmcfigcnobhnbaigehcaodheklibeon.chromiumapp.org/";

/** A token endpoint whose refresh tokens rotate: a used one ends the grant. */
function tokenServer() {
	let n = 0;
	const state = {
		refresh: "r0",
		revoked: false,
		requests: [] as URLSearchParams[],
		/** How each request was sent: with the browser's cookies, or without. */
		credentials: [] as (RequestCredentials | undefined)[],
		offline: false,
		/** Leave the new refresh token out of the next answer. */
		keepRefresh: false,
	};
	const fetcher = async (
		input: string,
		init?: RequestInit,
	): Promise<Response> => {
		if (state.offline) throw new TypeError("Failed to fetch");
		const body = new URLSearchParams(String(init?.body ?? ""));
		state.requests.push(body);
		state.credentials.push(init?.credentials);
		if (input.endsWith("/revoke")) {
			state.revoked = true;
			return Response.json({});
		}
		if (body.get("grant_type") === "authorization_code") {
			if (body.get("code") !== "the-code")
				return Response.json({ error: "invalid_grant" }, { status: 400 });
			state.refresh = `r${++n}`;
			return Response.json({
				access_token: `a${n}`,
				refresh_token: state.refresh,
				expires_in: 3600,
				token_type: "Bearer",
				somethingNew: true,
			});
		}
		if (state.revoked || body.get("refresh_token") !== state.refresh) {
			// An old refresh token: the whole grant is gone.
			state.revoked = true;
			return Response.json(
				{ error: "invalid_grant", error_description: "session not found" },
				{ status: 400 },
			);
		}
		state.refresh = `r${++n}`;
		return Response.json({
			access_token: `a${n}`,
			...(state.keepRefresh ? {} : { refresh_token: state.refresh }),
			expires_in: 3600,
		});
	};
	return { state, fetcher };
}

const pending = (at = 1000): PendingSignIn => ({
	server: SERVER,
	verifier: "the-verifier",
	state: "the-state",
	redirect: REDIRECT,
	at,
});

describe("the server's address", () => {
	test("https anywhere, plain http only on this machine", () => {
		expect(serverProblem("https://app.sitegloss.dev")).toBeUndefined();
		expect(serverProblem("http://localhost:3200")).toBeUndefined();
		expect(serverProblem("http://127.0.0.1:3200/")).toBeUndefined();
		expect(serverProblem("http://sitegloss.example")).toBe(
			"Plain http: works only for localhost; use https: for other hosts.",
		);
		expect(serverProblem("ftp://x")).toBe("Use an https: address.");
		expect(serverProblem("not an address")).toBe("Not an address.");
		// Kept as its origin: a path or a slash typed after it means nothing.
		expect(serverOrigin("http://localhost:3200/app/")).toBe(
			"http://localhost:3200",
		);
		expect(serverOrigin("javascript:alert(1)")).toBeUndefined();
	});
});

describe("a sign-in", () => {
	test("the challenge is the verifier's SHA-256 (RFC 7636's example)", async () => {
		expect(
			await challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
		).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	});

	test("the window's address asks for the code with PKCE, the scopes and the API as resource", async () => {
		const { pending: p, url } = await beginSignIn(SERVER, REDIRECT, 1000);
		const at = new URL(url);
		expect(`${at.origin}${at.pathname}`).toBe(
			`${SERVER}/api/auth/oauth2/authorize`,
		);
		const q = at.searchParams;
		expect(q.get("response_type")).toBe("code");
		expect(q.get("client_id")).toBe(CLIENT_ID);
		expect(q.get("redirect_uri")).toBe(REDIRECT);
		expect(q.get("scope")).toBe(
			"openid profile email offline_access cases:read cases:write",
		);
		expect(q.get("code_challenge_method")).toBe("S256");
		expect(q.get("code_challenge")).toBe(await challengeOf(p.verifier));
		expect(q.get("resource")).toBe(`${SERVER}/api`);
		expect(q.get("state")).toBe(p.state);
		// Each sign-in has secrets of its own, and none of them is in the address.
		const again = await beginSignIn(SERVER, REDIRECT, 1000);
		expect(again.pending.verifier).not.toBe(p.verifier);
		expect(again.pending.state).not.toBe(p.state);
		expect(url).not.toContain(p.verifier);
		expect(p.verifier.length).toBeGreaterThanOrEqual(43);
	});

	test("only this sign-in's answer is taken", () => {
		const ok = `${REDIRECT}?code=the-code&state=the-state&iss=x`;
		expect(codeFrom(pending(), ok, 2000)).toBe("the-code");
		expect(() =>
			codeFrom(pending(), `${REDIRECT}?code=c&state=another`, 2000),
		).toThrow("not for this sign-in");
		expect(() =>
			codeFrom(pending(), "https://evil.example/?code=c&state=the-state", 2000),
		).toThrow("another address");
		expect(() =>
			codeFrom(
				pending(),
				`${REDIRECT}?error=access_denied&state=the-state`,
				2000,
			),
		).toThrow("The sign-in was not allowed.");
		expect(() =>
			codeFrom(
				pending(),
				`${REDIRECT}?error=server_error&error_description=Try+later`,
				2000,
			),
		).toThrow("The sign-in failed: Try later");
		expect(() =>
			codeFrom(pending(), `${REDIRECT}?state=the-state`, 2000),
		).toThrow("without a code");
		expect(() => codeFrom(pending(), ok, 1000 + 16 * 60_000)).toThrow(
			"took too long",
		);
		expect(() => codeFrom(pending(), "", 2000)).toThrow(AuthError);
	});

	test("the code is changed for tokens with the verifier, as a public client", async () => {
		const { state, fetcher } = tokenServer();
		const tokens = await exchangeCode(fetcher, pending(), "the-code", 5000);
		expect(tokens).toEqual({
			access: "a1",
			refresh: "r1",
			expiresAt: 5000 + 3600_000,
		});
		const sent = state.requests[0] as URLSearchParams;
		expect(Object.fromEntries(sent)).toEqual({
			grant_type: "authorization_code",
			code: "the-code",
			redirect_uri: REDIRECT,
			code_verifier: "the-verifier",
			client_id: CLIENT_ID,
			resource: `${SERVER}/api`,
		});
		await expect(
			exchangeCode(fetcher, pending(), "wrong", 5000),
		).rejects.toThrow("no longer valid");
		// Never with the browser's cookies: after the sign-in window the
		// browser has the user's session with the server, and the server
		// refuses a request that carries it from the extension's origin.
		expect(state.credentials).toEqual(["omit", "omit"]);
	});
});

describe("the tokens", () => {
	async function signedIn(now = { ms: 10_000 }) {
		const server = tokenServer();
		const kv = memoryKv();
		const session = new Session(kv, server.fetcher, () => now.ms);
		await session.store(
			await exchangeCode(server.fetcher, pending(), "the-code", now.ms),
		);
		return { ...server, kv, session, now };
	}

	test("an access token is used while it holds, and renewed a minute before it runs out", async () => {
		const { state, session, now, kv } = await signedIn();
		expect(await session.access(SERVER)).toBe("a1");
		now.ms += 3600_000 - 61_000;
		expect(await session.access(SERVER)).toBe("a1");
		expect(state.requests).toHaveLength(1);
		now.ms += 2000;
		expect(await session.access(SERVER)).toBe("a2");
		// The refresh request names the API again, and the new refresh token is stored.
		const refresh = state.requests[1] as URLSearchParams;
		expect(Object.fromEntries(refresh)).toEqual({
			grant_type: "refresh_token",
			refresh_token: "r1",
			client_id: CLIENT_ID,
			resource: `${SERVER}/api`,
		});
		expect((kv.data.get(TOKENS_KEY) as Tokens).refresh).toBe("r2");
		// The next renewal uses the new one: the grant lives on.
		expect(await session.access(SERVER, true)).toBe("a3");
		expect(state.revoked).toBe(false);
		expect((kv.data.get(TOKENS_KEY) as Tokens).refresh).toBe("r3");
	});

	test("two who need a new token at once share one renewal: a refresh token is never used twice", async () => {
		const { state, session } = await signedIn();
		const [a, b, c] = await Promise.all([
			session.access(SERVER, true),
			session.access(SERVER, true),
			session.access(SERVER, true),
		]);
		expect([a, b, c]).toEqual(["a2", "a2", "a2"]);
		expect(state.requests).toHaveLength(2);
		expect(state.revoked).toBe(false);
	});

	test("an answer without a new refresh token keeps the one there is", async () => {
		const { state, session, kv } = await signedIn();
		state.keepRefresh = true;
		expect(await session.access(SERVER, true)).toBe("a2");
		expect((kv.data.get(TOKENS_KEY) as Tokens).refresh).toBe("r1");
	});

	test("a grant that is gone says so: sign in again", async () => {
		const { state, session } = await signedIn();
		state.revoked = true;
		const failed = await session.access(SERVER, true).catch((e: unknown) => e);
		expect(failed).toBeInstanceOf(AuthError);
		expect((failed as AuthError).signedOut).toBe(true);
		// And with no tokens at all.
		const none = new Session(memoryKv(), state === undefined ? fetch : fetch);
		const nobody = await none.access(SERVER).catch((e: unknown) => e);
		expect((nobody as AuthError).signedOut).toBe(true);
	});

	test("a server that is not reached is no sign-out: the tokens stay", async () => {
		const { state, session, kv } = await signedIn();
		state.offline = true;
		await expect(session.access(SERVER, true)).rejects.toBeInstanceOf(
			OfflineError,
		);
		expect((kv.data.get(TOKENS_KEY) as Tokens).refresh).toBe("r1");
		state.offline = false;
		expect(await session.access(SERVER, true)).toBe("a2");
	});

	test("signing out wipes the tokens here and ends the grant at the server", async () => {
		const { state, session, kv } = await signedIn();
		await session.end(SERVER);
		expect(kv.data.has(TOKENS_KEY)).toBe(false);
		expect(state.revoked).toBe(true);
		const revoke = state.requests.at(-1) as URLSearchParams;
		expect(Object.fromEntries(revoke)).toEqual({
			token: "r1",
			token_type_hint: "refresh_token",
			client_id: CLIENT_ID,
		});
		// Offline: wiped here all the same.
		const other = await signedIn();
		other.state.offline = true;
		await other.session.end(SERVER);
		expect(other.kv.data.has(TOKENS_KEY)).toBe(false);
	});
});

describe("the API over HTTP", () => {
	function server(answers: (Response | Error)[]) {
		const calls: {
			url: string;
			auth: string | null;
			method: string;
			credentials: RequestCredentials | undefined;
		}[] = [];
		const tokens: boolean[] = [];
		const api = httpApi({
			server: SERVER,
			token: async (fresh) => {
				tokens.push(fresh);
				return fresh ? "new" : "old";
			},
			fetch: async (url, init) => {
				calls.push({
					url,
					auth: new Headers(init?.headers).get("authorization"),
					method: init?.method ?? "GET",
					credentials: init?.credentials,
				});
				const next = answers.shift();
				if (next === undefined) throw new Error("no answer left");
				if (next instanceof Error) throw next;
				return next;
			},
		});
		return { api, calls, tokens };
	}

	test("every call carries the token; a refused token is renewed once", async () => {
		const { api, calls, tokens } = server([
			Response.json(
				{ error: { code: "unauthorized", message: "no" } },
				{ status: 401 },
			),
			Response.json({
				user: { id: "u", name: "Tess", email: "t@e", image: null },
				teams: [],
				later: 1,
			}),
		]);
		const me = await api.me();
		expect(me.user.name).toBe("Tess");
		expect(calls.map((c) => c.auth)).toEqual(["Bearer old", "Bearer new"]);
		// The token says who calls; the browser's cookies stay out of it.
		expect(calls.map((c) => c.credentials)).toEqual(["omit", "omit"]);
		expect(tokens).toEqual([false, true]);
		expect(calls[0]?.url).toBe(`${SERVER}/api/v1/me`);
	});

	test("refused twice: the sign-in is over", async () => {
		const { api } = server([
			new Response("", { status: 401 }),
			new Response("", { status: 401 }),
		]);
		const failed = (await api.me().catch((e: unknown) => e)) as ApiFailure;
		expect(failed).toBeInstanceOf(ApiFailure);
		expect(failed.kind).toBe("unauthorized");
	});

	test("what went wrong is told apart: not reached, the server's fault, the server's no", async () => {
		const offline = server([new TypeError("Failed to fetch")]);
		expect(
			((await offline.api.me().catch((e: unknown) => e)) as ApiFailure).kind,
		).toBe("offline");
		const broken = server([new Response("oops", { status: 502 })]);
		expect(
			((await broken.api.me().catch((e: unknown) => e)) as ApiFailure).kind,
		).toBe("server");
		const refused = server([
			Response.json(
				{
					error: {
						code: "forbidden",
						message: "Your role does not allow this.",
					},
				},
				{ status: 403 },
			),
		]);
		const no = (await refused.api
			.changes("team 1", 7)
			.catch((e: unknown) => e)) as ApiFailure;
		expect([no.kind, no.status, no.code, no.message]).toEqual([
			"refused",
			403,
			"forbidden",
			"Your role does not allow this.",
		]);
		expect(refused.calls[0]?.url).toBe(
			`${SERVER}/api/v1/teams/team%201/changes?since=7`,
		);
	});

	test("images: asked for by HEAD, sent as WebP, a missing one is an answer", async () => {
		const sha = "a".repeat(64);
		const { api, calls } = server([
			new Response(null, { status: 404 }),
			Response.json({ sha256: sha, bytes: 3, width: 1, height: 1 }),
			new Response(new Blob(["abc"]), {
				headers: { "content-type": "image/webp" },
			}),
		]);
		expect(await api.hasBlob("t", sha)).toBe(false);
		await api.putBlob("t", sha, new Blob(["abc"]));
		expect(await (await api.getBlob("t", sha)).text()).toBe("abc");
		expect(calls.map((c) => c.method)).toEqual(["HEAD", "PUT", "GET"]);
		expect(calls[1]?.url).toBe(`${SERVER}/api/v1/teams/t/blobs/${sha}`);
	});
});

describe("the events stream", () => {
	test("events are read as they arrive, whatever the pieces", () => {
		const parser = new EventParser();
		expect(parser.push("retry: 3000\n\nevent: cha")).toEqual([]);
		expect(parser.retry).toBe(3000);
		expect(parser.push('nge\ndata: {"cur')).toEqual([]);
		const [event] = parser.push('sor":12}\n\n: still here\n\n');
		expect(event).toEqual({ event: "change", data: '{"cursor":12}' });
		expect(event && changeCursor(event)).toBe(12);
		// Other line ends, a field without a value, an event this build does not know.
		expect(parser.push("event: later\r\ndata: x\r\n\r\ndata\n\n")).toEqual([
			{ event: "later", data: "x" },
			{ event: "message", data: "" },
		]);
		expect(changeCursor({ event: "later", data: "x" })).toBeUndefined();
		expect(changeCursor({ event: "change", data: "not json" })).toBeUndefined();
	});

	/** A stream that sends `text` and ends. */
	const stream = (text: string) =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(text));
					controller.close();
				},
			}),
		);

	test("each change is handed on; an ended stream is connected again, with a fresh token after a no", async () => {
		const end = new AbortController();
		const cursors: number[] = [];
		const asked: boolean[] = [];
		const auths: (string | null)[] = [];
		const waits: number[] = [];
		const answers = [
			stream('retry: 3000\n\nevent: change\ndata: {"cursor":5}\n\n'),
			new Response("", { status: 401 }),
			stream(
				'event: change\ndata: {"cursor":6}\n\nevent: change\ndata: {"cursor":7}\n\n',
			),
		];
		await listen({
			url: "https://x/events",
			token: async (fresh) => {
				asked.push(fresh);
				return fresh ? "new" : "old";
			},
			onChange: (cursor) => {
				cursors.push(cursor);
				if (cursor === 7) end.abort();
			},
			signal: end.signal,
			fetch: async (_url, init) => {
				auths.push(new Headers(init?.headers).get("authorization"));
				return answers.shift() ?? new Response("", { status: 500 });
			},
			sleep: async (ms) => {
				waits.push(ms);
			},
		});
		expect(cursors).toEqual([5, 6, 7]);
		expect(asked).toEqual([false, false, true]);
		expect(auths).toEqual(["Bearer old", "Bearer old", "Bearer new"]);
		// After a clean end: the server's retry. After the no: at once.
		expect(waits).toEqual([3000, 0]);
	});

	test("failures wait longer each time, up to a minute; nobody signed in ends it", async () => {
		const waits: number[] = [];
		let tries = 0;
		await listen({
			url: "https://x/events",
			token: async () => (++tries > 8 ? undefined : "t"),
			onChange: () => undefined,
			signal: new AbortController().signal,
			fetch: async () => {
				throw new TypeError("Failed to fetch");
			},
			sleep: async (ms) => {
				waits.push(ms);
			},
		});
		expect(waits).toEqual([
			2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
		]);
	});
});
