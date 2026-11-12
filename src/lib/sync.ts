/**
 * One-way sync of the cases to a folder the user chose once (DEC-021): each
 * case is written there as its own file, exactly as Export writes it, and
 * again whenever it changes. The folder is a mirror: nothing is read back
 * from it, and a deleted case keeps its file, so a mistaken delete can be
 * undone with Import a case….
 *
 * The service worker is the one writer (`Sync`); the side panel only chooses
 * the folder, stops syncing and gives Chrome's permission again. Chrome takes
 * the permission back when the last extension page closes, so a change made
 * meanwhile (an AI app's) is written once the user allows access again: every
 * run writes each case whose version differs from what was written.
 */

import type { Case } from "./case.ts";
import { EXPORT_SUFFIX, exportCase, exportFileName } from "./export.ts";
import type { Kv } from "./kv.ts";
import type { CaseStore } from "./store.ts";

/** The part of a `FileSystemWritableFileStream` the sync uses. */
export interface SyncWritable {
	write(data: Blob): Promise<void>;
	close(): Promise<void>;
	abort(): Promise<void>;
}

/** The part of a `FileSystemFileHandle` the sync uses. */
export interface SyncFileHandle {
	createWritable(): Promise<SyncWritable>;
}

/**
 * The part of a `FileSystemDirectoryHandle` the sync uses; in Chrome a real
 * one, from `showDirectoryPicker` (or the origin's private file system in
 * the end-to-end tests).
 */
export interface SyncFolder {
	readonly name: string;
	getFileHandle(
		name: string,
		options?: { create?: boolean },
	): Promise<SyncFileHandle>;
	removeEntry(name: string): Promise<void>;
	queryPermission(descriptor: {
		mode: "readwrite";
	}): Promise<"granted" | "denied" | "prompt">;
}

/** The folder chosen, as the side panel keeps it. */
export interface ChosenFolder {
	handle: SyncFolder;
	/** Its name, for the panel. */
	name: string;
	/**
	 * Which folder this is: a new one gets a new id, so nothing written to the
	 * one before counts for it. Choosing the same folder again keeps the id.
	 */
	id: string;
}

/** What was written for a case: its version then, and the file's name. */
export interface SyncedFile {
	version: string;
	file: string;
}

/** What is in a folder, as far as Overmark wrote it. */
export interface SyncedFiles {
	folderId: string;
	/** By case id; deleted cases stay, as their files do. */
	byCase: Record<string, SyncedFile>;
}

export type SyncState = "syncing" | "synced" | "paused" | "failed";

export interface SyncStatus {
	/** The folder this is about: a status of another folder is no news. */
	folderId: string;
	state: SyncState;
	/** When the folder last held every case as it is (ISO). */
	lastSyncedAt?: string;
	/** Failed: what went wrong and what to do. */
	problem?: string;
	/** Syncing: how many cases are still to write. */
	left?: number;
}

/** Where the sync keeps its folder, what it wrote and its status. */
export interface SyncStore {
	folder(): Promise<ChosenFolder | undefined>;
	files(): Promise<SyncedFiles | undefined>;
	status(): Promise<SyncStatus | undefined>;
	/** Both at once. */
	save(files: SyncedFiles, status: SyncStatus): Promise<void>;
	saveStatus(status: SyncStatus): Promise<void>;
}

/**
 * The database of the sync, in the extension's origin: the side panel writes
 * `folder` (and `previous`, the folder before Stop syncing), the worker
 * `files` and `status`. Apart from the settings' database, which only the
 * worker uses (DEC-016).
 */
export const SYNC_DATABASE = "overmark-sync";
export const FOLDER_KEY = "folder";
export const PREVIOUS_KEY = "previous";
const FILES_KEY = "files";
export const STATUS_KEY = "status";

/** The sync's store in its database. */
export function kvSyncStore(kv: Kv): SyncStore {
	return {
		folder: async () => (await kv.get(FOLDER_KEY)) as ChosenFolder | undefined,
		files: async () => (await kv.get(FILES_KEY)) as SyncedFiles | undefined,
		status: async () => (await kv.get(STATUS_KEY)) as SyncStatus | undefined,
		save: (files, status) =>
			kv.set({ [FILES_KEY]: files, [STATUS_KEY]: status }),
		saveStatus: (status) => kv.set({ [STATUS_KEY]: status }),
	};
}

