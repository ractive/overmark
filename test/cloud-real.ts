/**
 * A real sitegloss.dev server for tests, when one is named
 * (`SITEGLOSS_SERVER`, with its demo users' password in
 * `SITEGLOSS_PASSWORD`): the demo users sign in as the extension does, by
 * the authorization code flow with PKCE. For a device that is no browser,
 * the browser's window is replaced: by signing in with the password and
 * answering the consent page over HTTP.
 */

import { type Api, httpApi } from "../src/lib/cloud/api.ts";
import {
	beginSignIn,
	codeFrom,
	exchangeCode,
	Session,
} from "../src/lib/cloud/auth.ts";
import { memoryKv } from "../src/lib/kv.ts";
import { type Device, device } from "./cloud-helpers.ts";

/** The server's address; `undefined`: none is named, and its tests are skipped. */
export const SERVER = process.env["SITEGLOSS_SERVER"]?.replace(/\/+$/, "");

/**
 * The demo users' password, which the server's demo data sets (its
 * `scripts/demo.ts`): given, not written down here.
 */
export const PASSWORD = process.env["SITEGLOSS_PASSWORD"] ?? "";

if (SERVER !== undefined && PASSWORD === "")
	throw new Error(
		"SITEGLOSS_SERVER names a server: SITEGLOSS_PASSWORD has to give its demo users' password too",
	);
/** The redirect of the keyed Chrome build: the one the local server allows. */
const REDIRECT =
	process.env["SITEGLOSS_REDIRECT"] ??
	"https://ldmcfigcnobhnbaigehcaodheklibeon.chromiumapp.org/";

/** Sign in as the browser's window would, and answer with the address it ends on. */
export async function signInWindow(
	base: string,
	email: string,
	url: string,
): Promise<string> {
	const jar = new Map<string, string>();
	const call = async (path: string, init: RequestInit = {}) => {
		const response = await fetch(path.startsWith("http") ? path : base + path, {
			redirect: "manual",
			...init,
			headers: {
				origin: base,
				cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
				...init.headers,
			},
		});
		for (const cookie of response.headers.getSetCookie()) {
			const [pair = ""] = cookie.split(";");
			const at = pair.indexOf("=");
			jar.set(pair.slice(0, at), pair.slice(at + 1));
		}
		return response;
	};
	const json = (body: unknown): RequestInit => ({
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const signed = await call(
		"/api/auth/sign-in/email",
		json({ email, password: PASSWORD }),
	);
	if (!signed.ok) throw new Error(`sign-in as ${email}: ${signed.status}`);
	let at = (await call(url)).headers.get("location") ?? "";
	if (at.includes("/consent")) {
		const consent = await call(
			"/api/auth/oauth2/consent",
			json({ accept: true, oauth_query: at.slice(at.indexOf("?") + 1) }),
		);
		const body = (await consent.json()) as { url?: string };
		at = body.url ?? consent.headers.get("location") ?? at;
	}
	return at;
}

export interface Signed {
	device: Device<Api>;
	session: Session;
	kv: ReturnType<typeof memoryKv>;
}

/** A device signed in at the real server as `email`. */
export async function real(
	base: string,
	name: string,
	email: string,
): Promise<Signed> {
	const kv = memoryKv();
	const session = new Session(kv, (input, init) => fetch(input, init));
	const { pending, url } = await beginSignIn(base, REDIRECT, Date.now());
	const ended = await signInWindow(base, email, url);
	const code = codeFrom(pending, ended, Date.now());
	await session.store(
		await exchangeCode(
			(input, init) => fetch(input, init),
			pending,
			code,
			Date.now(),
		),
	);
	const api = httpApi({
		server: base,
		token: (fresh) => session.access(base, fresh),
	});
	return { device: device(name, api, true), session, kv };
}
