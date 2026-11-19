/**
 * The sitegloss.dev API in memory, for the engine's tests: one team's cases,
 * screenshots, marks and images, kept by the server's own rules (its
 * `store.ts`): an operation's id is applied once, a taken mark number gives
 * the next one, who did something is the caller, a deleted mark's
 * screenshot goes with its last mark, what was deleted is told once to who
 * asks for the changes since, in pages, and a cursor from another history
 * gets the whole state (`reset`).
 */

import { MAX_PAGES, pageKey, samePage } from "../src/lib/case.ts";
import {
	type Api,
	ApiFailure,
	type Changes,
	type ImageRef,
	type Me,
	type Op,
	type OpResult,
	type OpsResponse,
	type Removed,
	sha256Of,
	type UserRef,
	type WireCase,
	type WireFinding,
	type WireMark,
	type WireReopen,
	type WireResolution,
	type WireShot,
} from "../src/lib/cloud/api.ts";

export const TEAM = "team_1";

const ALL = [
	"case:read",
	"case:create",
	"case:update",
	"case:delete",
	"case:share",
	"mark:create",
	"mark:update",
	"mark:delete",
];

const PERMISSION: Record<Op["type"], string> = {
	"case.create": "case:create",
	"case.patch": "case:update",
	"case.delete": "case:delete",
	"shot.create": "mark:create",
	"shot.delete": "mark:delete",
	"mark.create": "mark:create",
	"mark.patch": "mark:update",
	"mark.delete": "mark:delete",
};

class Refusal extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

interface Row<T> {
	value: T;
	deleted: boolean;
	rev: number;
}

const compact = <T extends object>(value: T): T =>
	Object.fromEntries(
		Object.entries(value).filter(([, inner]) => inner !== undefined),
	) as T;

/** One user's connection: what a device of theirs calls. */
export interface FakeApi extends Api {
	/** The requests made, as `GET changes`, `POST ops 3`, … */
	calls: string[];
	/** Nothing reaches the server. */
	offline: boolean;
	/** The next `n` requests of operations are applied, and their reply is lost. */
	loseReplies: number;
	/** The server refuses the token. */
	unauthorized: boolean;
	permissions: string[];
}

export class FakeServer {
	seq = 0;
	readonly cases = new Map<string, Row<WireCase>>();
	readonly shots = new Map<string, Row<WireShot>>();
	readonly marks = new Map<string, Row<WireMark>>();
	readonly blobs = new Map<string, Blob>();
	readonly applied = new Map<string, OpResult>();
	/** How many things one answer of changes holds at most. */
	pageSize = 500;
	/** The server's clock. */
	now = new Date("2026-11-19T12:00:00.000Z");
	/** Fields this version of the contract does not have: a later one's. */
	future = false;
	/** Refuse operations of these types with a code no client knows yet. */
	refuseWith: { type: Op["type"]; code: string; message: string } | undefined;

