/**
 * Signing in to sitegloss.dev (DEC-039): OAuth 2.1 with PKCE as a public
 * client, in plain `fetch` and Web Crypto. The browser's own sign-in window
 * (`identity.launchWebAuthFlow`) is the caller's: this file only makes the
 * address it opens and reads the address it ends on, so it runs in a test as
 * it does in the worker.
 *
 * Refresh tokens rotate: every answer carries a new one, which is stored
 * before anything else is done with the access token, and an old one used
 * again ends the grant at the server. So one place refreshes (the service
 * worker), one refresh at a time.
 */

import type { Kv } from "../kv.ts";

/** The extension, as the server knows it: a public client, no secret. */
export const CLIENT_ID = "sitegloss-extension";

export const SCOPE =
	"openid profile email offline_access cases:read cases:write";

/** The service, unless the user set another address. */
export const DEFAULT_SERVER = "https://app.sitegloss.dev";

/** Hosts a server may have over plain http: one's own machine. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Why `value` is no server address, or `undefined`. */
export function serverProblem(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "Not an address.";
	}
	if (url.protocol === "https:") return undefined;
	if (url.protocol !== "http:") return "Use an https: address.";
	return LOOPBACK.has(url.hostname)
		? undefined
		: "Plain http: works only for localhost; use https: for other hosts.";
}

/** A server address as it is kept: its origin. `undefined`: not one. */
export function serverOrigin(value: string): string | undefined {
	return serverProblem(value) === undefined ? new URL(value).origin : undefined;
}

/** The API's name in a token request: what makes the access token one for it. */
const resourceOf = (server: string) => `${server}/api`;

const endpoint = (server: string, name: "authorize" | "token" | "revoke") =>
	`${server}/api/auth/oauth2/${name}`;

/** What the server gave at sign-in or at the last refresh. */
export interface Tokens {
	access: string;
	refresh: string;
	/** When the access token runs out (ms since the epoch). */
	expiresAt: number;
}

/** A sign-in under way: kept until the browser's window comes back. */
export interface PendingSignIn {
	server: string;
	verifier: string;
	state: string;
	redirect: string;
	/** When it started (ms): an old one is not finished. */
	at: number;
}

/** The sign-in cannot go on, or the session is over: said to the user as it is. */
export class AuthError extends Error {
	override name = "AuthError";
	constructor(
		message: string,
		/** The grant is gone (revoked, expired, used twice): sign in again. */
		readonly signedOut = false,
	) {
		super(message);
	}
}

const base64url = (bytes: Uint8Array): string =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

/** 32 random bytes as base64url: a PKCE verifier, or a state. */
export function randomToken(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The S256 challenge of a PKCE verifier. */
export async function challengeOf(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	return base64url(new Uint8Array(digest));
}

/** A sign-in's secret parts, and the address the browser's window opens. */
export async function beginSignIn(
	server: string,
	redirect: string,
	now: number,
): Promise<{ pending: PendingSignIn; url: string }> {
	const pending: PendingSignIn = {
		server,
		verifier: randomToken(),
		state: randomToken(),
		redirect,
		at: now,
	};
	const query = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		redirect_uri: redirect,
		scope: SCOPE,
		state: pending.state,
		code_challenge: await challengeOf(pending.verifier),
		code_challenge_method: "S256",
		resource: resourceOf(server),
	});
	return { pending, url: `${endpoint(server, "authorize")}?${query}` };
}

/** How long a sign-in's window may stay open. */
export const SIGN_IN_MAX_MS = 15 * 60_000;

/**
 * The code in the address the browser's window ended on. Refused: an address
 * that is not this sign-in's (another redirect, another state), and the
 * server's own "no" (`error`), in its words.
 */
export function codeFrom(
	pending: PendingSignIn,
	ended: string,
	now: number,
): string {
	let url: URL;
	try {
		url = new URL(ended);
	} catch {
		throw new AuthError("The sign-in did not come back with an address.");
	}
	if (now - pending.at > SIGN_IN_MAX_MS)
		throw new AuthError("The sign-in took too long. Try again.");
	const back = new URL(pending.redirect);
	if (url.origin !== back.origin || url.pathname !== back.pathname)
		throw new AuthError("The sign-in came back to another address.");
	const failed = url.searchParams.get("error");
	if (failed !== null)
		throw new AuthError(
			failed === "access_denied"
				? "The sign-in was not allowed."
				: `The sign-in failed: ${(url.searchParams.get("error_description") ?? failed).slice(0, 300)}`,
		);
	if (url.searchParams.get("state") !== pending.state)
		throw new AuthError("The sign-in's answer is not for this sign-in.");
	const code = url.searchParams.get("code");
	if (code === null || code === "")
		throw new AuthError("The sign-in came back without a code.");
	return code;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The token endpoint's answer, as far as it is used. */
function tokensOf(body: unknown, now: number, before?: Tokens): Tokens {
	const o = (typeof body === "object" && body !== null ? body : {}) as Record<
		string,
		unknown
	>;
	const access = o["access_token"];
	const refresh = o["refresh_token"] ?? before?.refresh;
	const expires = o["expires_in"];
	if (typeof access !== "string" || typeof refresh !== "string")
		throw new AuthError("The server's answer holds no tokens.");
	return {
		access,
		refresh,
		expiresAt:
			now + (typeof expires === "number" && expires > 0 ? expires : 300) * 1000,
	};
}

async function tokenRequest(
	fetcher: Fetch,
	server: string,
	fields: Record<string, string>,
	now: number,
	before?: Tokens,
): Promise<Tokens> {
	let response: Response;
	try {
		response = await fetcher(endpoint(server, "token"), {
			method: "POST",
			// No cookies, ever: the browser has the user's session with the
			// server after the sign-in window, and a request that carries it
			// from the extension's origin is refused there (and rightly: the
			// extension is its tokens, not the user's session).
			credentials: "omit",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				...fields,
				client_id: CLIENT_ID,
				resource: resourceOf(server),
			}).toString(),
		});
	} catch (error) {
		throw new OfflineError(error);
	}
	const body: unknown = await response.json().catch(() => undefined);
	if (response.ok) return tokensOf(body, now, before);
	const code = (body as { error?: unknown } | undefined)?.error;
	// The grant is gone: an answer of the server's about this token, not a
	// server that is down.
	if (
		response.status === 400 ||
		response.status === 401 ||
		code === "invalid_grant"
	)
		throw new AuthError("The sign-in is no longer valid. Sign in again.", true);
	throw new AuthError(`The server answered ${response.status} to the sign-in.`);
}

