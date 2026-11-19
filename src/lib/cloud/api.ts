/**
 * The sitegloss.dev API, version 1, as the extension uses it (DEC-039): its
 * types by their names here, and a client in plain `fetch`. The types are
 * generated (`api.gen.ts`); the contract's rule is that version 1 only
 * grows, so nothing here fails on a field, an error code or a kind of removed
 * thing it does not know: it is left out, or treated as the nearest thing
 * known.
 */

import type { components } from "./api.gen.ts";
import { AuthError, OfflineError } from "./auth.ts";

type Schemas = components["schemas"];

export type WireCase = Schemas["Case"];
export type WireShot = Schemas["Shot"];
export type WireMark = Schemas["Mark"];
export type WirePage = Schemas["Page"];
export type WireResolution = Schemas["Resolution"];
export type WireReopen = Schemas["Reopen"];
export type WireFinding = Schemas["Finding"];
export type WireElement = Schemas["ElementDetails"];
export type ImageRef = Schemas["ImageRef"];
export type UserRef = Schemas["UserRef"];
export type Op = Schemas["Op"];
export type OpType = Op["type"];
export type OpOf<T extends OpType> = Extract<Op, { type: T }>;
export type OpResult = Schemas["OpResult"];
export type OpsResponse = Schemas["OpsResponse"];
export type Changes = Schemas["Changes"];
export type Removed = Schemas["Removed"];
export type Me = Schemas["Me"];
export type Team = Schemas["TeamMembership"];

/** The most operations in one request, and about how much text. */
export const MAX_OPS = 100;
export const MAX_OPS_BYTES = 2_000_000;

/** What a call to the server came to when it did not answer with what was asked. */
export class ApiFailure extends Error {
	override name = "ApiFailure";
	constructor(
		/**
		 * `offline`: no answer at all. `unauthorized`: the sign-in is over.
		 * `refused`: the server's no to this request (its `code` says why).
		 * `server`: it failed, or is busy; later may work.
		 */
		readonly kind: "offline" | "unauthorized" | "refused" | "server",
		message: string,
		readonly status?: number,
		readonly code?: string,
	) {
		super(message);
	}
}

/** The calls the extension makes. The engine gets this; tests give it a fake. */
export interface Api {
	me(): Promise<Me>;
	/** Everything after `since`; without it, the whole state. */
	changes(teamId: string, since: number | undefined): Promise<Changes>;
	ops(teamId: string, ops: readonly Op[]): Promise<OpsResponse>;
	hasBlob(teamId: string, sha256: string): Promise<boolean>;
	putBlob(teamId: string, sha256: string, image: Blob): Promise<void>;
	getBlob(teamId: string, sha256: string): Promise<Blob>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpApiOptions {
	/** The server's origin. */
	server: string;
	/** An access token; `fresh`: a new one, the server refused the last. */
	token: (fresh: boolean) => Promise<string>;
	fetch?: Fetch;
}

const team = (id: string) => `/api/v1/teams/${encodeURIComponent(id)}`;

/** The address of a team's events stream (sse.ts listens to it). */
export const eventsUrl = (server: string, teamId: string) =>
	`${server}${team(teamId)}/events`;

/** The server's error body, as far as it has the known shape. */
async function refusal(response: Response): Promise<ApiFailure> {
	let code: string | undefined;
	let message: string | undefined;
	try {
		const body = (await response.json()) as {
			error?: { code?: unknown; message?: unknown };
		};
		if (typeof body.error?.code === "string") code = body.error.code;
		if (typeof body.error?.message === "string")
			message = body.error.message.slice(0, 500);
	} catch {
		// No JSON: the status says what there is to say.
	}
	const said = message ?? `The server answered ${response.status}.`;
	if (response.status === 401)
		return new ApiFailure("unauthorized", said, 401, code);
	if (response.status >= 500 || response.status === 429)
		return new ApiFailure("server", said, response.status, code);
	return new ApiFailure("refused", said, response.status, code);
}

/** The API over HTTP. A 401 is tried once more with a fresh token. */
export function httpApi(options: HttpApiOptions): Api {
	const fetcher: Fetch = options.fetch ?? ((input, init) => fetch(input, init));

	async function send(
		path: string,
		init: RequestInit,
		fresh: boolean,
	): Promise<Response> {
		let token: string;
		try {
			token = await options.token(fresh);
		} catch (error) {
			if (error instanceof OfflineError)
				throw new ApiFailure("offline", error.message);
			if (error instanceof AuthError)
				throw new ApiFailure(
					error.signedOut ? "unauthorized" : "server",
					error.message,
				);
			throw error;
		}
		try {
			return await fetcher(`${options.server}${path}`, {
				...init,
				cache: "no-store",
				// The token says who is calling; the browser's cookies for the
				// server (the user's session there) stay out of it.
				credentials: "omit",
				headers: { ...init.headers, authorization: `Bearer ${token}` },
			});
		} catch (error) {
			throw new ApiFailure(
				"offline",
				`The server could not be reached${error instanceof Error && error.message ? ` (${error.message})` : ""}.`,
			);
		}
	}

	async function call(
		path: string,
		init: RequestInit = {},
		/** Statuses that are an answer, not a failure. */
		also: readonly number[] = [],
	): Promise<Response> {
		let response = await send(path, init, false);
		if (response.status === 401) response = await send(path, init, true);
		if (response.ok || also.includes(response.status)) return response;
		throw await refusal(response);
	}

	const json = async <T>(response: Response): Promise<T> => {
		try {
			return (await response.json()) as T;
		} catch {
			throw new ApiFailure("server", "The server's answer could not be read.");
		}
	};

	return {
		me: async () => json<Me>(await call("/api/v1/me")),
		changes: async (teamId, since) =>
			json<Changes>(
				await call(
					`${team(teamId)}/changes${since === undefined ? "" : `?since=${since}`}`,
				),
			),
		ops: async (teamId, ops) =>
			json<OpsResponse>(
				await call(`${team(teamId)}/ops`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ops }),
				}),
			),
		hasBlob: async (teamId, sha256) =>
			(await call(`${team(teamId)}/blobs/${sha256}`, { method: "HEAD" }, [404]))
				.ok,
		async putBlob(teamId, sha256, image) {
			await call(`${team(teamId)}/blobs/${sha256}`, {
				method: "PUT",
				headers: { "content-type": "image/webp" },
				body: image,
			});
		},
		getBlob: async (teamId, sha256) =>
			(await call(`${team(teamId)}/blobs/${sha256}`)).blob(),
	};
}

/** The SHA-256 of an image's bytes, in lowercase hex: its name at the server. */
export async function sha256Of(image: Blob): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		await image.arrayBuffer(),
	);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