/** A case's version: an import may keep `updatedAt` and still change it. */
export const versionOf = (c: Case) => `${c.updatedAt}|${c.importedAt ?? ""}`;

const errorName = (error: unknown) =>
	error instanceof Error || error instanceof DOMException ? error.name : "";

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** No permission (any more): the user allows access again in the panel. */
class Paused extends Error {}

/** The folder cannot be written to at all: the run stops. */
class FolderFailed extends Error {}

/** What a failed write means, in plain words with what to do. */
function folderProblem(error: unknown, folder: string, file: string): Error {
	switch (errorName(error)) {
		case "NotAllowedError":
		case "SecurityError":
			return new Paused();
		case "NotFoundError":
			return new FolderFailed(
				`The folder “${folder}” is no longer there: it was moved, renamed or deleted. Click Change folder… to choose it again, or another one.`,
			);
		case "QuotaExceededError":
			return new FolderFailed(
				`There is no space left for “${file}” in “${folder}”. Free some space, then click Try again.`,
			);
		case "NoModificationAllowedError":
			return new FolderFailed(
				`“${file}” in “${folder}” is locked or open in another program. Close it, then click Try again.`,
			);
		default:
			return new FolderFailed(
				`Could not write “${file}” to “${folder}”: ${message(error)} Overmark tries again at the next change, or click Try again.`,
			);
	}
}

export interface SyncDeps {
	cases: CaseStore;
	store: SyncStore;
	/** The status changed: tell the side panel. */
	notify?: () => void;
	now?: () => Date;
	/** A case's file (Export's own); tests may fail it. */
	exportCase?: (store: CaseStore, c: Case) => Promise<Uint8Array>;
}

/**
 * The writer. `request()` after any change; runs never overlap, and changes
 * that come during a run start one more run after it.
 */
export class Sync {
	readonly #deps: SyncDeps;
	#dirty = false;
	#running: Promise<void> | undefined;

	constructor(deps: SyncDeps) {
		this.#deps = deps;
	}

	/** Bring the folder up to date, now or after the run at work. */
	request(): Promise<void> {
		this.#dirty = true;
		this.#running ??= this.#loop();
		return this.#running;
	}

	/** Resolves once no run is at work (tests). */
	idle(): Promise<void> {
		return this.#running ?? Promise.resolve();
	}