/** The server could not be reached at all: try again later. */
export class OfflineError extends Error {
	override name = "OfflineError";
	constructor(cause: unknown) {
		super(
			`The server could not be reached${cause instanceof Error && cause.message ? ` (${cause.message})` : ""}.`,
		);
	}
}

/** Change a sign-in's code for tokens. */
export function exchangeCode(
	fetcher: Fetch,
	pending: PendingSignIn,
	code: string,
	now: number,
): Promise<Tokens> {
	return tokenRequest(
		fetcher,
		pending.server,
		{
			grant_type: "authorization_code",
			code,
			redirect_uri: pending.redirect,
			code_verifier: pending.verifier,
		},
		now,
	);
}

/** New tokens for a refresh token; the old one is used up by this. */
export function refreshTokens(
	fetcher: Fetch,
	server: string,
	tokens: Tokens,
	now: number,
): Promise<Tokens> {
	return tokenRequest(
		fetcher,
		server,
		{ grant_type: "refresh_token", refresh_token: tokens.refresh },
		now,
		tokens,
	);
}

/** End the grant at the server; a server that cannot be reached is left. */
export async function revokeTokens(
	fetcher: Fetch,
	server: string,
	tokens: Tokens,
): Promise<boolean> {
	try {
		const response = await fetcher(endpoint(server, "revoke"), {
			method: "POST",
			credentials: "omit",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				token: tokens.refresh,
				token_type_hint: "refresh_token",
				client_id: CLIENT_ID,
			}).toString(),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/** Keys of the tokens in the cloud's database (book.ts has the rest). */
export const TOKENS_KEY = "tokens";
export const PENDING_KEY = "sign-in";

/** An access token is renewed this long before it runs out. */
const EARLY_MS = 60_000;

/**
 * The tokens of the signed-in user: read from the database at each use (a
 * worker restarts), renewed when they are about to run out, one renewal at a
 * time. `server` is where they are from.
 */
export class Session {
	#renewing: Promise<Tokens> | undefined;

	constructor(
		private readonly kv: Kv,
		private readonly fetcher: Fetch,
		private readonly now: () => number = Date.now,
	) {}

	async tokens(): Promise<Tokens | undefined> {
		const stored = (await this.kv.get(TOKENS_KEY)) as Tokens | undefined;
		return typeof stored?.access === "string" &&
			typeof stored.refresh === "string"
			? stored
			: undefined;
	}

	/**
	 * An access token that still holds; `fresh`: a new one whatever the old
	 * one's time says (the server refused it). `AuthError` with `signedOut`
	 * when there are no tokens or the grant is gone.
	 */
	async access(server: string, fresh = false): Promise<string> {
		const tokens = await this.tokens();
		if (tokens === undefined)
			throw new AuthError("Not signed in. Sign in again.", true);
		if (!fresh && tokens.expiresAt - EARLY_MS > this.now())
			return tokens.access;
		return (await this.#renew(server, tokens)).access;
	}

	#renew(server: string, tokens: Tokens): Promise<Tokens> {
		// One at a time: the second caller's refresh token would be the used one.
		this.#renewing ??= (async () => {
			try {
				const next = await refreshTokens(
					this.fetcher,
					server,
					tokens,
					this.now(),
				);
				// Stored before it is used: the old refresh token is spent.
				await this.kv.set({ [TOKENS_KEY]: next });
				return next;
			} finally {
				this.#renewing = undefined;
			}
		})();
		return this.#renewing;
	}

	async store(tokens: Tokens): Promise<void> {
		await this.kv.set({ [TOKENS_KEY]: tokens });
	}

	/** Forget the tokens here, and end the grant at the server if it answers. */
	async end(server: string | undefined): Promise<void> {
		const tokens = await this.tokens();
		await this.kv.remove(TOKENS_KEY);
		if (tokens !== undefined && server !== undefined)
			await revokeTokens(this.fetcher, server, tokens);
	}
}
