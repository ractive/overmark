/**
 * What the sync with sitegloss.dev keeps beside the cases (DEC-039), in a
 * database of its own (`sitegloss-cloud`): who is signed in and to which
 * team, how far the team's changes were read, and per case what the server
 * last had of it. The cases themselves stay as they are: a case holds nothing
 * of this, so it reads the same with or without an account.
 *
 * Ids: a mark is `a<number>` and a screenshot `s<n>` on this device, which
 * says where it is, not what it is; two devices give the same ids to
 * different things. At the server a mark and a screenshot have ids of their
 * own, made once on the device that made them. `marks` and `shots` say which
 * is which here.
 */

import type { Kv } from "../kv.ts";
import type {
	ImageRef,
	Op,
	Team,
	WireFinding,
	WirePage,
	WireReopen,
	WireResolution,
} from "./api.ts";

export const CLOUD_DATABASE = "sitegloss-cloud";

/** Keys in the database (the tokens' are in auth.ts). */
export const KEYS = {
	/** The server's address, when the user set another one. */
	server: "server",
	account: "account",
	/** The team's revision the changes were read up to. */
	cursor: "cursor",
	/** Operations sent, or about to be, and not confirmed yet. */
	queue: "queue",
	status: "status",
	/** How each case syncs: read by the panel, which needs no more of a book. */
	modes: "modes",
	/** When the team's whole state has to be read again. */
	whole: "whole",
} as const;

const BOOK = "case:";

/** Who is signed in, and where. */
export interface Account {
	server: string;
	user: { id: string; name: string; email: string };
	/** The user's teams, as the server last said, with what they may do in each. */
	teams: Team[];
	/** The team the cases sync to; none: not chosen yet (several teams, or none). */
	teamId?: string;
	/** When the teams were last asked for (ms). */
	checkedAt: number;
	/**
	 * The server refused the tokens: the user has to sign in again. What is
	 * kept (the books, the queue) goes on then.
	 */
	expired?: true;
}

/**
 * `synced`: goes to the team and follows it. `local`: stays on this device
 * (the user's choice, or what signing out leaves). `undecided`: it was here
 * before the team was chosen, and the user has not said yet.
 */
export type SyncMode = "synced" | "local" | "undecided";

/** What of a case a `case.patch` can say. */
export interface CaseContent {
	title: string;
	link: string | null;
	summary: string | null;
	pages: WirePage[];
	lastNumber: number;
}

/** What of a mark a `mark.patch` can say. */
export interface MarkContent {
	comment: string;
	author: "user" | "ai";
	resolution: WireResolution | null;
	reopens: WireReopen[];
	findings: WireFinding[];
}

/** A mark as the server last had it. */
export interface ShadowMark {
	number: number;
	/** Its screenshot's id at the server. */
	shotId: string;
	content: MarkContent;
	/** What never changes of it (its drawing and element), as one text. */
	fixed: string;
}

/** A case as the server last had it: what changes are found against. */
export interface Shadow {
	case: CaseContent;
	/** By the screenshot's id at the server. */
	shots: Record<string, { image: ImageRef }>;
	/** By the mark's id at the server. */
	marks: Record<string, ShadowMark>;
}

/** A change the server did not take: not sent again while it is the same. */
export interface Rejected {
	/** The operation without its id, as one short text (`opKey`). */
	key: string;
	/** Why, in words for the user. */
	text: string;
}

/** The bookkeeping of one case. */
export interface CaseBook {
	caseId: string;
	mode: SyncMode;
	/** The team it is synced with, or was. */
	teamId?: string;
	/** The mark's id here (`a<number>`) to its id at the server. */
	marks: Record<string, string>;
	/** The screenshot's id here (`s<n>`) to its id at the server. */
	shots: Record<string, string>;
	/** None: the server does not have the case (yet, or any more). */
	shadow?: Shadow;
	/** The case's `updatedAt` here when it last was as the shadow: nothing to send. */
	cleanAt?: string;
	rejected?: Rejected[];
	/**
	 * The changes last sent, as one text, and how often in a row the very
	 * same ones were found again: the server took them and the case came back
	 * as it was, so this device and the server do not agree on something.
	 * They are not sent a fourth time (`MAX_SAME_SENDS`).
	 */
	sent?: { keys: string; times: number };
	/** Its title, for a sentence about it once it is gone. */
	title?: string;
}

/** How often the very same changes are sent in a row before the sync stops sending them. */
export const MAX_SAME_SENDS = 3;

export const emptyBook = (
	caseId: string,
	mode: SyncMode,
	teamId?: string,
): CaseBook => ({
	caseId,
	mode,
	...(teamId === undefined ? {} : { teamId }),
	marks: {},
	shots: {},
});

/** Operations of one case on their way to the server. */
export interface Queue {
	caseId: string;
	teamId: string;
	ops: Op[];
}

/** What the panel shows of the sync. */
export interface CloudStatus {
	/**
	 * `off`: nobody signed in, or no team chosen. `signed-out`: the sign-in
	 * ran out, sign in again. `offline`: the server was not reached, it is
	 * tried again. `problem`: it answered with a failure of its own.
	 */
	state: "off" | "syncing" | "synced" | "offline" | "problem" | "signed-out";
	/** While syncing: how many cases are still to send. */
	left?: number;
	/** Why it is offline, has a problem or is signed out, in plain words. */
	text?: string;
	lastSyncedAt?: string;
	/** Changes the server did not take, and cases it could not give. */
	problems: { caseId?: string; title?: string; text: string }[];
	/** Cases that were here before the team was chosen and wait for an answer. */
	undecided: number;
}

export const OFF: CloudStatus = { state: "off", problems: [], undecided: 0 };

/** The books, read and written through the database. */
export class Books {
	constructor(private readonly kv: Kv) {}

	async all(): Promise<Map<string, CaseBook>> {
		const books = new Map<string, CaseBook>();
		for (const [key, value] of Object.entries(await this.kv.all()))
			if (key.startsWith(BOOK)) {
				const book = value as CaseBook;
				books.set(book.caseId, book);
			}
		return books;
	}

	async get(caseId: string): Promise<CaseBook | undefined> {
		return (await this.kv.get(BOOK + caseId)) as CaseBook | undefined;
	}

	async put(...books: CaseBook[]): Promise<void> {
		if (books.length === 0) return;
		await this.kv.set(
			Object.fromEntries(books.map((b) => [BOOK + b.caseId, b])),
		);
	}

	async remove(caseId: string): Promise<void> {
		await this.kv.remove(BOOK + caseId);
	}

	/** Write how each case syncs, for the panel. */
	async publishModes(): Promise<Record<string, SyncMode>> {
		const modes: Record<string, SyncMode> = {};
		for (const book of (await this.all()).values())
			modes[book.caseId] = book.mode;
		await this.kv.set({ [KEYS.modes]: modes });
		return modes;
	}
}

/** The account, as stored; `undefined`: nobody is signed in. */
export async function readAccount(kv: Kv): Promise<Account | undefined> {
	const account = (await kv.get(KEYS.account)) as Account | undefined;
	return typeof account?.server === "string" && account.user !== undefined
		? account
		: undefined;
}

/** The team chosen, with what the user may do in it. */
export function teamOf(account: Account | undefined): Team | undefined {
	return account?.teamId === undefined
		? undefined
		: account.teams.find((t) => t.id === account.teamId);
}