	#tick(): string {
		this.now = new Date(this.now.getTime() + 1000);
		return this.now.toISOString();
	}

	/** The live marks of a case, by number. */
	marksOf(caseId: string): WireMark[] {
		return [...this.marks.values()]
			.filter((m) => !m.deleted && m.value.caseId === caseId)
			.map((m) => m.value)
			.sort((a, b) => a.number - b.number);
	}

	shotsOf(caseId: string): WireShot[] {
		return [...this.shots.values()]
			.filter((s) => !s.deleted && s.value.caseId === caseId)
			.map((s) => s.value);
	}

	caseOf(caseId: string): WireCase | undefined {
		const row = this.cases.get(caseId);
		return row === undefined || row.deleted ? undefined : row.value;
	}

	/**
	 * The server's database was restored from an old copy: what is in it has
	 * an early revision, and a client's cursor is ahead of the server's.
	 */
	restore(): void {
		this.seq = 1;
		this.applied.clear();
		for (const table of [this.cases, this.shots, this.marks] as Map<
			string,
			Row<{ rev: number }>
		>[]) {
			for (const [id, row] of table) {
				if (row.deleted) table.delete(id);
				else {
					row.rev = 1;
					row.value.rev = 1;
				}
			}
		}
	}

	// Who did something, and what happened before, is the server's to say:
	// as its `store.ts` stamps it.

	#stampVerification(
		user: UserRef,
		previous: WireResolution["verified"],
		next: WireResolution["verified"],
		imports: boolean,
	): WireResolution["verified"] {
		if (!next) return undefined;
		if (previous && previous.at === next.at) return previous;
		const imported = imports && next.imported ? true : undefined;
		return compact({
			at: next.at,
			app: next.app,
			imported,
			user: imported ? undefined : user,
		}) as WireResolution["verified"];
	}

	#stampResolution(
		user: UserRef,
		previous: WireResolution | null | undefined,
		next: WireResolution | null,
		imports: boolean,
	): WireResolution | null {
		if (!next) return null;
		const kept =
			previous && previous.at === next.at && previous.kind === next.kind
				? previous
				: undefined;
		const imported = kept
			? kept.imported
			: imports && next.imported
				? true
				: undefined;
		return compact({
			kind: next.kind,
			note: next.note || undefined,
			at: next.at,
			app: kept ? kept.app : next.app,
			verified:
				next.kind === "fixed"
					? this.#stampVerification(
							user,
							kept?.verified,
							next.verified,
							imports,
						)
					: undefined,
			imported,
			user: kept ? kept.user : imported ? undefined : user,
		}) as WireResolution;
	}

	/** History is only added to, and the resolution a new reopen ended is the stored one. */
	#stampReopens(
		user: UserRef,
		previous: readonly WireReopen[],
		next: readonly WireReopen[],
		ended: WireResolution | null | undefined,
		imports: boolean,
	): WireReopen[] {
		const known = new Set(previous.map((r) => r.at));
		const added = next
			.filter((r) => !known.has(r.at))
			.map((r) => {
				const imported = imports && r.imported ? true : undefined;
				const { user: _u, verified, ...plain } = r.was;
				const { user: _v, ...checked } = verified ?? { at: "" };
				const was =
					ended && ended.at === r.was.at && ended.kind === r.was.kind
						? ended
						: verified
							? { ...plain, verified: checked }
							: plain;
				return compact({
					note: r.note || undefined,
					at: r.at,
					app: r.app,
					was,
					imported,
					user: imported ? undefined : user,
				}) as WireReopen;
			});
		return [...previous, ...added].slice(-20);
	}

	#stampFinding(
		user: UserRef,
		previous: WireFinding | undefined,
		next: WireFinding,
		imports: boolean,
	): WireFinding {
		if (previous) {
			if (next.text === previous.text) return previous;
			return compact({
				...previous,
				text: next.text,
				editedAt: next.editedAt ?? this.now.toISOString(),
			}) as WireFinding;
		}
		const imported = imports && next.imported ? true : undefined;
		return compact({
			id: next.id,
			text: next.text,
			app: next.app,
			at: next.at,
			editedAt: next.editedAt,
			imported,
			user: imported ? undefined : user,
		}) as WireFinding;
	}

	#live(caseId: string): Row<WireCase> {
		const row = this.cases.get(caseId);
		if (row === undefined || row.deleted)
			throw new Refusal(
				"not_found",
				"The case does not exist, or was deleted.",
			);
		return row;
	}

	/**
	 * A screenshot of a page the case does not have adds that page, called
	 * what the operation says; which page an address is, is `pageKey`. A full
	 * list takes no more. (The server's `withPageOf`.)
	 */
	#withPageOf(
		owner: Row<WireCase>,
		op: Extract<Op, { type: "shot.create" }>,
	): void {
		const pages = owner.value.pages;
		if (
			pages.some((p) => samePage(p.url, op.shot.url)) ||
			pages.length >= MAX_PAGES
		)
			return;
		owner.value = {
			...owner.value,
			pages: [
				...pages,
				{
					url: op.shot.url,
					title: op.page?.title ?? "",
					...(op.page?.lang ? { lang: op.page.lang } : {}),
				},
			],
		};
	}

	/**
	 * A page leaves the case with its last screenshot; the last page of all
	 * stays. (The server's `withoutEmptyPages`.)
	 */
	#withoutEmptyPages(owner: Row<WireCase>): void {
		const pages = owner.value.pages;
		if (pages.length < 2) return;
		const keys = new Set(
			this.shotsOf(owner.value.id).map((s) => pageKey(s.url)),
		);
		const kept = pages.filter((p) => keys.has(pageKey(p.url)));
		if (kept.length === pages.length) return;
		owner.value = {
			...owner.value,
			pages: kept.length > 0 ? kept : pages.slice(0, 1),
		};
	}

	#touch(row: Row<WireCase>, rev: number, at: string): void {
		row.rev = rev;
		row.value = { ...row.value, updatedAt: at, rev };
	}

	#need(image: ImageRef, what: string): void {
		if (!this.blobs.has(image.sha256))
			throw new Refusal(
				"blob_missing",
				`The ${what} ${image.sha256} has not been uploaded.`,
			);
	}

	#apply(
		op: Op,
		user: UserRef,
		rev: number,
		at: string,
	): Pick<OpResult, "status" | "number"> {
		switch (op.type) {
			case "case.create": {
				const existing = this.cases.get(op.case.id);
				if (existing) {
					if (!existing.deleted) return { status: "duplicate" };
					throw new Refusal("conflict", "The case's id is taken.");
				}
				this.cases.set(op.case.id, {
					deleted: false,
					rev,
					value: {
						id: op.case.id,
						teamId: TEAM,
						title: op.case.title,
						link: op.case.link ?? null,
						summary: op.case.summary ?? null,
						pages: op.case.pages ?? [],
						client: op.case.client ?? {},
						lastNumber: op.case.lastNumber ?? 0,
						importedAt: op.case.importedAt ?? null,
						createdBy: user,
						createdAt: op.case.createdAt ?? at,
						updatedAt: at,
						rev,
					},
				});
				return { status: "applied" };
			}
			case "case.patch": {
				const row = this.#live(op.caseId);
				const v = row.value;
				row.value = {
					...v,
					title: op.title ?? v.title,
					link: op.link === undefined ? v.link : op.link,
					summary: op.summary === undefined ? v.summary : op.summary,
					pages: op.pages ?? v.pages,
					lastNumber: Math.max(v.lastNumber, op.lastNumber ?? 0),
				};
				this.#touch(row, rev, at);
				return { status: "applied" };
			}
			case "case.delete": {
				const row = this.cases.get(op.caseId);
				if (row === undefined)
					throw new Refusal("not_found", "The case does not exist.");
				if (row.deleted) return { status: "duplicate" };
				// Its marks and screenshots go with it, without a word of their own.
				for (const [id, mark] of this.marks)
					if (mark.value.caseId === op.caseId) this.marks.delete(id);
				for (const [id, shot] of this.shots)
					if (shot.value.caseId === op.caseId) this.shots.delete(id);
				row.deleted = true;
				row.value = {
					...row.value,
					title: "",
					summary: null,
					link: null,
					pages: [],
				};
				this.#touch(row, rev, at);
				return { status: "applied" };
			}
			case "shot.create": {
				const owner = this.#live(op.caseId);
				const existing = this.shots.get(op.shot.id);
				if (existing && existing.value.caseId !== op.caseId)
					throw new Refusal("conflict", "The screenshot's id is taken.");
				if (existing && !existing.deleted) return { status: "duplicate" };
				this.#need(op.shot.image, "screenshot");
				if (existing) {
					// It went with its last mark; a mark still on it brings it back,
					// and its page with it.
					existing.deleted = false;
					existing.rev = rev;
					existing.value = { ...existing.value, rev };
					this.#withPageOf(owner, op);
					this.#touch(owner, rev, at);
					return { status: "applied" };
				}
				this.shots.set(op.shot.id, {
					deleted: false,
					rev,
					value: { ...op.shot, caseId: op.caseId, rev },
				});
				this.#withPageOf(owner, op);
				this.#touch(owner, rev, at);
				return { status: "applied" };
			}
			case "shot.delete": {
				const row = this.shots.get(op.shotId);
				if (row === undefined)
					throw new Refusal("not_found", "The screenshot does not exist.");
				if (row.deleted) return { status: "duplicate" };
				if (this.marksOf(row.value.caseId).some((m) => m.shotId === op.shotId))
					throw new Refusal("conflict", "A mark is still on this screenshot.");
				row.deleted = true;
				row.rev = rev;
				const owner = this.#live(row.value.caseId);
				this.#withoutEmptyPages(owner);
				this.#touch(owner, rev, at);
				return { status: "applied" };
			}
			case "mark.create": {
				const owner = this.#live(op.caseId);
				const existing = this.marks.get(op.mark.id);
				if (existing) {
					if (existing.value.caseId === op.caseId)
						return { status: "duplicate", number: existing.value.number };
					throw new Refusal("conflict", "The mark's id is taken.");
				}
				const shot = this.shots.get(op.mark.shotId);
				if (!shot || shot.deleted || shot.value.caseId !== op.caseId)
					throw new Refusal(
						"invalid",
						"The mark's screenshot is not one of this case: create the screenshot first.",
					);
				this.#need(op.mark.crop, "crop");
				// A deleted mark's number stays taken.
				const all = [...this.marks.values()].filter(
					(m) => m.value.caseId === op.caseId,
				);
				const taken = all.some((m) => m.value.number === op.mark.number);
				const number = taken
					? Math.max(
							owner.value.lastNumber,
							...all.map((m) => m.value.number),
						) + 1
					: op.mark.number;
				const imports = owner.value.importedAt !== null;
				const resolution = this.#stampResolution(
					user,
					undefined,
					op.mark.resolution ?? null,
					imports,
				);
				this.marks.set(op.mark.id, {
					deleted: false,
					rev,
					value: {
						id: op.mark.id,
						caseId: op.caseId,
						number,
						shotId: op.mark.shotId,
						comment: op.mark.comment,
						author: op.mark.author ?? "user",
						shape: op.mark.shape,
						crop: op.mark.crop,
						element: op.mark.element,
						resolution,
						reopens: this.#stampReopens(
							user,
							[],
							op.mark.reopens ?? [],
							undefined,
							imports,
						),
						findings: (op.mark.findings ?? []).map((f) =>
							this.#stampFinding(user, undefined, f, imports),
						),
						status: statusOf(resolution),
						createdBy: user,
						createdAt: op.mark.createdAt ?? at,
						updatedAt: at,
						rev,
					},
				});
				owner.value = {
					...owner.value,
					lastNumber: Math.max(owner.value.lastNumber, number),
				};
				this.#touch(owner, rev, at);
				return { status: "applied", number };
			}
			case "mark.patch": {
				const row = this.marks.get(op.markId);
				if (row === undefined || row.deleted)
					throw new Refusal(
						"not_found",
						"The mark does not exist, or was deleted.",
					);
				let v = row.value;
				if (op.comment !== undefined)
					v = { ...v, comment: op.comment, author: op.author ?? "user" };
				else if (op.author !== undefined) v = { ...v, author: op.author };
				const imports = this.#live(v.caseId).value.importedAt !== null;
				if (op.state !== undefined) {
					const resolution = this.#stampResolution(
						user,
						v.resolution,
						op.state.resolution,
						imports,
					);
					v = {
						...v,
						reopens: this.#stampReopens(
							user,
							v.reopens,
							op.state.reopens,
							v.resolution,
							imports,
						),
						resolution,
						status: statusOf(resolution),
					};
				}
				if (op.findings !== undefined) {
					const gone = new Set(op.findings.remove ?? []);
					const kept = v.findings.filter((f) => !gone.has(f.id));
					for (const f of op.findings.upsert ?? []) {
						const i = kept.findIndex((k) => k.id === f.id);
						if (i >= 0) kept[i] = this.#stampFinding(user, kept[i], f, imports);
						else kept.push(this.#stampFinding(user, undefined, f, imports));
					}
					if (kept.length > 20)
						throw new Refusal("limit", "A mark holds at most 20 findings.");
					v = { ...v, findings: kept };
				}
				row.value = { ...v, updatedAt: at, rev };
				row.rev = rev;
				this.#touch(this.#live(v.caseId), rev, at);
				return { status: "applied" };
			}
			case "mark.delete": {
				const row = this.marks.get(op.markId);
				if (row === undefined)
					throw new Refusal("not_found", "The mark does not exist.");
				if (row.deleted) return { status: "duplicate" };
				row.deleted = true;
				row.rev = rev;
				row.value = { ...row.value, findings: [], comment: "", rev };
				const shotId = row.value.shotId;
				if (!this.marksOf(row.value.caseId).some((m) => m.shotId === shotId)) {
					const shot = this.shots.get(shotId);
					if (shot && !shot.deleted) {
						shot.deleted = true;
						shot.rev = rev;
					}
				}
				const owner = this.#live(row.value.caseId);
				this.#withoutEmptyPages(owner);
				this.#touch(owner, rev, at);
				return { status: "applied" };
			}
		}
	}

	applyOps(
		ops: readonly Op[],
		user: UserRef,
		may: readonly string[],
	): OpsResponse {
		const rev = ++this.seq;
		const at = this.#tick();
		let changed = false;
		const results = ops.map((op): OpResult => {
			const before = this.applied.get(op.opId);
			if (before) return { ...before, status: "duplicate" };
			try {
				if (!may.includes(PERMISSION[op.type]))
					throw new Refusal(
						"forbidden",
						`You may not do this here (${PERMISSION[op.type]}).`,
					);
				if (this.refuseWith?.type === op.type)
					throw new Refusal(this.refuseWith.code, this.refuseWith.message);
				const done = this.#apply(structuredClone(op), user, rev, at);
				const result: OpResult = {
					opId: op.opId,
					...done,
					...(done.status === "applied" ? { rev } : {}),
				};
				this.applied.set(op.opId, result);
				if (done.status === "applied") changed = true;
				return result;
			} catch (error) {
				if (!(error instanceof Refusal)) throw error;
				return {
					opId: op.opId,
					status: "rejected",
					error: { code: error.code, message: error.message },
				} as OpResult;
			}
		});
		if (!changed) this.seq--;
		return { results, cursor: this.seq };
	}

	changes(since: number | undefined, limit = this.pageSize): Changes {
		const head = this.seq;
		const reset = since !== undefined && since > head;
		const from = reset || since === undefined ? 0 : since;
		// Only a request that names no revision gets the whole state (which
		// names no deletes); `since=0` is a revision like any other, as at
		// the server since its fix.
		const whole = reset || since === undefined;
		const revs = [
			...this.cases.values(),
			...this.shots.values(),
			...this.marks.values(),
		]
			.map((r) => r.rev)
			.filter((r) => r > from)
			.sort((a, b) => a - b);
		const cut = revs[limit];
		// The page ends on a whole revision, as the server's does.
		const upTo = cut === undefined ? head : cut;
		const more = cut !== undefined;
		const inRange = (row: { rev: number }) => row.rev > from && row.rev <= upTo;
		const removed: Removed[] = [];
		const out = {
			cases: [] as WireCase[],
			shots: [] as WireShot[],
			marks: [] as WireMark[],
		};
		const extra = this.future ? { somethingNew: { since: "v1.9" } } : {};
		for (const [id, row] of this.cases) {
			if (!inRange(row)) continue;
			if (row.deleted) {
				if (!whole) removed.push({ type: "case", id, rev: row.rev });
			} else out.cases.push({ ...row.value, ...extra });
		}
		for (const [id, row] of this.shots) {
			if (!inRange(row)) continue;
			if (row.deleted) {
				if (!whole)
					removed.push({
						type: "shot",
						id,
						caseId: row.value.caseId,
						rev: row.rev,
					});
			} else out.shots.push({ ...row.value, rev: row.rev, ...extra });
		}
		for (const [id, row] of this.marks) {
			if (!inRange(row)) continue;
			if (row.deleted) {
				if (!whole)
					removed.push({
						type: "mark",
						id,
						caseId: row.value.caseId,
						rev: row.rev,
					});
			} else out.marks.push({ ...row.value, ...extra });
		}
		if (this.future && !whole)
			removed.push({
				type: "label" as Removed["type"],
				id: "l_1",
				caseId: "c_unknown",
				rev: upTo,
			});
		return structuredClone({
			cursor: upTo,
			more,
			reset,
			...out,
			removed,
			...extra,
		});
	}

	/** A device of `user`'s. */
	api(user: UserRef & { email?: string }): FakeApi {
		const server = this;
		const reach = (call: string) => {
			api.calls.push(call);
			if (api.offline)
				throw new ApiFailure("offline", "The server could not be reached.");
			if (api.unauthorized)
				throw new ApiFailure("unauthorized", "The token ran out.", 401);
		};
		const api: FakeApi = {
			calls: [],
			offline: false,
			loseReplies: 0,
			unauthorized: false,
			permissions: [...ALL],
			async me(): Promise<Me> {
				reach("GET me");
				return {
					user: {
						id: user.id,
						name: user.name,
						email: user.email ?? `${user.id}@example.com`,
						image: null,
					},
					teams: [
						{
							id: TEAM,
							name: "Pedal & Pine web",
							slug: "pedal",
							role: "contributor",
							permissions: [...api.permissions],
						},
					],
				};
			},
			async changes(_team, since, limit) {
				reach(
					`GET changes ${since ?? ""}${limit === undefined ? "" : ` limit ${limit}`}`.trim(),
				);
				return server.changes(since, limit);
			},
			async getCase(_team, caseId) {
				reach(`GET case ${caseId}`);
				const row = server.cases.get(caseId);
				if (row === undefined || row.deleted) return undefined;
				return structuredClone({
					...row.value,
					shots: server.shotsOf(caseId),
					marks: server.marksOf(caseId),
				});
			},
			async ops(_team, ops) {
				reach(`POST ops ${ops.length}`);
				const answer = server.applyOps(
					ops,
					{ id: user.id, name: user.name },
					api.permissions,
				);
				if (api.loseReplies > 0) {
					api.loseReplies--;
					throw new ApiFailure("offline", "The reply was lost.");
				}
				return structuredClone(answer);
			},
			async hasBlob(_team, sha) {
				reach(`HEAD blob ${sha.slice(0, 8)}`);
				return server.blobs.has(sha);
			},
			async putBlob(_team, sha, image) {
				reach(`PUT blob ${sha.slice(0, 8)}`);
				if ((await sha256Of(image)) !== sha)
					throw new ApiFailure(
						"refused",
						"The image is not the one its name says.",
						400,
						"invalid",
					);
				server.blobs.set(sha, image);
			},
			async getBlob(_team, sha) {
				reach(`GET blob ${sha.slice(0, 8)}`);
				const blob = server.blobs.get(sha);
				if (blob === undefined)
					throw new ApiFailure("refused", "No such image.", 404, "not_found");
				return blob;
			},
		};
		return api;
	}
}

