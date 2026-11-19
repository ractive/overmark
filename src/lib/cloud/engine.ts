/**
 * The sync with a team at sitegloss.dev (DEC-039). Local first: the cases
 * are in this browser and every action is stored there as before; this
 * sends what changed to the team and takes in what the team changed.
 *
 * A run: send first, then fetch, always in that order.
 *
 * - **Send.** Each case that syncs is compared with what the server last
 *   had of it (its shadow, book.ts), and the difference becomes operations
 *   (wire.ts). Images are uploaded before the operations that name them.
 *   The operations are written down before they are sent, each with an id
 *   of its own, so a reply that never came costs nothing: they are sent
 *   again as they were, and the server applies an id once.
 * - **Fetch.** Everything after the team's revision this device has seen.
 *   For each mark and field: what was not changed here since the server
 *   last had it becomes the server's; what was changed here stays, and is
 *   sent next. Nothing waits to be sent while a fetch is applied, as
 *   sending comes first and a failed send ends the run.
 *
 * The store, the database and the API are given: the service worker gives
 * the real ones, the tests an API in memory that follows the server's rules.
 */

import { type Case, newId as randomId, validateCase } from "../case.ts";
import type { Kv } from "../kv.ts";
import type { CaseStore, StoredImage } from "../store.ts";
import {
	type Api,
	ApiFailure,
	type Changes,
	type ImageRef,
	MAX_IMAGE_BYTES,
	MAX_OPS,
	MAX_OPS_BYTES,
	type Me,
	type Op,
	type OpResult,
	type OpType,
	SMALL_PAGE,
	sha256Of,
	type Team,
	TOO_LARGE,
	type WireCase,
	type WireMark,
	type WireShot,
} from "./api.ts";
import {
	type Account,
	Books,
	type CaseBook,
	type CloudStatus,
	emptyBook,
	KEYS,
	MAX_SAME_SENDS,
	OFF,
	type Queue,
	type Rejected,
	readAccount,
	teamOf,
} from "./book.ts";
import {
	applyOp,
	deriveOps,
	type Incoming,
	type Merged,
	mergeCase,
	NeedsImage,
	opKey,
	renumber,
	reverse,
} from "./wire.ts";

export interface EngineDeps {
	store: CaseStore;
	/** The cloud's database (`sitegloss-cloud`). */
	kv: Kv;
	/** The API of the server at that address, for whoever is signed in. */
	api: (server: string) => Api;
	now?: () => Date;
	newId?: (prefix: string) => string;
	hash?: (image: Blob) => Promise<string>;
	/** Cases here were changed, added or deleted by what came from the server. */
	onChange?: (caseIds: string[]) => void;
	onStatus?: (status: CloudStatus) => void;
	/**
	 * Given: a choice of the user's (signing in, a team, sharing) answers once
	 * it is written down, and the run that follows is handed here instead of
	 * being waited for (the worker: the panel need not wait for a first sync
	 * of many pictures). Not given (the tests): the choice answers after its
	 * run.
	 */
	later?: (run: Promise<void>) => void;
	/**
	 * The cases that synced with another server (DEC-041). They are on this
	 * device only as far as this server goes, and are not among "the cases
	 * that were here before": each one is shared here by itself, or not.
	 */
	elsewhere?: () => Promise<ReadonlySet<string>>;
}

/** What each operation needs the user to be allowed to do in the team. */
const PERMISSION: Record<OpType, string> = {
	"case.create": "case:create",
	"case.patch": "case:update",
	"case.delete": "case:delete",
	"shot.create": "mark:create",
	"shot.delete": "mark:delete",
	"mark.create": "mark:create",
	"mark.patch": "mark:update",
	"mark.delete": "mark:delete",
};

/** What an operation was about, for the sentence that says it was not taken. */
function whatOf(op: Op): string {
	switch (op.type) {
		case "case.create":
			return "The case could not be shared with the team";
		case "case.patch":
			return "A change to the case was not taken";
		case "case.delete":
			return "The case could not be deleted for the team";
		case "shot.create":
			return "A screenshot was not taken";
		case "mark.create":
			return `Mark ${op.mark.number} was not taken`;
		case "mark.patch":
			return "A change to a mark was not taken";
		case "mark.delete":
			return "A mark could not be deleted for the team";
		default:
			return "A change was not taken";
	}
}

/** Why the server refused, in plain words; a code it does not know reads as its message. */
function whyOf(code: string, message: string): string {
	const said = message.trim().replace(/[.!]+$/, "");
	switch (code) {
		case "forbidden":
			return "your role in the team does not allow it";
		case "not_found":
			return "it is no longer there for the team";
		case "blob_missing":
			return "its image did not reach the server";
		default:
			return said === "" ? "the server refused it" : said;
	}
}

const sentence = (op: Op, code: string, message: string) =>
	`${whatOf(op)}: ${whyOf(code, message)}.`;

/** The most rejected changes kept per case. */
const MAX_REJECTED = 50;

/** How long the teams and permissions are taken as last read. */
export const ACCOUNT_FRESH_MS = 10 * 60_000;

/** How many images are fetched at once. */
const FETCHES = 4;

/** Aborts a store transaction that has nothing to write. */
const NOTHING = new Error("nothing to write");

const describe = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** The sync: `request()` after any change, and the user's choices. */
export class CloudSync {
	readonly #deps: EngineDeps;
	readonly #books: Books;
	readonly #now: () => Date;
	readonly #newId: (prefix: string) => string;
	readonly #hash: (image: Blob) => Promise<string>;
	/** One piece of work at a time: runs and the user's choices never overlap. */
	#chain: Promise<unknown> = Promise.resolve();
	#queued: Promise<void> | undefined;
	/** Images this worker knows the team has. */
	readonly #have = new Set<string>();
	/** What the running run has to say besides the books' rejections. */
	#problems: CloudStatus["problems"] = [];