	async #loop(): Promise<void> {
		try {
			while (this.#dirty) {
				this.#dirty = false;
				try {
					await this.run();
				} catch (error) {
					console.warn("Overmark: sync", error);
				}
			}
		} finally {
			this.#running = undefined;
		}
	}

	#now(): string {
		return (this.#deps.now?.() ?? new Date()).toISOString();
	}

	async #report(status: SyncStatus, files?: SyncedFiles): Promise<void> {
		const { store, notify } = this.#deps;
		if (files === undefined) await store.saveStatus(status);
		else await store.save(files, status);
		notify?.();
	}

	/** One run; use `request`, which never runs two at once. */
	async run(): Promise<void> {
		const { cases, store } = this.#deps;
		const folder = await store.folder();
		if (folder === undefined) return;
		const before = await store.status();
		const last =
			before?.folderId === folder.id ? before.lastSyncedAt : undefined;
		const base = {
			folderId: folder.id,
			...(last === undefined ? {} : { lastSyncedAt: last }),
		};
		let permission: string;
		try {
			permission = await folder.handle.queryPermission({ mode: "readwrite" });
		} catch {
			permission = "prompt";
		}
		if (permission !== "granted")
			return this.#report({ ...base, state: "paused" });

		const record = await store.files();
		const byCase: Record<string, SyncedFile> =
			record?.folderId === folder.id ? { ...record.byCase } : {};
		const files = (): SyncedFiles => ({ folderId: folder.id, byCase });
		const all = await cases.listCases();
		const todo = all.filter((c) => byCase[c.id]?.version !== versionOf(c));
		if (todo.length === 0)
			return this.#report(
				{ folderId: folder.id, state: "synced", lastSyncedAt: this.#now() },
				files(),
			);

		// Which case each file name is Overmark's for, in this folder.
		const owner = new Map<string, string>();
		for (const [id, f] of Object.entries(byCase)) owner.set(f.file, id);
		const problems: string[] = [];
		let left = todo.length;
		await this.#report({ ...base, state: "syncing", left });
		for (const c of todo) {
			// Stop syncing, or another folder, meanwhile: this run is over.
			if ((await store.folder())?.id !== folder.id) return;
			const old = byCase[c.id]?.file;
			let name = "";
			try {
				name = await this.#fileName(folder.handle, c, old, owner);
				const zip = await (this.#deps.exportCase ?? exportCase)(cases, c);
				await write(folder.handle, name, zip).catch((error: unknown) => {
					throw folderProblem(error, folder.name, name);
				});
			} catch (error) {
				if (error instanceof Paused)
					return this.#report({ ...base, state: "paused" }, files());
				if (error instanceof FolderFailed)
					return this.#report(
						{ ...base, state: "failed", problem: error.message },
						files(),
					);
				if (name === "") {
					// Finding a free name: the folder answered with an error.
					const problem = folderProblem(error, folder.name, exportFileName(c));
					return this.#report(
						problem instanceof Paused
							? { ...base, state: "paused" }
							: { ...base, state: "failed", problem: problem.message },
						files(),
					);
				}
				// This case alone (an image missing, say): the others go on.
				problems.push(`“${c.title}” could not be written: ${message(error)}`);
				left--;
				continue;
			}
			// The same case under its new title: its old file goes.
			if (old !== undefined && old !== name) {
				await folder.handle.removeEntry(old).catch(() => undefined);
				owner.delete(old);
			}
			owner.set(name, c.id);
			byCase[c.id] = { version: versionOf(c), file: name };
			left--;
			// After each file, so that a worker stopped meanwhile starts from here.
			await this.#report({ ...base, state: "syncing", left }, files());
		}
		if (problems.length > 0)
			return this.#report(
				{
					...base,
					state: "failed",
					problem: `${problems.join(" ")} Overmark tries again at the next change, or click Try again.`,
				},
				files(),
			);
		return this.#report(
			{ folderId: folder.id, state: "synced", lastSyncedAt: this.#now() },
			files(),
		);
	}

	/**
	 * The file for `c`: Export's name for it (`login-button.overmark.zip`),
	 * with `-2`, `-3` when another case has that name already, a deleted one
	 * too, or when the folder has a file of that name Overmark did not write
	 * for this case: such a file is never overwritten. A case keeps its file
	 * while its title gives the same name.
	 */
	async #fileName(
		folder: SyncFolder,
		c: Case,
		current: string | undefined,
		owner: ReadonlyMap<string, string>,
	): Promise<string> {
		const wanted = exportFileName(c);
		const stem = wanted.slice(0, -EXPORT_SUFFIX.length);
		if (
			current !== undefined &&
			(current === wanted || isNumbered(current, stem))
		)
			return current;
		for (let n = 1; ; n++) {
			const name = n === 1 ? wanted : `${stem}-${n}${EXPORT_SUFFIX}`;
			const ownedBy = owner.get(name);
			if (ownedBy === c.id) return name;
			if (ownedBy !== undefined) continue;
			if (!(await exists(folder, name))) return name;
		}
	}
}

/** `stem-<n>.overmark.zip`, as `#fileName` numbers a name taken. */
function isNumbered(name: string, stem: string): boolean {
	if (!name.startsWith(`${stem}-`) || !name.endsWith(EXPORT_SUFFIX))
		return false;
	return /^(?:[2-9]|[1-9]\d+)$/.test(
		name.slice(stem.length + 1, -EXPORT_SUFFIX.length),
	);
}

/** Whether the folder has an entry of that name; only its name is looked at. */
async function exists(folder: SyncFolder, name: string): Promise<boolean> {
	try {
		await folder.getFileHandle(name);
		return true;
	} catch (error) {
		const why = errorName(error);
		if (why === "NotFoundError") return false;
		// A folder of that name.
		if (why === "TypeMismatchError") return true;
		throw error;
	}
}

/**
 * Write the file whole: Chrome writes to a temporary file and puts it in
 * place on `close`, so the folder never holds half a case.
 */
async function write(
	folder: SyncFolder,
	name: string,
	data: Uint8Array,
): Promise<void> {
	const file = await folder.getFileHandle(name, { create: true });
	const stream = await file.createWritable();
	try {
		await stream.write(
			new Blob([data as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
		);
		await stream.close();
	} catch (error) {
		await stream.abort().catch(() => undefined);
		throw error;
	}
}