function statusOf(r: WireResolution | null): WireMark["status"] {
	if (!r) return "open";
	if (r.kind === "fixed") return r.verified ? "verified" : "fixed";
	return r.kind;
}

/**
 * The same server over HTTP, as `fetch` reaches it: the token endpoint of a
 * public client (a code per person, refresh tokens that rotate) and the
 * API's routes, for what is tested through the real client (`httpApi`) and
 * the worker's sign-in.
 */
export function fakeHttp(
	server: FakeServer,
	origin: string,
	people: Record<string, UserRef & { email: string }>,
) {
	const state = {
		/** Access tokens that hold, to whose they are. */
		access: new Map<string, string>(),
		refresh: new Map<string, string>(),
		revoked: [] as string[],
		/** An answer in a request's stead (`"GET /api/v1/me"`): the API in trouble. */
		broken: undefined as
			| ((request: string) => Response | undefined)
			| undefined,
		requests: [] as string[],
		offline: false,
		/** Access tokens are refused, whatever they are. */
		expired: false,
		permissions: [...ALL],
	};
	let n = 0;
	const issue = (person: string) => {
		const access = `at_${person}_${++n}`;
		const refresh = `rt_${person}_${n}`;
		state.access.set(access, person);
		state.refresh.set(refresh, person);
		return {
			access_token: access,
			refresh_token: refresh,
			expires_in: 3600,
			token_type: "Bearer",
		};
	};
	const no = (status: number, code: string, message: string) =>
		Response.json({ error: { code, message } }, { status });

	async function fetcher(input: string, init?: RequestInit): Promise<Response> {
		const url = new URL(input);
		const method = init?.method ?? "GET";
		state.requests.push(`${method} ${url.pathname}`);
		if (state.offline) throw new TypeError("Failed to fetch");
		if (url.origin !== origin) return new Response("", { status: 404 });
		// Where this server signs people in, as it says itself.
		if (url.pathname === "/.well-known/oauth-authorization-server/api/auth")
			return Response.json({
				issuer: `${origin}/api/auth`,
				authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
				token_endpoint: `${origin}/api/auth/oauth2/token`,
				revocation_endpoint: `${origin}/api/auth/oauth2/revoke`,
			});
		if (url.pathname === "/api/auth/oauth2/token") {
			const body = new URLSearchParams(String(init?.body ?? ""));
			if (body.get("grant_type") === "authorization_code") {
				const person = /^code-(.+)$/.exec(body.get("code") ?? "")?.[1];
				if (person === undefined || people[person] === undefined)
					return Response.json({ error: "invalid_grant" }, { status: 400 });
				return Response.json(issue(person));
			}
			const old = body.get("refresh_token") ?? "";
			const person = state.refresh.get(old);
			if (person === undefined)
				return Response.json({ error: "invalid_grant" }, { status: 400 });
			state.refresh.delete(old);
			return Response.json(issue(person));
		}
		if (url.pathname === "/api/auth/oauth2/revoke") {
			// Only the extension's own refresh token that still holds ends a
			// grant: nothing is ended on anybody's say-so.
			const body = new URLSearchParams(String(init?.body ?? ""));
			const token = body.get("token") ?? "";
			if (
				body.get("client_id") !== "sitegloss-extension" ||
				!state.refresh.has(token)
			)
				return Response.json({ error: "invalid_request" }, { status: 400 });
			state.revoked.push(token);
			state.refresh.delete(token);
			return Response.json({});
		}
		const broken = state.broken?.(`${method} ${url.pathname}`);
		if (broken !== undefined) return broken;
		const bearer = new Headers(init?.headers).get("authorization") ?? "";
		const person = state.access.get(bearer.replace(/^Bearer /, ""));
		const user = person === undefined ? undefined : people[person];
		if (user === undefined || state.expired)
			return no(401, "unauthorized", "Sign in, or send an access token.");
		const api = server.api(user);
		api.permissions = state.permissions;
		if (url.pathname === "/api/v1/me") return Response.json(await api.me());
		const one = /^\/api\/v1\/teams\/([^/]+)\/cases\/([^/]+)$/.exec(
			url.pathname,
		);
		if (one !== null && one[1] === TEAM) {
			const detail = await api.getCase(TEAM, decodeURIComponent(one[2] ?? ""));
			return detail === undefined
				? no(404, "not_found", "No such case.")
				: Response.json(detail);
		}
		const route =
			/^\/api\/v1\/teams\/([^/]+)\/(changes|ops|blobs)(?:\/([0-9a-f]+))?$/.exec(
				url.pathname,
			);
		if (route === null || route[1] !== TEAM)
			return no(404, "not_found", "No such team.");
		const [, , what, sha = ""] = route;
		if (what === "changes") {
			const since = url.searchParams.get("since");
			const limit = url.searchParams.get("limit");
			return Response.json(
				await api.changes(
					TEAM,
					since === null ? undefined : Number(since),
					limit === null ? undefined : Number(limit),
				),
			);
		}
		if (what === "ops") {
			const body = JSON.parse(String(init?.body)) as { ops: Op[] };
			return Response.json(await api.ops(TEAM, body.ops));
		}
		if (method === "HEAD")
			return new Response(null, {
				status: (await api.hasBlob(TEAM, sha)) ? 200 : 404,
			});
		if (method === "PUT") {
			await api.putBlob(TEAM, sha, init?.body as Blob);
			return Response.json({ sha256: sha });
		}
		return server.blobs.has(sha)
			? new Response(await api.getBlob(TEAM, sha))
			: no(404, "not_found", "No such image.");
	}
	return { fetch: fetcher, state };
}