	constructor(deps: EngineDeps) {
		this.#deps = deps;
		this.#books = new Books(deps.kv);
		this.#now = deps.now ?? (() => new Date());
		this.#newId = deps.newId ?? randomId;
		this.#hash = deps.hash ?? sha256Of;
	}

	#exclusive<T>(work: () => Promise<T>): Promise<T> {
		const next = this.#chain.then(work, work);
		this.#chain = next.catch(() => undefined);
		return next;
	}

	/**
	 * Bring this device and the team together; several requests while a run
	 * is under way are one more run after it. Never rejects: what failed is
	 * in the status.
	 */
	request(): Promise<void> {
		this.#queued ??= this.#exclusive(async () => {
			this.#queued = undefined;
			await this.#run();
		});
		return this.#queued;
	}

	async status(): Promise<CloudStatus> {
		return ((await this.#deps.kv.get(KEYS.status)) as CloudStatus) ?? OFF;
	}

	account(): Promise<Account | undefined> {
		return readAccount(this.#deps.kv);
	}

	/** The run that follows a choice of the user's: waited for, or handed on. */
	#then(): Promise<void> {
		const run = this.request();
		if (this.#deps.later === undefined) return run;
		this.#deps.later(run);
		return Promise.resolve();
	}

	// --- the user's choices --------------------------------------------------------

	/**
	 * Someone signed in (their tokens are stored already): `me` is who, and
	 * their teams. The same person as before, after the sign-in ran out, goes
	 * on where they were; anyone else starts anew, and what synced before
	 * stays on this device. With one team, that team is chosen.
	 */
	signedIn(server: string, me: Me): Promise<void> {
		return this.#exclusive(async () => {
			const before = await this.account();
			const same =
				before !== undefined &&
				before.server === server &&
				before.user.id === me.user.id;
			if (!same) await this.#detachAll();
			const teams = me.teams ?? [];
			const kept = same ? before.teamId : undefined;
			const account: Account = {
				server,
				user: { id: me.user.id, name: me.user.name, email: me.user.email },
				teams,
				checkedAt: this.#now().getTime(),
			};
			await this.#deps.kv.set({ [KEYS.account]: account });
			const only = teams.length === 1 ? teams[0]?.id : undefined;
			const teamId =
				kept !== undefined && teams.some((t) => t.id === kept) ? kept : only;
			if (teamId !== undefined) await this.#choose(account, teamId, same);
			else await this.#say({ ...OFF });
			await this.#books.publishModes();
		}).then(() => this.#then());
	}

	/** Sync with another of the user's teams (or the first one chosen). */
	chooseTeam(teamId: string): Promise<void> {
		return this.#exclusive(async () => {
			const account = await this.account();
			if (account === undefined || !account.teams.some((t) => t.id === teamId))
				return;
			if (account.teamId !== teamId) await this.#choose(account, teamId, false);
			await this.#books.publishModes();
		}).then(() => this.#then());
	}

	async #choose(account: Account, teamId: string, resume: boolean) {
		const kv = this.#deps.kv;
		if (!resume) {
			await kv.remove(KEYS.cursor);
			await kv.remove(KEYS.queue);
			this.#have.clear();
		}
		const books = await this.#books.all();
		const cases = await this.#deps.store.listCases();
		const here = new Set(cases.map((c) => c.id));
		const changed: CaseBook[] = [];
		for (const given of books.values()) {
			// Which team has a case of its id is asked anew of a team newly chosen.
			const { theirs, ...plain } = given;
			const book = resume ? given : plain;
			// Another team's: it stays on this device.
			if (book.mode === "synced" && book.teamId !== teamId)
				changed.push({ ...book, mode: "local" });
			// This team had it before (signed out, or another team in between):
			// it goes on where it was. A case deleted here meanwhile is not
			// deleted for the team by signing in: nobody was told it would be.
			else if (
				book.mode === "local" &&
				book.teamId === teamId &&
				book.shadow !== undefined
			) {
				if (here.has(book.caseId)) changed.push({ ...book, mode: "synced" });
				else await this.#books.remove(book.caseId);
			} else if (theirs && !resume) changed.push(book);
		}
		// What is here already is not sent without a word: the user is asked.
		// Not after a sign-in that only ran out: what was made meanwhile is the
		// team's, as it would have been. A case without a mark is nothing yet.
		// What synced with another server is that server's: not asked about in
		// one go with the rest, but on this device only until it is shared.
		if (!resume) {
			const elsewhere = (await this.#deps.elsewhere?.()) ?? new Set<string>();
			for (const c of cases)
				if (
					!books.has(c.id) &&
					(c.annotations.length > 0 || c.lastNumber !== undefined)
				)
					changed.push({
						...emptyBook(c.id, elsewhere.has(c.id) ? "local" : "undecided"),
						title: c.title,
					});
		}
		await this.#books.put(...changed);
		const { expired: _e, ...rest } = account;
		await kv.set({ [KEYS.account]: { ...rest, teamId } });
	}

	/** What synced stays here as it is, on this device only. */
	async #detachAll(): Promise<void> {
		const kv = this.#deps.kv;
		const here = new Set((await this.#deps.store.listCases()).map((c) => c.id));
		for (const book of (await this.#books.all()).values()) {
			// A case deleted here whose delete was not sent stays the team's.
			// One the user was never asked about is asked about next time, and
			// one that was never sent (no mark yet) has nothing to remember.
			if (
				!here.has(book.caseId) ||
				book.mode === "undecided" ||
				(book.mode === "synced" && book.shadow === undefined)
			)
				await this.#books.remove(book.caseId);
			else if (book.mode !== "local" || book.theirs) {
				// Which team has a case of its id is another question next time.
				const { theirs: _t, ...rest } = book;
				await this.#books.put({ ...rest, mode: "local" });
			}
		}
		await kv.remove(KEYS.cursor);
		await kv.remove(KEYS.queue);
		await kv.remove(KEYS.whole);
		this.#have.clear();
	}

	/**
	 * Stop syncing: the cases stay on this device, and nothing of the account
	 * is kept. (The tokens are the caller's to end.)
	 */
	signOut(): Promise<void> {
		return this.#exclusive(async () => {
			await this.#detachAll();
			await this.#deps.kv.remove(KEYS.account);
			await this.#books.publishModes();
			await this.#say({ ...OFF });
		});
	}

	/**
	 * The answer to "these cases were here before": share them with the team,
	 * or keep them on this device.
	 */
	decide(share: boolean): Promise<void> {
		return this.#exclusive(async () => {
			const team = teamOf(await this.account());
			const books = [...(await this.#books.all()).values()]
				.filter((b) => b.mode === "undecided")
				.map(
					(b): CaseBook =>
						share && team !== undefined
							? { ...b, mode: "synced", teamId: team.id }
							: { ...b, mode: "local" },
				);
			await this.#books.put(...books);
			await this.#books.publishModes();
		}).then(() => this.#then());
	}

	/** Share one case that was kept on this device with the team. */
	share(caseId: string): Promise<void> {
		return this.#exclusive(async () => {
			const team = teamOf(await this.account());
			if (team === undefined) return;
			const book =
				(await this.#books.get(caseId)) ?? emptyBook(caseId, "local");
			// What another team had of it says nothing about this one.
			const fresh = book.teamId !== undefined && book.teamId !== team.id;
			await this.#books.put({
				...(fresh ? emptyBook(caseId, "synced") : book),
				mode: "synced",
				teamId: team.id,
			});
			await this.#books.publishModes();
		}).then(() => this.#then());
	}

	/** "Sync now": also what the server refused before is tried again. */
	retry(): Promise<void> {
		return this.#exclusive(async () => {
			const books = [...(await this.#books.all()).values()].filter(
				(b) =>
					b.rejected !== undefined ||
					b.cleanAt !== undefined ||
					b.sent !== undefined,
			);
			await this.#books.put(
				...books.map((b) => {
					const { rejected: _r, cleanAt: _c, sent: _s, ...rest } = b;
					return rest;
				}),
			);
			const account = await this.account();
			if (account !== undefined)
				await this.#deps.kv.set({
					[KEYS.account]: { ...account, checkedAt: 0 },
					// And the team's whole state is read again: what was left
					// out before (an image that was not the one named) may be
					// there now.
					[KEYS.whole]: true,
				});
		}).then(() => this.#then());
	}

	// --- a run ------------------------------------------------------------------------

	async #say(status: CloudStatus): Promise<void> {
		await this.#deps.kv.set({ [KEYS.status]: status }).catch(() => undefined);
		this.#deps.onStatus?.(status);
	}

	/** The status with what the books and this run have to say. */
	async #status(
		state: CloudStatus["state"],
		more: Partial<CloudStatus> = {},
	): Promise<CloudStatus> {
		const before = await this.status();
		const here = new Map(
			(await this.#deps.store.listCases()).map((c) => [c.id, c.title]),
		);
		const problems = [...this.#problems];
		let undecided = 0;
		for (const book of (await this.#books.all()).values()) {
			if (book.mode === "undecided" && here.has(book.caseId)) undecided++;
			// The team has a case with the id of one kept here: neither was
			// touched, and the user is told how to join them.
			if (book.theirs && book.mode !== "synced" && here.has(book.caseId)) {
				const title = here.get(book.caseId);
				problems.push({
					caseId: book.caseId,
					...(title === undefined ? {} : { title }),
					text: `${title === undefined ? "A case" : `“${title}”`} is on this device only, and the team has a case with the same id. Nothing of it was sent, and the team's was not taken. “Share with team” on the case joins the two.`,
				});
			}
			const [first, ...rest] = book.rejected ?? [];
			if (book.mode !== "synced" || first === undefined) continue;
			const title = here.get(book.caseId) ?? book.title;
			problems.push({
				caseId: book.caseId,
				...(title === undefined ? {} : { title }),
				text:
					rest.length === 0
						? first.text
						: `${first.text} ${rest.length} more of its changes were not taken either.`,
			});
		}
		return {
			state,
			problems,
			undecided,
			...(before.lastSyncedAt === undefined
				? {}
				: { lastSyncedAt: before.lastSyncedAt }),
			...more,
		};
	}

	async #run(): Promise<void> {
		const kv = this.#deps.kv;
		let account = await this.account();
		// Signed in and in no team (or none chosen): asked now and then whether
		// that changed; with one team, that team it is.
		if (
			account !== undefined &&
			!account.expired &&
			teamOf(account) === undefined
		) {
			try {
				account = await this.#refresh(this.#deps.api(account.server), account);
				const [only, ...more] = account.teams;
				if (only !== undefined && more.length === 0) {
					await this.#choose(account, only.id, false);
					account = await this.account();
					await this.#books.publishModes();
				}
			} catch (error) {
				if (!(error instanceof ApiFailure)) throw error;
				// Not reached, or refused: said by the next run that has a team.
			}
		}
		const chosen = teamOf(account);
		if (account === undefined || chosen === undefined) {
			await this.#say(
				account?.expired
					? {
							...OFF,
							state: "signed-out",
							text: "The sign-in ran out. Sign in again to go on syncing.",
						}
					: { ...OFF },
			);
			return;
		}
		this.#problems = [];
		if (account.expired) {
			await this.#say(
				await this.#status("signed-out", {
					text: "The sign-in ran out. Sign in again to go on syncing; nothing is lost meanwhile.",
				}),
			);
			return;
		}
		const api = this.#deps.api(account.server);
		try {
			// "Syncing" is said once there is something to send or to store: a
			// look that finds nothing new changes nothing the panel shows.
			account = await this.#refresh(api, account);
			const team = teamOf(account);
			if (team === undefined) {
				await this.#books.publishModes();
				await this.#say({
					...OFF,
					text: `You are no longer a member of “${chosen.name}”. Its cases stay on this device.`,
				});
				return;
			}
			await this.#flush(api, team);
			await this.#push(api, team);
			await this.#pull(api, team);
			await this.#books.publishModes();
			const done = await this.#status("synced", {
				lastSyncedAt: this.#now().toISOString(),
			});
			// Everything went that could; what the server did not take is said.
			await this.#say(
				done.problems.length > 0 ? { ...done, state: "problem" } : done,
			);
		} catch (error) {
			await this.#books.publishModes().catch(() => undefined);
			if (!(error instanceof ApiFailure)) {
				await this.#say(
					await this.#status("problem", {
						text: `Syncing failed: ${describe(error)}`,
					}),
				);
				return;
			}
			if (error.kind === "unauthorized") {
				const now = await this.account();
				if (now !== undefined)
					await kv.set({ [KEYS.account]: { ...now, expired: true } });
				await this.#say(
					await this.#status("signed-out", {
						text: "The sign-in ran out. Sign in again to go on syncing; nothing is lost meanwhile.",
					}),
				);
			} else if (error.kind === "offline")
				await this.#say(
					await this.#status("offline", {
						text: "The server cannot be reached. Your changes are kept and sent when it can.",
					}),
				);
			else if (error.status === 403 || error.status === 404) {
				// Not this team's member any more: asked for the teams next time.
				const now = await this.account();
				if (now !== undefined)
					await kv.set({ [KEYS.account]: { ...now, checkedAt: 0 } });
				await this.#say(
					await this.#status("problem", {
						text: `The server refused: ${error.message}`,
					}),
				);
			} else
				await this.#say(
					await this.#status("problem", {
						text: `The server has a problem (${error.message}). It is tried again.`,
					}),
				);
		}
	}

	/** The user's teams and what they may do there, asked for now and then. */
	async #refresh(api: Api, account: Account): Promise<Account> {
		const now = this.#now().getTime();
		if (now - account.checkedAt < ACCOUNT_FRESH_MS) return account;
		const me = await api.me();
		const teams = me.teams ?? [];
		const { teamId, ...rest } = account;
		const next: Account = {
			...rest,
			user: { id: me.user.id, name: me.user.name, email: me.user.email },
			teams,
			checkedAt: now,
			...(teamId !== undefined && teams.some((t) => t.id === teamId)
				? { teamId }
				: {}),
		};
		if (next.teamId === undefined && teamId !== undefined) {
			// No member any more: what synced stays here, on this device.
			const books = [...(await this.#books.all()).values()].filter(
				(b) => b.mode === "synced",
			);
			await this.#books.put(
				...books.map((b) => ({ ...b, mode: "local" as const })),
			);
		}
		await this.#deps.kv.set({ [KEYS.account]: next });
		return next;
	}

	// --- sending ----------------------------------------------------------------------

	/** Operations a run before this one wrote down and did not see confirmed. */
	async #flush(api: Api, team: Team): Promise<void> {
		const queue = (await this.#deps.kv.get(KEYS.queue)) as Queue | undefined;
		if (queue === undefined) return;
		const book = await this.#books.get(queue.caseId);
		if (queue.teamId === team.id && book !== undefined && queue.ops.length > 0)
			await this.#send(api, team, book, queue.ops);
		else await this.#deps.kv.remove(KEYS.queue);
	}

	async #push(api: Api, team: Team): Promise<void> {
		const cases = await this.#deps.store.listCases();
		const books = await this.#books.all();
		const here = new Set(cases.map((c) => c.id));
		const todo: [Case, CaseBook][] = [];
		let join = false;
		for (const c of cases) {
			let book = books.get(c.id);
			if (book === undefined) {
				// Made since the team was chosen: it is the team's.
				book = { ...emptyBook(c.id, "synced", team.id), title: c.title };
				await this.#books.put(book);
			}
			if (book.mode !== "synced" || book.teamId !== team.id) continue;
			// Shared after the team named its id: the team's copy is read
			// first (the whole state, by this run's pull), so that the same
			// marks become one and only what the team lacks is sent.
			if (book.theirs && book.shadow === undefined) {
				join = true;
				continue;
			}
			if (book.cleanAt === c.updatedAt) continue;
			// A case without marks is not sent until it has one (as the folder sync).
			if (book.shadow === undefined && c.annotations.length === 0) continue;
			todo.push([c, book]);
		}
		if (join) await this.#deps.kv.set({ [KEYS.whole]: true });
		const gone = [...books.values()].filter((b) => !here.has(b.caseId));
		let left = todo.length + gone.filter((b) => b.shadow).length;
		if (left > 0) await this.#say(await this.#status("syncing", { left }));
		for (const [c, book] of todo) {
			await this.#pushCase(api, team, c, book);
			if (--left > 0) await this.#say(await this.#status("syncing", { left }));
		}
		for (const book of gone) {
			if (
				book.mode === "synced" &&
				book.teamId === team.id &&
				book.shadow !== undefined
			)
				await this.#deleteCase(api, team, book);
			else await this.#books.remove(book.caseId);
		}
	}

	/** Upload an image the team does not have; `again`: whatever was known. */
	async #upload(
		api: Api,
		team: Team,
		sha: string,
		image: Blob,
		again = false,
	): Promise<void> {
		if (!again) {
			if (this.#have.has(sha)) return;
			if (await api.hasBlob(team.id, sha)) {
				this.#have.add(sha);
				return;
			}
		}
		await api.putBlob(team.id, sha, image);
		this.#have.add(sha);
	}

	async #pushCase(
		api: Api,
		team: Team,
		c: Case,
		given: CaseBook,
	): Promise<void> {
		const store = this.#deps.store;
		const may = new Set(team.permissions ?? []);
		// Which images the operations will name: found out on a copy of the book.
		const wanted = new Set<string>();
		const placeholder: ImageRef = { sha256: "", width: 1, height: 1, bytes: 1 };
		deriveOps(
			c,
			structuredClone(given),
			(path) => {
				wanted.add(path);
				return placeholder;
			},
			() => "",
		);
		const refs = new Map<string, ImageRef>();
		const blobs = new Map<string, Blob>();
		/** Images the server refused, as they are said. */
		const unsent: Rejected[] = [];
		const mayUpload = may.has(PERMISSION["mark.create"]);
		for (const path of wanted) {
			const stored = await store.getImage(c.id, path);
			if (stored === undefined) continue;
			const sha = await this.#hash(stored.blob);
			refs.set(path, {
				sha256: sha,
				width: stored.width,
				height: stored.height,
				bytes: stored.blob.size,
			});
			blobs.set(sha, stored.blob);
			if (!mayUpload) continue;
			// An image the server did not take (the team's storage is full, it
			// is too large): its mark is not shared, that is said, and it is
			// not uploaded again at every run. "Sync now" tries once more.
			const before = (given.rejected ?? []).find(
				(r) => r.key === `blob:${sha}`,
			);
			if (before !== undefined) {
				refs.delete(path);
				unsent.push(before);
				continue;
			}
			try {
				await this.#upload(api, team, sha, stored.blob);
			} catch (error) {
				if (!(error instanceof ApiFailure) || error.kind !== "refused")
					throw error;
				// Not this team's member any more: the run's to say.
				if (error.status === 403 || error.status === 404) throw error;
				refs.delete(path);
				unsent.push({
					key: `blob:${sha}`,
					text: `An image was not taken, so its mark is not shared: ${whyOf(error.code ?? "", error.message)}.`,
				});
			}
		}
		const book = structuredClone(given);
		book.title = c.title;
		const { ops, missing } = deriveOps(
			c,
			book,
			(path) => refs.get(path),
			this.#newId,
		);
		// What the server refused before is not sent again as it was.
		const keys = new Set(ops.map(opKey));
		const refused = [
			...(book.rejected ?? []).filter((r) => keys.has(r.key)),
			...unsent,
		];
		const held = new Set(refused.map((r) => r.key));
		if (refused.length > 0) book.rejected = refused;
		else delete book.rejected;
		// An image the server refused is not one that is missing here.
		const absent = missing.length - unsent.length;
		const forbidden = ops.filter((op) => !may.has(PERMISSION[op.type]));
		if (forbidden.length > 0)
			this.#problems.push({
				caseId: c.id,
				title: c.title,
				text: `Your role in “${team.name}” does not allow ${forbidden.length === 1 ? "a change" : `${forbidden.length} changes`} you made here; ${forbidden.length === 1 ? "it stays" : "they stay"} on this device.`,
			});
		if (absent > 0)
			this.#problems.push({
				caseId: c.id,
				title: c.title,
				text: `${absent === 1 ? "An image" : `${absent} images`} of the case ${absent === 1 ? "is" : "are"} missing on this device, so ${absent === 1 ? "its mark is" : "their marks are"} not shared.`,
			});
		let sending = ops.filter(
			(op) => may.has(PERMISSION[op.type]) && !held.has(opKey(op)),
		);
		// Without its case at the server, nothing of it can go.
		if (
			book.shadow === undefined &&
			!sending.some((op) => op.type === "case.create")
		)
			sending = [];
		if (sending.length === 0) {
			if (ops.length === 0 && missing.length === 0) {
				book.cleanAt = c.updatedAt;
				delete book.sent;
			}
			await this.#books.put(book);
			return;
		}
		// The same changes as last time, though the server took them: the two
		// do not agree on how something is written, and sending it again
		// changes nothing. Said, and left until the case changes otherwise.
		const sent = sending.map(opKey).sort().join(" ");
		const times = book.sent?.keys === sent ? book.sent.times + 1 : 1;
		book.sent = { keys: sent, times };
		if (times > MAX_SAME_SENDS) {
			this.#problems.push({
				caseId: c.id,
				title: c.title,
				text: "A change keeps coming back from the server as it was before, so it is not sent again. Sync now tries once more.",
			});
			await this.#books.put(book);
			return;
		}
		const done = await this.#send(api, team, book, sending, blobs);
		// Sent whole, with nothing left out: until the case changes, it is done.
		if (
			done.clean &&
			sending.length === ops.length &&
			missing.length === 0 &&
			!done.renumbered
		) {
			const now = await this.#books.get(c.id);
			if (now !== undefined)
				await this.#books.put({ ...now, cleanAt: c.updatedAt });
		}
	}

	/** Operations in requests the server takes: not too many, not too large. */
	#batches(ops: readonly Op[]): Op[][] {
		const batches: Op[][] = [];
		let batch: Op[] = [];
		let size = 0;
		for (const op of ops) {
			const length = JSON.stringify(op).length;
			if (
				batch.length > 0 &&
				(batch.length >= MAX_OPS || size + length > MAX_OPS_BYTES)
			) {
				batches.push(batch);
				batch = [];
				size = 0;
			}
			batch.push(op);
			size += length;
		}
		if (batch.length > 0) batches.push(batch);
		return batches;
	}

	/** One request; a request the server takes none of is sent again piece by piece. */
	async #post(api: Api, team: Team, batch: Op[]): Promise<OpResult[]> {
		try {
			const answer = await api.ops(team.id, batch);
			const results = new Map(
				(answer.results ?? []).map((r) => [r.opId, r] as const),
			);
			return batch.map(
				(op): OpResult =>
					results.get(op.opId) ?? {
						opId: op.opId,
						status: "rejected",
						error: {
							code: "invalid",
							message: "The server gave no answer for it",
						},
					},
			);
		} catch (error) {
			if (
				!(error instanceof ApiFailure) ||
				error.kind !== "refused" ||
				// A no to what was sent (not to who sent it): found out one
				// operation at a time, and that one is said and left out.
				![400, 409, 413, 422].includes(error.status ?? 0)
			)
				throw error;
			const [only] = batch;
			if (batch.length === 1 && only !== undefined)
				return [
					{
						opId: only.opId,
						status: "rejected",
						error: { code: "invalid", message: error.message },
					},
				];
			const results: OpResult[] = [];
			for (const op of batch)
				results.push(...(await this.#post(api, team, [op])));
			return results;
		}
	}

	/**
	 * Send operations of one case, written down first, and make the book
	 * what the server now has. `clean`: every one was taken.
	 */
	async #send(
		api: Api,
		team: Team,
		book: CaseBook,
		ops: Op[],
		blobs: ReadonlyMap<string, Blob> = new Map(),
	): Promise<{ clean: boolean; renumbered: boolean }> {
		const kv = this.#deps.kv;
		let left = [...ops];
		let clean = true;
		/** The server's ids of new marks whose number it changed. */
		const numbers = new Map<string, number>();
		const write = async () => {
			const queue: Queue = { caseId: book.caseId, teamId: team.id, ops: left };
			await kv.set({ [KEYS.queue]: queue });
			await this.#books.put(book);
		};
		await write();
		for (const batch of this.#batches(ops)) {
			const results = await this.#post(api, team, batch);
			// An image is not there after all: it is uploaded, and what the
			// server refused of this request (the operation that names it, and
			// those that needed that one) goes once more; a screenshot first,
			// then the crops of the marks on it.
			const sent = new Set<string>();
			for (let round = 0; round < 3; round++) {
				let uploaded = false;
				for (const [i, op] of batch.entries()) {
					if (
						results[i]?.status !== "rejected" ||
						results[i]?.error?.code !== "blob_missing" ||
						(op.type !== "shot.create" && op.type !== "mark.create")
					)
						continue;
					const ref = op.type === "shot.create" ? op.shot.image : op.mark.crop;
					const blob = blobs.get(ref.sha256);
					if (blob === undefined || sent.has(ref.sha256)) continue;
					await this.#upload(api, team, ref.sha256, blob, true);
					sent.add(ref.sha256);
					uploaded = true;
				}
				if (!uploaded) break;
				const refused = batch.filter(
					(_, i) => results[i]?.status === "rejected",
				);
				const second = await this.#post(api, team, refused);
				for (const [i, op] of batch.entries()) {
					const at = refused.indexOf(op);
					if (at >= 0) results[i] = second[at] as OpResult;
				}
			}
			for (const [i, op] of batch.entries()) {
				const result = results[i] as OpResult;
				const code = result.error?.code ?? "invalid";
				const gone =
					code === "not_found" &&
					(op.type === "mark.delete" || op.type === "case.delete");
				if (
					result.status === "applied" ||
					result.status === "duplicate" ||
					gone
				) {
					applyOp(book, op, result.number);
					if (
						op.type === "mark.create" &&
						typeof result.number === "number" &&
						result.number !== op.mark.number
					)
						numbers.set(op.mark.id, result.number);
				} else {
					// Refused, or an answer this build does not know: not done.
					clean = false;
					book.rejected = [
						...(book.rejected ?? []).filter((r) => r.key !== opKey(op)),
						{
							key: opKey(op),
							text: sentence(op, code, result.error?.message ?? ""),
						},
					].slice(-MAX_REJECTED);
				}
			}
			left = left.filter((op) => !batch.includes(op));
			await write();
		}
		await kv.remove(KEYS.queue);
		const renumbered = numbers.size > 0;
		if (renumbered) await this.#renumber(book, numbers);
		await this.#books.put(book);
		return { clean, renumbered };
	}

	/** The server gave new marks other numbers: the marks here take them. */
	async #renumber(
		book: CaseBook,
		numbers: ReadonlyMap<string, number>,
	): Promise<void> {
		const store = this.#deps.store;
		const here = reverse(book.marks);
		const to = new Map<string, number>();
		for (const [wire, number] of numbers) {
			const id = here.get(wire);
			if (id !== undefined) to.set(id, number);
		}
		const crops = new Map<string, StoredImage>();
		for (let attempt = 0; attempt < 20; attempt++) {
			const next = structuredClone(book);
			try {
				await store.updateCase(book.caseId, (current) => {
					if (current === undefined) throw NOTHING;
					const out = {
						images: new Map<string, unknown>(),
						deleteImages: new Set<string>(),
					};
					const value = renumber(current, next, to, crops, out);
					if (value === current) throw NOTHING;
					return {
						value: validateCase({
							...value,
							updatedAt: this.#now().toISOString(),
						}),
						images: out.images as Map<string, StoredImage>,
						deleteImages: [...out.deleteImages],
					};
				});
			} catch (error) {
				if (error === NOTHING) return;
				if (!(error instanceof NeedsImage) || error.local === undefined)
					throw error;
				const image = await store.getImage(book.caseId, error.local);
				if (image === undefined)
					throw new Error(`the image ${error.local} is missing`);
				crops.set(error.local, image);
				continue;
			}
			book.marks = next.marks;
			this.#deps.onChange?.([book.caseId]);
			return;
		}
	}

	/** A case deleted here is deleted for the team. */
	async #deleteCase(api: Api, team: Team, book: CaseBook): Promise<void> {
		const may = (team.permissions ?? []).includes(PERMISSION["case.delete"]);
		const op: Op = {
			opId: this.#newId("o"),
			type: "case.delete",
			caseId: book.caseId,
		};
		const { rejected: _r, ...plain } = book;
		const done = may
			? await this.#send(api, team, plain, [op])
			: { clean: false };
		await this.#books.remove(book.caseId);
		if (done.clean) return;
		// Not the user's to delete for the team: it comes back from there.
		await this.#deps.kv.set({ [KEYS.whole]: true });
		this.#problems.push({
			caseId: book.caseId,
			...(book.title === undefined ? {} : { title: book.title }),
			text: `${book.title === undefined ? "A case" : `“${book.title}”`} could not be deleted for “${team.name}”${may ? "" : ": your role there does not allow it"}. It is back on this device.`,
		});
	}

	// --- fetching ---------------------------------------------------------------------

	async #pull(api: Api, team: Team): Promise<void> {
		const kv = this.#deps.kv;
		const stored = (await kv.get(KEYS.cursor)) as number | undefined;
		const again = (await kv.get(KEYS.whole)) === true;
		let since = again || typeof stored !== "number" ? undefined : stored;
		let whole = since === undefined;
		let reset = false;
		let cases = new Map<string, WireCase>();
		let shots = new Map<string, WireShot>();
		let marks = new Map<string, WireMark>();
		let removed = new Map<string, { type: string; caseId?: string }>();
		// Things an answer: the server's own number, and fewer once an answer
		// was larger than one may be.
		let limit: number | undefined;
		for (let page = 0; page < 100_000; page++) {
			let changes: Changes;
			try {
				changes = await api.changes(team.id, since, limit);
			} catch (error) {
				if (
					!(error instanceof ApiFailure) ||
					error.code !== TOO_LARGE ||
					limit !== undefined
				)
					throw error;
				limit = SMALL_PAGE;
				continue;
			}
			if (changes.reset) {
				// The server's history is another one: this is its whole state.
				whole = true;
				reset = true;
				cases = new Map();
				shots = new Map();
				marks = new Map();
				removed = new Map();
			}
			// A later page's word on a thing is the newer one.
			for (const c of changes.cases ?? []) {
				cases.set(c.id, c);
				removed.delete(`case ${c.id}`);
			}
			for (const s of changes.shots ?? []) {
				shots.set(s.id, s);
				removed.delete(`shot ${s.id}`);
			}
			for (const m of changes.marks ?? []) {
				marks.set(m.id, m);
				removed.delete(`mark ${m.id}`);
			}
			for (const r of changes.removed ?? []) {
				removed.set(`${r.type} ${r.id}`, {
					type: r.type,
					...(r.caseId === undefined ? {} : { caseId: r.caseId }),
				});
				if (r.type === "case") cases.delete(r.id);
				if (r.type === "shot") shots.delete(r.id);
				if (r.type === "mark") marks.delete(r.id);
			}
			since = changes.cursor;
			if (!changes.more) break;
		}
		if (cases.size + shots.size + marks.size + removed.size === 0 && !whole) {
			if (since !== stored) await kv.set({ [KEYS.cursor]: since });
			return;
		}

		await this.#say(await this.#status("syncing"));
		const changed = new Set<string>();
		const books = await this.#books.all();
		const groups = new Map<string, Incoming>();
		const group = (caseId: string): Incoming => {
			let g = groups.get(caseId);
			if (g === undefined) {
				g = { shots: [], marks: [], removedMarks: [], removedShots: [] };
				groups.set(caseId, g);
			}
			return g;
		};
		for (const c of cases.values()) group(c.id).case = c;
		for (const s of shots.values()) group(s.caseId).shots.push(s);
		for (const m of marks.values()) group(m.caseId).marks.push(m);
		for (const [key, r] of removed) {
			const id = key.slice(key.indexOf(" ") + 1);
			if (r.type === "case") {
				groups.delete(id);
				// Deleted for the team: it goes here too.
				const book = books.get(id);
				if (book?.mode === "synced" && book.teamId === team.id) {
					await this.#deps.store.deleteCase(id);
					await this.#books.remove(id);
					books.delete(id);
					changed.add(id);
				}
			} else if (r.caseId !== undefined) {
				// A kind of thing this build does not know is left alone.
				if (r.type === "mark") group(r.caseId).removedMarks.push(id);
				if (r.type === "shot") group(r.caseId).removedShots.push(id);
			}
		}
		for (const [caseId, incoming] of groups) {
			try {
				if (await this.#applyCase(api, team, caseId, incoming, whole, reset))
					changed.add(caseId);
			} catch (error) {
				if (error instanceof ApiFailure) throw error;
				this.#problems.push({
					caseId,
					...(incoming.case?.title ? { title: incoming.case.title } : {}),
					text: `What the team changed could not be stored here: ${describe(error)}`,
				});
			}
		}
		if (whole) {
			// What the server does not name it does not have (any more).
			for (const book of (await this.#books.all()).values()) {
				// The case that was to be joined with the team's is gone there:
				// this one is sent as any new case.
				if (book.theirs && !cases.has(book.caseId)) {
					const { theirs: _t, ...rest } = book;
					await this.#books.put(rest);
					continue;
				}
				if (
					book.mode !== "synced" ||
					book.teamId !== team.id ||
					book.shadow === undefined ||
					cases.has(book.caseId)
				)
					continue;
				const { shadow: _s, cleanAt: _c, ...rest } = book;
				if (reset) {
					// The server lost it: it is sent again.
					await this.#books.put(rest);
					continue;
				}
				await this.#books.put({ ...rest, mode: "local" });
				this.#problems.push({
					caseId: book.caseId,
					...(book.title === undefined ? {} : { title: book.title }),
					text: `${book.title === undefined ? "A case" : `“${book.title}”`} is no longer in “${team.name}”. It stays on this device.`,
				});
			}
		}
		await kv.set({ [KEYS.cursor]: since });
		if (again) await kv.remove(KEYS.whole);
		if (changed.size > 0) this.#deps.onChange?.([...changed]);
	}

	/**
	 * Fetch images of the team, a few at a time. An image is taken only when
	 * it is the one asked for: its SHA-256 is the name it was asked by, it is
	 * a WebP, and it is no larger than the API holds. Anything else (also an
	 * image the server does not have) is not stored; its SHA-256 is in the
	 * answer, for the caller to leave out what needs it and to say so.
	 */
	async #fetch(
		api: Api,
		team: Team,
		refs: readonly ImageRef[],
		into: Map<string, StoredImage>,
	): Promise<Set<string>> {
		const refused = new Set<string>();
		const todo = refs.filter((r) => !into.has(r.sha256));
		let next = 0;
		const work = async () => {
			for (let ref = todo[next++]; ref !== undefined; ref = todo[next++]) {
				if (into.has(ref.sha256) || refused.has(ref.sha256)) continue;
				let blob: Blob;
				try {
					blob = await api.getBlob(team.id, ref.sha256);
				} catch (error) {
					// Not there, or larger than an image may be: this image's
					// matter. Anything else is the run's (no network, no access).
					if (
						error instanceof ApiFailure &&
						(error.code === TOO_LARGE ||
							(error.kind === "refused" && error.status === 404))
					) {
						refused.add(ref.sha256);
						continue;
					}
					throw error;
				}
				if (
					blob.size > MAX_IMAGE_BYTES ||
					blob.type !== "image/webp" ||
					(await this.#hash(blob)) !== ref.sha256
				) {
					refused.add(ref.sha256);
					continue;
				}
				into.set(ref.sha256, {
					blob,
					width: ref.width,
					height: ref.height,
				});
				this.#have.add(ref.sha256);
			}
		};
		await Promise.all(Array.from({ length: FETCHES }, work));
		return refused;
	}

	/** Bring one case here up to what came; whether the case here changed. */
	async #applyCase(
		api: Api,
		team: Team,
		caseId: string,
		came: Incoming,
		whole: boolean,
		lost: boolean,
	): Promise<boolean> {
		let incoming = came;
		const store = this.#deps.store;
		const given = await this.#books.get(caseId);
		// A case here that is kept on this device (the user said so, or it is
		// another server's) is not the team's because the team names its id:
		// an id is no secret (it is in every export, and every AI app and
		// server the case was shared with has it). Nothing is merged, nothing
		// is sent; it is said, and sharing the case joins the two.
		if (given !== undefined && given.mode !== "synced") {
			const kept = await store.getCase(caseId);
			if (kept !== undefined) {
				if (!given.theirs)
					await this.#books.put({ ...given, theirs: true, title: kept.title });
				return false;
			}
		}
		const fetched = new Map<string, StoredImage>();
		const crops = new Map<string, StoredImage>();
		const options = {
			teamId: team.id,
			whole,
			lost,
			now: this.#now().toISOString(),
		};
		// The images of what is new, before the store is touched.
		const knownShots = new Set(Object.values(given?.shots ?? {}));
		const knownMarks = new Set(Object.values(given?.marks ?? {}));
		const refused = await this.#fetch(
			api,
			team,
			[
				...incoming.shots
					.filter((s) => !knownShots.has(s.id))
					.map((s) => s.image),
				...incoming.marks
					.filter((m) => !knownMarks.has(m.id))
					.map((m) => m.crop),
			],
			fetched,
		);
		// A new mark or screenshot whose image was not the image named is
		// left out (with the marks on such a screenshot), and that is said;
		// the rest of the case, and of the run, goes on.
		if (refused.size > 0) {
			const without = new Set(
				incoming.shots
					.filter((s) => !knownShots.has(s.id) && refused.has(s.image.sha256))
					.map((s) => s.id),
			);
			const marks = incoming.marks.filter(
				(m) =>
					knownMarks.has(m.id) ||
					(!refused.has(m.crop.sha256) && !without.has(m.shotId)),
			);
			const left = incoming.marks.length - marks.length;
			incoming = {
				...incoming,
				shots: incoming.shots.filter((s) => !without.has(s.id)),
				marks,
			};
			const title = incoming.case?.title ?? given?.title;
			this.#problems.push({
				caseId,
				...(title ? { title } : {}),
				text: `${left === 1 ? "A mark" : `${left} marks`} of the team ${left === 1 ? "is" : "are"} not shown here: ${refused.size === 1 ? "an image" : "images"} the server sent ${refused.size === 1 ? "is" : "are"} not the image named (missing, not a WebP image, too large, or other content).`,
			});
		}
		/** Merge with the case as it is; an image it lacks is read and it is tried again. */
		const attempt = async <T>(work: () => Promise<T>): Promise<T> => {
			for (let i = 0; ; i++) {
				try {
					return await work();
				} catch (error) {
					if (!(error instanceof NeedsImage) || i > 2000) throw error;
					if (error.remote !== undefined) {
						const no = await this.#fetch(api, team, [error.remote], fetched);
						if (no.size > 0)
							throw new Error(
								"an image the server sent is not the image named",
							);
					} else if (error.local !== undefined) {
						const image = await store.getImage(caseId, error.local);
						if (image === undefined)
							throw new Error(`the image ${error.local} is missing`);
						crops.set(error.local, image);
					}
				}
			}
		};
		// The ids of what is new are written down first: should the worker stop
		// between the case and the book, the new marks are known as the server's.
		const first = await attempt(async () =>
			mergeCase(
				await store.getCase(caseId),
				given,
				incoming,
				fetched,
				crops,
				options,
			),
		);
		if (first === undefined) return false;
		const known = given ?? emptyBook(caseId, "synced", team.id);
		if (
			given === undefined ||
			Object.keys(first.book.marks).some(
				(id) => given.marks[id] === undefined,
			) ||
			Object.keys(first.book.shots).some((id) => given.shots[id] === undefined)
		)
			await this.#books.put({
				...known,
				marks: { ...first.book.marks },
				shots: { ...first.book.shots },
			});
		let merged: Merged | undefined;
		await attempt(async () => {
			merged = undefined;
			try {
				await store.updateCase(caseId, (current) => {
					merged = mergeCase(current, given, incoming, fetched, crops, options);
					if (merged === undefined || !merged.changed) throw NOTHING;
					return {
						value: validateCase(merged.value),
						images: merged.images as Map<string, StoredImage>,
						deleteImages: merged.deleteImages,
					};
				});
			} catch (error) {
				if (error !== NOTHING) throw error;
			}
		});
		const result = merged as Merged | undefined;
		if (result === undefined) return false;
		await this.#books.put(result.book);
		return result.changed;
	}
}
