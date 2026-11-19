/**
 * The service worker's part of the sync with sitegloss.dev (DEC-039): it is
 * the one that syncs and the one that holds the tokens, so the side panel in
 * two windows, or a panel and a worker, never send the same change twice or
 * use a refresh token twice. The panel asks (`CloudRequest`, over
 * `runtime.sendMessage`, from an extension page only); the worker answers
 * and tells of news (`cloud:changed`).
 *
 * The worker is not kept alive for this: a run is started by what happens
 * (a case changed, the panel opened, the panel heard of a change on the
 * server's events stream, an alarm every few minutes) and the worker may
 * stop when it is over. While a run is under way a call to an extension API
 * every 20 seconds keeps the browser from stopping the worker in the middle
 * of it; what a stopped run left is taken up by the next one.
 */

import { dataConsent, FIREFOX } from "../lib/browser.ts";
import { type Api, ApiFailure, httpApi } from "../lib/cloud/api.ts";
import {
	AuthError,
	beginSignIn,
	codeFrom,
	DEFAULT_SERVER,
	exchangeCode,
	OfflineError,
	PENDING_KEY,
	type PendingSignIn,
	Session,
	serverOrigin,
	serverProblem,
} from "../lib/cloud/auth.ts";
import {
	type CloudStatus,
	KEYS,
	readAccount,
	teamOf,
} from "../lib/cloud/book.ts";
import { CloudSync } from "../lib/cloud/engine.ts";
import type { Kv } from "../lib/kv.ts";
import type { CloudAnswer, CloudRequest } from "../lib/messages.ts";
import type { CaseStore } from "../lib/store.ts";

/** The alarm that looks for the team's changes while no panel listens. */
export const CLOUD_ALARM = "sitegloss-cloud";
/** One more try after the server was not reached. */
export const CLOUD_RETRY_ALARM = "sitegloss-cloud-retry";

/** How often the fallback looks, in minutes. */
export const LOOK_EVERY_MINUTES = 5;

/** A worker that starts this soon after a sync does not ask the server again. */
export const START_QUIET_MS = 60_000;

/** Changes in a row are one run: a mark's save is several writes. */
const QUIET_MS = 300;

const KEEPALIVE_MS = 20_000;

export interface CloudDeps {
	store: CaseStore;
	/** The cloud's database. */
	kv: Kv;
	/** A case here was changed by what came from the team. */
	changed: (caseId: string) => void;
	/** The status changed, or the account: the panels read it again. */
	news: () => void;
	/** Where the browser's sign-in window ends (`identity.getRedirectURL`). */
	redirect: () => string;
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	now?: () => number;
	/** The alarms, as `chrome.alarms` has them. */
	alarms?: Pick<typeof chrome.alarms, "create" | "clear" | "get">;
	/** Something that resets the browser's idle timer for the worker. */
	keepAlive?: () => void;
}

const describe = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** The account and the sync, as the worker runs them. */
export class Cloud {
	readonly engine: CloudSync;
	readonly #deps: CloudDeps;
	readonly #session: Session;
	readonly #fetch: (input: string, init?: RequestInit) => Promise<Response>;
	readonly #now: () => number;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running = 0;
	#keep: ReturnType<typeof setInterval> | undefined;
	/** Tries in a row that did not reach the server. */
	#failures = 0;

	constructor(deps: CloudDeps) {
		this.#deps = deps;
		this.#fetch = deps.fetch ?? ((input, init) => fetch(input, init));
		this.#now = deps.now ?? Date.now;
		this.#session = new Session(deps.kv, this.#fetch, this.#now);
		this.engine = new CloudSync({
			store: deps.store,
			kv: deps.kv,
			api: (server) => this.#api(server),
			now: () => new Date(this.#now()),
			onChange: (ids) => {
				for (const id of ids) deps.changed(id);
			},
			onStatus: (status) => this.#heard(status),
			// The panel's question is answered once the choice is written down.
			later: (run) => void this.#run(() => run),
		});
	}

	#api(server: string): Api {
		return httpApi({
			server,
			token: (fresh) => this.#session.access(server, fresh),
			fetch: this.#fetch,
		});
	}

	async server(): Promise<string> {
		const set = await this.#deps.kv.get(KEYS.server).catch(() => undefined);
		return (
			(typeof set === "string" ? serverOrigin(set) : undefined) ??
			DEFAULT_SERVER
		);
	}

	/**
	 * The worker started: take up what a stopped run left, and look for the
	 * team's changes, unless it just did: a worker is started often (an alarm
	 * of the AI connection every minute, each message), and each start is no
	 * reason to ask the server.
	 */
	start(): void {
		void this.#schedule();
		void (async () => {
			const kv = this.#deps.kv;
			const [status, queue] = await Promise.all([
				kv.get(KEYS.status).catch(() => undefined),
				kv.get(KEYS.queue).catch(() => undefined),
			]);
			const last = Date.parse(
				(status as CloudStatus | undefined)?.lastSyncedAt ?? "",
			);
			const fresh =
				(status as CloudStatus | undefined)?.state === "synced" &&
				this.#now() - last < START_QUIET_MS;
			if (queue === undefined && fresh) return;
			this.request();
		})();
	}

	/** A case changed, or it is time to look: one run, after a quiet moment. */
	request(): void {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => void this.#run(), QUIET_MS);
	}

	async #run(work: () => Promise<void> = () => this.engine.request()) {
		this.#running++;
		// A long upload makes no extension API call by itself.
		this.#keep ??= setInterval(() => this.#deps.keepAlive?.(), KEEPALIVE_MS);
		try {
			await work();
		} finally {
			if (--this.#running === 0) {
				clearInterval(this.#keep);
				this.#keep = undefined;
			}
		}
	}

	/** What a run came to: tell the panels, and try again later if it did not get through. */
	#heard(status: CloudStatus): void {
		this.#deps.news();
		const alarms = this.#deps.alarms;
		if (alarms === undefined) return;
		if (
			status.state === "offline" ||
			(status.state === "problem" && status.text)
		) {
			this.#failures++;
			// Half a minute, then one, two, and five at most.
			const minutes = Math.min(5, 0.5 * 2 ** (this.#failures - 1));
			void alarms.create(CLOUD_RETRY_ALARM, { delayInMinutes: minutes });
		} else if (status.state !== "syncing") {
			this.#failures = 0;
			void alarms.clear(CLOUD_RETRY_ALARM);
		}
	}

	/** The alarm that looks now and then: there while a team is chosen. */
	async #schedule(): Promise<void> {
		const alarms = this.#deps.alarms;
		if (alarms === undefined) return;
		const account = await readAccount(this.#deps.kv).catch(() => undefined);
		if (teamOf(account) === undefined || account?.expired) {
			await alarms.clear(CLOUD_ALARM);
			return;
		}
		// Made once: making it again at each start would begin its wait anew.
		if ((await alarms.get(CLOUD_ALARM)) === undefined)
			await alarms.create(CLOUD_ALARM, { periodInMinutes: LOOK_EVERY_MINUTES });
	}

	/** An alarm of the browser's; whether it was one of these. */
	alarm(name: string): boolean {
		if (name !== CLOUD_ALARM && name !== CLOUD_RETRY_ALARM) return false;
		this.request();
		return true;
	}

	/**
	 * Firefox's data collection consent was taken back: nothing may go to the
	 * server any more, so the account is signed out (the cases stay here).
	 */
	async consentChanged(): Promise<void> {
		if (!FIREFOX || (await dataConsent())) return;
		if ((await readAccount(this.#deps.kv)) !== undefined) await this.#signOut();
	}

	async #signOut(): Promise<void> {
		const account = await readAccount(this.#deps.kv);
		await this.engine.signOut();
		// The tokens go here whatever the server says; it is told if it answers.
		await this.#session.end(account?.server);
		await this.#deps.kv.remove(PENDING_KEY);
		await this.#schedule();
		this.#deps.news();
	}

	/** What a side panel asks. Never rejects: a failure is an answer. */
	async handle(request: CloudRequest): Promise<CloudAnswer> {
		try {
			return await this.#handle(request);
		} catch (error) {
			return {
				ok: false,
				error:
					error instanceof AuthError ||
					error instanceof OfflineError ||
					error instanceof ApiFailure
						? error.message
						: `Sitegloss could not do that: ${describe(error)}`,
			};
		}
	}

	async #handle(request: CloudRequest): Promise<CloudAnswer> {
		const kv = this.#deps.kv;
		switch (request.type) {
			case "cloud:begin": {
				const { pending, url } = await beginSignIn(
					await this.server(),
					this.#deps.redirect(),
					this.#now(),
				);
				await kv.set({ [PENDING_KEY]: pending });
				return { ok: true, url };
			}
			case "cloud:finish": {
				const pending = (await kv.get(PENDING_KEY)) as
					| PendingSignIn
					| undefined;
				if (pending === undefined)
					throw new AuthError("No sign-in is under way. Try again.");
				await kv.remove(PENDING_KEY);
				const code = codeFrom(pending, request.redirect, this.#now());
				const tokens = await exchangeCode(
					this.#fetch,
					pending,
					code,
					this.#now(),
				);
				await this.#session.store(tokens);
				const me = await this.#api(pending.server).me();
				await this.engine.signedIn(pending.server, me);
				await this.#schedule();
				this.#deps.news();
				return { ok: true };
			}
			case "cloud:sign-out":
				await this.#signOut();
				return { ok: true };
			case "cloud:team":
				await this.engine.chooseTeam(request.teamId);
				await this.#schedule();
				this.#deps.news();
				return { ok: true };
			case "cloud:decide":
				await this.engine.decide(request.share);
				this.#deps.news();
				return { ok: true };
			case "cloud:share":
				await this.engine.share(request.caseId);
				this.#deps.news();
				return { ok: true };
			case "cloud:run": {
				// The events stream says where the team is: nothing to fetch when
				// this device is there already.
				if (request.cursor !== undefined) {
					const seen = await kv.get(KEYS.cursor);
					if (typeof seen === "number" && seen >= request.cursor)
						return { ok: true };
				}
				if (request.retry) void this.#run(() => this.engine.retry());
				else this.request();
				return { ok: true };
			}
			case "cloud:token": {
				const account = await readAccount(kv);
				const team = teamOf(account);
				if (account === undefined || team === undefined || account.expired)
					return { ok: false, error: "Not signed in." };
				return {
					ok: true,
					token: await this.#session.access(
						account.server,
						request.fresh === true,
					),
				};
			}
			case "cloud:server": {
				if ((await readAccount(kv)) !== undefined)
					throw new AuthError("Sign out before changing the server.");
				const text = request.server.trim();
				if (text === "") {
					await kv.remove(KEYS.server);
					return { ok: true };
				}
				const problem = serverProblem(text);
				if (problem !== undefined) throw new AuthError(problem);
				await kv.set({ [KEYS.server]: serverOrigin(text) });
				return { ok: true };
			}
		}
	}
}
