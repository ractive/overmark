import { beforeEach, describe, expect, test } from "bun:test";
import type { Case } from "../src/lib/case.ts";
import { readExport } from "../src/lib/export.ts";
import { type Kv, kvWhenOpen } from "../src/lib/kv.ts";
import { MemoryStore } from "../src/lib/store.ts";
import {
	type ChosenFolder,
	choiceOf,
	chooseDownloads,
	chooseFolder,
	type DownloadEnd,
	type DownloadsApi,
	downloadsTarget,
	FOLDER_KEY,
	FOLDERS_KEY,
	kvSyncStore,
	type PickedFolder,
	Sync,
	type SyncChoice,
	type SyncedFiles,
	type SyncFileHandle,
	type SyncStatus,
	type SyncStore,
	stopSyncing,
	TARGET_KEY,
	versionOf,
} from "../src/lib/sync.ts";
import { initialState } from "../src/sidepanel/state.ts";
import { startSync } from "../src/sidepanel/sync.ts";
import { memoryKv } from "../src/worker/kv.ts";
import { putCase, sampleCase } from "./fixtures.ts";

const domError = (name: string) => new DOMException(name, name);

/** A folder in memory, as a `FileSystemDirectoryHandle` behaves. */
class FakeFolder implements PickedFolder {
	readonly name: string;
	/** Where it is on the disk: every handle of this folder shares it. */
	readonly entry: object;
	readonly files: Map<string, Uint8Array>;
	/** Names that are folders inside it. */
	readonly folders = new Set<string>();
	permission: "granted" | "denied" | "prompt" = "granted";
	/** Gone from the disk: every call fails as Chrome's do. */
	gone = false;
	/** Fails the next writes with this error's name. */
	failWrites: string | undefined;
	writes: string[] = [];
	removed: string[] = [];

	constructor(name = "Overmark cases", same?: FakeFolder) {
		this.name = name;
		this.entry = same?.entry ?? {};
		this.files = same?.files ?? new Map();
	}

	/** The same folder, as the picker hands it over again: a new handle. */
	again(): FakeFolder {
		return new FakeFolder(this.name, this);
	}

	async isSameEntry(other: unknown): Promise<boolean> {
		return other instanceof FakeFolder && other.entry === this.entry;
	}

	async queryPermission(): Promise<"granted" | "denied" | "prompt"> {
		return this.permission;
	}

	#check(): void {
		if (this.permission !== "granted") throw domError("NotAllowedError");
		if (this.gone) throw domError("NotFoundError");
	}

	async getFileHandle(
		name: string,
		options: { create?: boolean } = {},
	): Promise<SyncFileHandle> {
		this.#check();
		if (this.folders.has(name)) throw domError("TypeMismatchError");
		if (!this.files.has(name) && !options.create)
			throw domError("NotFoundError");
		return {
			createWritable: async () => {
				this.#check();
				const parts: Blob[] = [];
				return {
					write: async (data: Blob) => {
						if (this.failWrites !== undefined) throw domError(this.failWrites);
						parts.push(data);
					},
					close: async () => {
						// In place only now, as Chrome does.
						this.files.set(
							name,
							new Uint8Array(await new Blob(parts).arrayBuffer()),
						);
						this.writes.push(name);
					},
					abort: async () => {},
				};
			},
		};
	}

	async removeEntry(name: string): Promise<void> {
		this.#check();
		if (!this.files.delete(name)) throw domError("NotFoundError");
		this.removed.push(name);
	}
}

/** The sync's store in memory; the handle is no clone, as IndexedDB's would be. */
class MemorySyncStore implements SyncStore {
	chosen: SyncChoice | undefined;
	/** The record saved last. */
	record: SyncedFiles | undefined;
	records = new Map<string, SyncedFiles>();
	current: SyncStatus | undefined;
	statuses: SyncStatus[] = [];

	/** Sync to `folder` (with id `id`) from now on. */
	useFolder(folder: FakeFolder, id: string) {
		this.chosen = {
			target: "folder",
			folder: { handle: folder, name: folder.name, id },
		};
	}
	async choice() {
		return this.chosen;
	}
	async files(folderId: string) {
		const record = this.records.get(folderId);
		return record === undefined ? undefined : structuredClone(record);
	}
	async status() {
		return this.current;
	}
	async save(files: SyncedFiles, status: SyncStatus) {
		this.record = structuredClone(files);
		this.records.set(files.folderId, structuredClone(files));
		await this.saveStatus(status);
	}
	async saveStatus(status: SyncStatus | undefined) {
		this.current = status;
		if (status !== undefined) this.statuses.push(status);
	}
}

const NOW = new Date("2026-11-12T09:30:00Z");

describe("the sync to a folder (DEC-021)", () => {
	let cases: MemoryStore;
	let folder: FakeFolder;
	let store: MemorySyncStore;
	let sync: Sync;
	let notified: number;

	const add = (id: string, title: string, updatedAt = "2026-11-12T08:00:00Z") =>
		putCase(cases, { ...sampleCase(id, updatedAt), title });
	const change = (c: Case, extra: Partial<Case> = {}) =>
		putCase(cases, {
			...c,
			...extra,
			updatedAt: new Date(Date.parse(c.updatedAt) + 60_000).toISOString(),
		});

	beforeEach(() => {
		cases = new MemoryStore();
		folder = new FakeFolder();
		store = new MemorySyncStore();
		store.useFolder(folder, "f_1");
		notified = 0;
		sync = new Sync({
			cases,
			store,
			now: () => NOW,
			notify: () => notified++,
		});
	});

	test("writes each case as its own export, under Export's file name", async () => {
		await add("c_1", "Login button contrast");
		await add("c_2", "Price table");
		await sync.request();
		expect([...folder.files.keys()].sort()).toEqual([
			"login-button-contrast.overmark.zip",
			"price-table.overmark.zip",
		]);
		const file = folder.files.get("login-button-contrast.overmark.zip");
		if (file === undefined) throw new Error("no file");
		// Import a case… reads it back.
		expect((await readExport(file)).case.id).toBe("c_1");
		expect(store.current).toEqual({
			folderId: "f_1",
			state: "synced",
			lastSyncedAt: NOW.toISOString(),
		});
		expect(store.record?.byCase["c_1"]).toEqual({
			version: versionOf((await cases.getCase("c_1")) as Case),
			file: "login-button-contrast.overmark.zip",
		});
		expect(notified).toBeGreaterThan(0);
	});

	test("an unchanged case is not written again; a changed one is overwritten", async () => {
		const c = await add("c_1", "Login");
		await add("c_2", "Other");
		await sync.request();
		folder.writes = [];
		await sync.request();
		expect(folder.writes).toEqual([]);
		await change(c, { verdict: "Fixed on dev" });
		await sync.request();
		expect(folder.writes).toEqual(["login.overmark.zip"]);
		const file = folder.files.get("login.overmark.zip") as Uint8Array;
		expect((await readExport(file)).case.verdict).toBe("Fixed on dev");
	});

	test("an import that keeps updatedAt is still written again", async () => {
		const c = await add("c_1", "Login");
		await sync.request();
		folder.writes = [];
		await putCase(cases, { ...c, importedAt: "2026-11-12T09:00:00Z" });
		await sync.request();
		expect(folder.writes).toEqual(["login.overmark.zip"]);
	});

	test("a renamed case gets its new file, and its old one goes", async () => {
		const c = await add("c_1", "Login");
		await sync.request();
		await change(c, { title: "Login button" });
		await sync.request();
		expect([...folder.files.keys()]).toEqual(["login-button.overmark.zip"]);
		expect(folder.removed).toEqual(["login.overmark.zip"]);
	});

	test("a deleted case keeps its file, and its name stays its own", async () => {
		await add("c_1", "Login");
		await sync.request();
		await cases.deleteCase("c_1");
		await sync.request();
		expect([...folder.files.keys()]).toEqual(["login.overmark.zip"]);
		expect(folder.removed).toEqual([]);
		// A new case of the same title does not overwrite it.
		await add("c_2", "Login");
		await sync.request();
		expect([...folder.files.keys()].sort()).toEqual([
			"login-2.overmark.zip",
			"login.overmark.zip",
		]);
		const kept = folder.files.get("login.overmark.zip") as Uint8Array;
		expect((await readExport(kept)).case.id).toBe("c_1");
	});

	test("two cases of the same title get two files, each keeps its own", async () => {
		const a = await add("c_1", "Login", "2026-11-12T08:00:00Z");
		await add("c_2", "Login", "2026-11-12T08:01:00Z");
		await sync.request();
		const names = [...folder.files.keys()].sort();
		expect(names).toEqual(["login-2.overmark.zip", "login.overmark.zip"]);
		const fileOf = (id: string) => store.record?.byCase[id]?.file;
		const before = { a: fileOf("c_1"), b: fileOf("c_2") };
		await change(a, { verdict: "Done" });
		await sync.request();
		expect({ a: fileOf("c_1"), b: fileOf("c_2") }).toEqual(before);
		expect([...folder.files.keys()].sort()).toEqual(names);
	});

	test("a file Overmark did not write is never overwritten", async () => {
		folder.files.set("login.overmark.zip", new Uint8Array([1, 2, 3]));
		folder.folders.add("login-2.overmark.zip");
		await add("c_1", "Login");
		await sync.request();
		expect(folder.files.get("login.overmark.zip")).toEqual(
			new Uint8Array([1, 2, 3]),
		);
		expect(store.record?.byCase["c_1"]?.file).toBe("login-3.overmark.zip");
	});

	test("another folder starts afresh; what was written to the old one does not count", async () => {
		await add("c_1", "Login");
		await sync.request();
		const other = new FakeFolder("Dropbox");
		store.useFolder(other, "f_2");
		await sync.request();
		expect([...other.files.keys()]).toEqual(["login.overmark.zip"]);
		expect(store.record?.folderId).toBe("f_2");
	});

	test("no permission: paused, nothing written, and the changes come once it is back", async () => {
		await add("c_1", "Login");
		await sync.request();
		folder.permission = "prompt";
		await add("c_2", "Price table");
		await sync.request();
		expect(store.current).toEqual({
			folderId: "f_1",
			state: "paused",
			reason: "access",
			lastSyncedAt: NOW.toISOString(),
		});
		expect(folder.files.has("price-table.overmark.zip")).toBe(false);
		folder.permission = "granted";
		folder.writes = [];
		await sync.request();
		expect(folder.writes).toEqual(["price-table.overmark.zip"]);
		expect(store.current?.state).toBe("synced");
	});

	test("permission taken back in the middle of a run: paused, what was written is kept", async () => {
		await add("c_1", "A", "2026-11-12T08:00:00Z");
		await add("c_2", "B", "2026-11-12T08:01:00Z");
		let exports = 0;
		sync = new Sync({
			cases,
			store,
			exportCase: async (s, c) => {
				if (++exports === 2) folder.permission = "denied";
				const { exportCase } = await import("../src/lib/export.ts");
				return exportCase(s, c);
			},
		});
		await sync.request();
		expect(store.current?.state).toBe("paused");
		expect(Object.keys(store.record?.byCase ?? {})).toEqual(["c_2"]);
	});

	test("the folder gone: failed, saying what to do", async () => {
		await add("c_1", "Login");
		folder.gone = true;
		await sync.request();
		expect(store.current?.state).toBe("failed");
		expect(store.current?.problem).toContain(
			"The folder “Overmark cases” is no longer there",
		);
		expect(store.current?.problem).toContain("Change…");
		folder.gone = false;
		await sync.request();
		expect(store.current?.state).toBe("synced");
	});

	test("no space left: failed, saying what to do", async () => {
		await add("c_1", "Login");
		folder.failWrites = "QuotaExceededError";
		await sync.request();
		expect(store.current?.state).toBe("failed");
		expect(store.current?.problem).toBe(
			"There is no space left for “login.overmark.zip” in “Overmark cases”. Free some space, then click Try again.",
		);
		expect(folder.files.size).toBe(0);
	});

	test("one case that cannot be exported does not stop the others", async () => {
		await add("c_1", "Broken", "2026-11-12T08:01:00Z");
		await putCase(cases, {
			...sampleCase("c_2", "2026-11-12T08:00:00Z"),
			title: "Fine",
		});
		// c_1 names a screenshot that is not stored.
		const broken = (await cases.getCase("c_1")) as Case;
		await putCase(cases, {
			...broken,
			shots: [
				{
					id: "s1",
					image: "shots/s1.webp",
					scrollX: 0,
					scrollY: 0,
					viewport: { width: 1280, height: 800, dpr: 2 },
					capturedAt: "2026-11-12T08:00:00Z",
				},
			],
		});
		await sync.request();
		expect([...folder.files.keys()]).toEqual(["fine.overmark.zip"]);
		expect(store.current?.state).toBe("failed");
		expect(store.current?.problem).toContain("“Broken” could not be written");
	});

	test("no folder chosen: nothing happens", async () => {
		store.chosen = undefined;
		await add("c_1", "Login");
		await sync.request();
		expect(store.current).toBeUndefined();
	});

	test("Stop syncing: the status goes, and the icon hears of it", async () => {
		folder.permission = "prompt";
		await sync.request();
		expect(store.current?.state).toBe("paused");
		const heard: (SyncStatus | undefined)[] = [];
		sync = new Sync({ cases, store, notify: (s) => heard.push(s) });
		store.chosen = undefined;
		await sync.request();
		expect(store.current).toBeUndefined();
		expect(heard).toEqual([undefined]);
	});

	test("runs never overlap; a change during a run starts one more after it", async () => {
		await add("c_1", "Login");
		let running = 0;
		let most = 0;
		sync = new Sync({
			cases,
			store,
			exportCase: async (s, c) => {
				running++;
				most = Math.max(most, running);
				await Bun.sleep(5);
				running--;
				const { exportCase } = await import("../src/lib/export.ts");
				return exportCase(s, c);
			},
		});
		const first = sync.request();
		await add("c_2", "Price table");
		void sync.request();
		void sync.request();
		await first;
		await sync.idle();
		expect(most).toBe(1);
		expect([...folder.files.keys()].sort()).toEqual([
			"login.overmark.zip",
			"price-table.overmark.zip",
		]);
	});

	test("Stop syncing during a run: the rest is not written", async () => {
		await add("c_1", "A", "2026-11-12T08:01:00Z");
		await add("c_2", "B", "2026-11-12T08:00:00Z");
		sync = new Sync({
			cases,
			store,
			exportCase: async (s, c) => {
				store.chosen = undefined;
				const { exportCase } = await import("../src/lib/export.ts");
				return exportCase(s, c);
			},
		});
		await sync.request();
		expect(folder.files.size).toBe(1);
	});

	test("the store in a key-value database keeps the record and the status together", async () => {
		const kv = memoryKv();
		const s = kvSyncStore(kv);
		await s.save(
			{ folderId: "f", byCase: { c_1: { version: "v", file: "a.zip" } } },
			{ folderId: "f", state: "synced" },
		);
		expect(await s.files("f")).toEqual({
			folderId: "f",
			byCase: { c_1: { version: "v", file: "a.zip" } },
		});
		expect(await s.status()).toEqual({ folderId: "f", state: "synced" });
		expect(await s.choice()).toBeUndefined();
		// Each folder has its own record.
		await s.save(
			{ folderId: "g", byCase: {} },
			{ folderId: "g", state: "synced" },
		);
		expect(await s.files("g")).toEqual({ folderId: "g", byCase: {} });
		expect((await s.files("f"))?.byCase["c_1"]?.file).toBe("a.zip");
		expect(await s.files("h")).toBeUndefined();
	});
});

/** Chrome's downloads in memory: the files in `Overmark/`, the list, the URLs. */
class FakeDownloads implements DownloadsApi {
	allowed = true;
	/** By path under the downloads folder. */
	readonly files = new Map<string, Uint8Array>();
	/** Chrome's download list: id and path. */
	readonly list = new Map<number, string>();
	readonly downloads: {
		url: string;
		filename: string;
		conflictAction: string;
		saveAs: boolean;
	}[] = [];
	readonly urls = new Map<string, Uint8Array>();
	readonly revoked: string[] = [];
	readonly erased: number[] = [];
	readonly cancelled: number[] = [];
	ends = 0;
	/** How the next downloads end, instead of complete. */
	next: DownloadEnd[] = [];
	/** Names Chrome refuses, besides Windows' own. */
	refuse: ((filename: string) => boolean) | undefined;
	/** The folder Chrome saved them in, if not where asked. */
	savedIn: string | undefined;
	#last: number | undefined;
	#id = 0;

	constructor(readonly cases: MemoryStore) {}

	async granted() {
		return this.allowed;
	}
	async url(c: Case) {
		const { exportCase } = await import("../src/lib/export.ts");
		const url = `blob:x/${this.urls.size + 1}`;
		this.urls.set(url, await exportCase(this.cases, c));
		return url;
	}
	async revoke(url: string) {
		this.revoked.push(url);
	}
	async download(options: {
		url: string;
		filename: string;
		conflictAction: "overwrite";
		saveAs: false;
	}) {
		if (!this.allowed) throw new TypeError("chrome.downloads is undefined");
		// Chrome refuses a name Windows reserves, on every platform.
		const base = options.filename.split("/").pop()?.split(".")[0] ?? "";
		if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base))
			throw new Error("Invalid filename");
		if (this.refuse?.(options.filename)) throw new Error("Invalid filename");
		this.downloads.push(options);
		const id = ++this.#id;
		const end = this.next.shift();
		if (end === undefined || end.state === "complete") {
			const data = this.urls.get(options.url);
			if (data === undefined) throw new Error("no such URL");
			this.files.set(options.filename, data);
		}
		this.list.set(id, options.filename);
		this.#ends.set(id, end);
		return id;
	}
	#ends = new Map<number, DownloadEnd | undefined>();
	async finished(id: number): Promise<DownloadEnd> {
		return (
			this.#ends.get(id) ?? {
				state: "complete",
				filename:
					this.savedIn === undefined
						? `/Users/me/Downloads/${this.list.get(id)}`
						: `${this.savedIn}/${this.list.get(id)?.split("/").pop()}`,
			}
		);
	}
	async cancel(id: number) {
		this.cancelled.push(id);
	}
	async erase(id: number) {
		this.erased.push(id);
		this.list.delete(id);
	}
	async last() {
		return this.#last;
	}
	async setLast(id: number) {
		this.#last = id;
	}
	async end() {
		this.ends++;
	}
}

describe("the sync to Downloads (DEC-025)", () => {
	let cases: MemoryStore;
	let api: FakeDownloads;
	let store: MemorySyncStore;
	let sync: Sync;

	const add = (id: string, title: string, updatedAt = "2026-11-12T08:00:00Z") =>
		putCase(cases, { ...sampleCase(id, updatedAt), title });

	beforeEach(() => {
		cases = new MemoryStore();
		api = new FakeDownloads(cases);
		store = new MemorySyncStore();
		store.chosen = { target: "downloads" };
		sync = new Sync({
			cases,
			store,
			now: () => NOW,
			downloads: downloadsTarget(api),
		});
	});

	test("writes each case into Overmark/ in the downloads, overwriting, without a dialog", async () => {
		await add("c_1", "Login button contrast");
		await sync.request();
		expect(api.downloads).toEqual([
			{
				url: "blob:x/1",
				filename: "Overmark/login-button-contrast.overmark.zip",
				conflictAction: "overwrite",
				saveAs: false,
			},
		]);
		const file = api.files.get("Overmark/login-button-contrast.overmark.zip");
		expect((await readExport(file as Uint8Array)).case.id).toBe("c_1");
		expect(store.current).toEqual({
			folderId: "downloads",
			state: "synced",
			lastSyncedAt: NOW.toISOString(),
		});
		expect(store.records.get("downloads")?.byCase["c_1"]?.file).toBe(
			"login-button-contrast.overmark.zip",
		);
		// The URL is revoked once the download is over, the document closed after the run.
		expect(api.revoked).toEqual(["blob:x/1"]);
		expect(api.ends).toBe(1);
	});

	test("an unchanged case is not written again", async () => {
		await add("c_1", "Login");
		await sync.request();
		await sync.request();
		expect(api.downloads).toHaveLength(1);
	});

	test("each write erases the entry before it from Chrome's list; the newest stays", async () => {
		const c = await add("c_1", "Login");
		await add("c_2", "Other", "2026-11-12T08:01:00Z");
		await sync.request();
		expect([...api.list.keys()]).toEqual([2]);
		expect(api.erased).toEqual([1]);
		await putCase(cases, { ...c, updatedAt: "2026-11-12T09:00:00Z" });
		await sync.request();
		expect([...api.list.keys()]).toEqual([3]);
		expect(api.erased).toEqual([1, 2]);
		// The files stay: only the list's entries go.
		expect([...api.files.keys()].sort()).toEqual([
			"Overmark/login.overmark.zip",
			"Overmark/other.overmark.zip",
		]);
	});

	test("a renamed case gets its new file; the old one stays, as nothing can be removed there", async () => {
		const c = await add("c_1", "Login");
		await sync.request();
		await putCase(cases, {
			...c,
			title: "Login button",
			updatedAt: "2026-11-12T09:00:00Z",
		});
		await sync.request();
		expect([...api.files.keys()].sort()).toEqual([
			"Overmark/login-button.overmark.zip",
			"Overmark/login.overmark.zip",
		]);
		expect(store.records.get("downloads")?.byCase["c_1"]?.file).toBe(
			"login-button.overmark.zip",
		);
	});

	test("a title Windows reserves (Con, Nul, COM1) gets a name Chrome takes", async () => {
		await add("c_1", "Con", "2026-11-12T08:00:00Z");
		await add("c_2", "COM1", "2026-11-12T08:01:00Z");
		await sync.request();
		expect([...api.files.keys()].sort()).toEqual([
			"Overmark/_com1.overmark.zip",
			"Overmark/_con.overmark.zip",
		]);
		expect(store.current?.state).toBe("synced");
	});

	test("a name Chrome refuses is that case's problem: the others are written", async () => {
		await add("c_1", "Odd", "2026-11-12T08:01:00Z");
		await add("c_2", "Fine", "2026-11-12T08:00:00Z");
		api.refuse = (f) => f.endsWith("/odd.overmark.zip");
		await sync.request();
		expect([...api.files.keys()]).toEqual(["Overmark/fine.overmark.zip"]);
		expect(store.current?.state).toBe("failed");
		expect(store.current?.problem).toContain("“Odd” could not be written");
	});

	test("two cases of the same title get -2", async () => {
		await add("c_1", "Login", "2026-11-12T08:00:00Z");
		await add("c_2", "Login", "2026-11-12T08:01:00Z");
		await sync.request();
		expect([...api.files.keys()].sort()).toEqual([
			"Overmark/login-2.overmark.zip",
			"Overmark/login.overmark.zip",
		]);
	});

	test("the permission gone: paused, saying it is the downloads; back once it is given again", async () => {
		await add("c_1", "Login");
		api.allowed = false;
		await sync.request();
		expect(store.current).toEqual({
			folderId: "downloads",
			state: "paused",
			reason: "downloads",
		});
		expect(api.files.size).toBe(0);
		api.allowed = true;
		await sync.request();
		expect(store.current?.state).toBe("synced");
		expect(api.files.size).toBe(1);
	});

	test("the permission taken back in a run: paused, what was written is kept", async () => {
		await add("c_1", "A", "2026-11-12T08:01:00Z");
		await add("c_2", "B", "2026-11-12T08:00:00Z");
		const url = api.url.bind(api);
		let calls = 0;
		api.url = async (c) => {
			if (++calls === 2) api.allowed = false;
			return url(c);
		};
		await sync.request();
		expect(store.current?.state).toBe("paused");
		expect(store.current?.reason).toBe("downloads");
		expect(Object.keys(store.record?.byCase ?? {})).toHaveLength(1);
		// Its URL is revoked all the same.
		expect(api.revoked).toEqual(["blob:x/1", "blob:x/2"]);
	});

	test("an interrupted download: failed, saying what happened; written at the next run", async () => {
		await add("c_1", "Login");
		api.next = [{ state: "interrupted", error: "FILE_NO_SPACE" }];
		await sync.request();
		expect(store.current?.state).toBe("failed");
		expect(store.current?.problem).toBe(
			"There is no space left in your downloads for “login.overmark.zip”. Free some space, then click Try again.",
		);
		expect(api.revoked).toEqual(["blob:x/1"]);
		await sync.request();
		expect(store.current?.state).toBe("synced");
	});

	test("Chrome's Save as, by “Ask where to save each file”: failed, saying how to turn it off", async () => {
		await add("c_1", "Login");
		api.next = [{ state: "interrupted", error: "USER_CANCELED" }];
		await sync.request();
		expect(store.current?.state).toBe("failed");
		expect(store.current?.problem).toContain(
			"“Ask where to save each file before downloading”",
		);
		expect(store.current?.problem).toContain("choose a folder instead");
	});

	test("a failure only the user can end is not tried again by itself, only by Try again", async () => {
		await add("c_1", "Login");
		api.next = Array.from({ length: 5 }, () => ({
			state: "interrupted" as const,
			error: "USER_CANCELED",
		}));
		for (let i = 0; i < 5; i++) await sync.request();
		expect(api.downloads).toHaveLength(1);
		expect(store.current?.state).toBe("failed");
		expect(store.current?.needsUser).toBe(true);
		// Its entry in Chrome's list goes too.
		expect(api.erased).toEqual([1]);
		// Try again (or a new choice) asks for it.
		await sync.request(true);
		expect(api.downloads).toHaveLength(2);
		api.next = [];
		await sync.request(true);
		expect(store.current?.state).toBe("synced");
		expect(store.current?.needsUser).toBeUndefined();
	});

	test("an interrupted download's entry is erased from Chrome's list", async () => {
		await add("c_1", "Login");
		api.next = [{ state: "interrupted", error: "NETWORK_FAILED" }];
		await sync.request();
		expect(api.erased).toEqual([1]);
	});

	test("saved somewhere else than Overmark/ (the user answered Save as): failed too", async () => {
		await add("c_1", "Login");
		api.savedIn = "/Users/me/Desktop";
		await sync.request();
		expect(store.current?.state).toBe("failed");
		expect(store.current?.problem).toContain("Ask where to save each file");
	});

	test("no end within the time: failed, and the download cancelled", async () => {
		await add("c_1", "Login");
		api.next = [{ state: "timeout" }];
		await sync.request();
		expect(store.current?.state).toBe("failed");
		expect(store.current?.problem).toContain("within a minute");
		expect(api.cancelled).toEqual([1]);
	});

	test("a case that cannot be exported does not stop the others", async () => {
		await add("c_1", "Broken", "2026-11-12T08:01:00Z");
		await add("c_2", "Fine", "2026-11-12T08:00:00Z");
		const url = api.url.bind(api);
		api.url = async (c) => {
			if (c.id === "c_1") throw new Error("a screenshot is missing.");
			return url(c);
		};
		await sync.request();
		expect([...api.files.keys()]).toEqual(["Overmark/fine.overmark.zip"]);
		expect(store.current?.state).toBe("failed");
		expect(store.current?.problem).toContain("“Broken” could not be written");
	});

	test("many cases failing: three named, the rest counted", async () => {
		for (let i = 0; i < 6; i++)
			await add(`c_${i}`, `Case ${i}`, `2026-11-12T08:0${i}:00Z`);
		api.url = async () => {
			throw new Error("a screenshot is missing.");
		};
		await sync.request();
		const problem = store.current?.problem ?? "";
		expect(problem.match(/” could not be written:/g)).toHaveLength(3);
		expect(problem).toContain("And 3 more cases could not be written.");
	});

	test("without a Downloads target (no such API): failed, saying so", async () => {
		sync = new Sync({ cases, store });
		await add("c_1", "Login");
		await sync.request();
		expect(store.current?.state).toBe("failed");
	});

	test("Sync to Downloads again writes every case again, into the files it had", async () => {
		const kv = referenceKv();
		sync = new Sync({
			cases,
			store: kvSyncStore(kv),
			downloads: downloadsTarget(api),
		});
		await add("c_1", "Login");
		await chooseDownloads(kv);
		await sync.request();
		// The user emptied Downloads/Overmark; then Stop syncing, Sync to Downloads.
		api.files.clear();
		await stopSyncing(kv);
		await sync.request();
		await chooseDownloads(kv);
		await sync.request();
		expect([...api.files.keys()]).toEqual(["Overmark/login.overmark.zip"]);
		expect(api.downloads).toHaveLength(2);
	});

	test("from a folder to Downloads: a record of its own, written afresh", async () => {
		await add("c_1", "Login");
		const folder = new FakeFolder();
		store.useFolder(folder, "f_1");
		await sync.request();
		store.chosen = { target: "downloads" };
		await sync.request();
		expect(api.files.size).toBe(1);
		expect(folder.files.size).toBe(1);
		expect(store.records.get("f_1")?.byCase["c_1"]).toBeDefined();
		expect(store.records.get("downloads")?.byCase["c_1"]).toBeDefined();
	});
});

describe("the stored choice (DEC-025)", () => {
	const folder: ChosenFolder = {
		handle: new FakeFolder(),
		name: "Overmark cases",
		id: "f_1",
	};

	test("no target and a folder: the folder, as before Downloads existed", () => {
		expect(choiceOf(undefined, folder)).toEqual({ target: "folder", folder });
		expect(choiceOf("folder", folder)).toEqual({ target: "folder", folder });
	});

	test("downloads, whatever folder is kept", () => {
		expect(choiceOf("downloads", undefined)).toEqual({ target: "downloads" });
		expect(choiceOf("downloads", folder)).toEqual({ target: "downloads" });
	});

	test("nothing, or a folder target without a folder: off", () => {
		expect(choiceOf(undefined, undefined)).toBeUndefined();
		expect(choiceOf("folder", undefined)).toBeUndefined();
	});

	test("someone syncing to a folder keeps doing so: the store reads it so", async () => {
		const kv = referenceKv();
		await kv.set({ [FOLDER_KEY]: folder });
		expect(await kvSyncStore(kv).choice()).toEqual({
			target: "folder",
			folder,
		});
	});

	test("Sync to Downloads, then a folder, then Stop syncing", async () => {
		const kv = referenceKv();
		await chooseDownloads(kv);
		expect(await kvSyncStore(kv).choice()).toEqual({ target: "downloads" });
		await chooseFolder(kv, new FakeFolder("A"), () => "f_9");
		expect(await kv.get(TARGET_KEY)).toBe("folder");
		expect((await kvSyncStore(kv).choice())?.target).toBe("folder");
		await chooseDownloads(kv);
		// The folder is no longer the one synced to, and stays known.
		expect(await kv.get(FOLDER_KEY)).toBeUndefined();
		expect((await kv.get(FOLDERS_KEY)) as ChosenFolder[]).toHaveLength(1);
		await stopSyncing(kv);
		expect(await kvSyncStore(kv).choice()).toBeUndefined();
	});
});

/**
 * A `Kv` that keeps its values as they are: a folder handle survives
 * IndexedDB's clone in Chrome, a fake one would not survive `structuredClone`.
 */
function referenceKv(): Kv {
	const data = new Map<string, unknown>();
	return {
		get: async (key) => data.get(key),
		all: async () => Object.fromEntries(data),
		async set(entries) {
			for (const [key, value] of Object.entries(entries)) data.set(key, value);
		},
		async remove(key) {
			data.delete(key);
		},
	};
}

describe("choosing a folder synced before (DEC-021)", () => {
	let cases: MemoryStore;
	let kv: Kv;
	let sync: Sync;
	let ids: number;
	const choose = (handle: FakeFolder) =>
		chooseFolder(kv, handle, () => `f_${++ids}`);

	beforeEach(() => {
		cases = new MemoryStore();
		kv = referenceKv();
		ids = 0;
		sync = new Sync({ cases, store: kvSyncStore(kv), now: () => NOW });
	});

	test("A, then B, then A again: A's files are Overmark's and updated in place", async () => {
		const login = await putCase(cases, {
			...sampleCase("c_1"),
			title: "Login",
		});
		const a = new FakeFolder("A");
		const b = new FakeFolder("B");
		const first = await choose(a);
		await sync.request();
		expect(await choose(b)).toMatchObject({ id: "f_2" });
		await sync.request();
		expect([...b.files.keys()]).toEqual(["login.overmark.zip"]);

		const changed = await putCase(cases, {
			...login,
			updatedAt: "2026-11-12T09:00:00Z",
		});
		const back = a.again();
		expect((await choose(back)).id).toBe(first.id);
		await sync.request();
		expect([...a.files.keys()]).toEqual(["login.overmark.zip"]);
		expect(back.writes).toEqual(["login.overmark.zip"]);
		const read = await readExport(
			a.files.get("login.overmark.zip") as Uint8Array,
		);
		expect(read.case.updatedAt).toBe(changed.updatedAt);
		expect((await kv.get(FOLDERS_KEY)) as ChosenFolder[]).toHaveLength(2);
	});

	test("A, Stop syncing, B, then A again: nothing is written twice", async () => {
		await putCase(cases, { ...sampleCase("c_1"), title: "Login" });
		const a = new FakeFolder("A");
		const first = await choose(a);
		await sync.request();
		await stopSyncing(kv);
		expect(await kv.get(FOLDER_KEY)).toBeUndefined();
		expect(await kv.get(TARGET_KEY)).toBeUndefined();
		await choose(new FakeFolder("B"));
		await sync.request();
		const back = a.again();
		expect((await choose(back)).id).toBe(first.id);
		await sync.request();
		// Unchanged since A was synced: nothing to write, and no `-2` copy.
		expect(back.writes).toEqual([]);
		expect([...a.files.keys()]).toEqual(["login.overmark.zip"]);
		expect(((await kv.get(FOLDER_KEY)) as ChosenFolder).handle).toBe(back);
	});

	test("a folder never synced gets a new id", async () => {
		await choose(new FakeFolder("A"));
		expect((await choose(new FakeFolder("A"))).id).toBe("f_2");
	});
});

describe("the sync's database, opened when first used", () => {
	test("a failed open is not kept: the next call opens again", async () => {
		let opens = 0;
		const kv = kvWhenOpen(async () => {
			opens++;
			if (opens === 1) throw new Error("disk error");
			return memoryKv({ folder: "A" });
		});
		await expect(kv.get("folder")).rejects.toThrow("disk error");
		expect(await kv.get("folder")).toBe("A");
		expect(await kv.all()).toEqual({ folder: "A" });
		expect(opens).toBe(2);
	});

	test("opened once while it works", async () => {
		let opens = 0;
		const kv = kvWhenOpen(async () => {
			opens++;
			return memoryKv();
		});
		await Promise.all([kv.set({ a: 1 }), kv.get("a"), kv.all()]);
		expect(await kv.get("a")).toBe(1);
		expect(opens).toBe(1);
	});

	test("the panel reads a folder stored before DEC-025 as the folder synced to", async () => {
		const globals = globalThis as unknown as Record<string, unknown>;
		const chromeBefore = globals["chrome"];
		globals["chrome"] = {
			runtime: { sendMessage: () => Promise.resolve() },
		};
		try {
			const state = initialState();
			const kv = referenceKv();
			await kv.set({
				[FOLDER_KEY]: { handle: new FakeFolder(), name: "iCloud", id: "f_1" },
				status: { folderId: "f_1", state: "paused", reason: "access" },
			});
			const panel = startSync((change) => change(state), kv);
			await panel.refresh();
			expect(state.sync.target).toBe("folder");
			expect(state.sync.folder).toBe("iCloud");
			expect(state.sync.status?.state).toBe("paused");
		} finally {
			globals["chrome"] = chromeBefore;
		}
	});

	test("the panel says so when it cannot read the sync's state, and stops saying it once it can", async () => {
		const globals = globalThis as unknown as Record<string, unknown>;
		const chromeBefore = globals["chrome"];
		globals["chrome"] = {
			runtime: { sendMessage: () => Promise.resolve() },
		};
		try {
			const state = initialState();
			let failing = true;
			const inner = memoryKv();
			const kv: Kv = {
				get: (key) => inner.get(key),
				all: () =>
					failing ? Promise.reject(new Error("disk error")) : inner.all(),
				set: (entries) => inner.set(entries),
				remove: (key) => inner.remove(key),
			};
			const panel = startSync((change) => change(state), kv);
			await panel.refresh();
			expect(state.sync.problem).toContain("Could not read the sync's state");
			expect(state.sync.problem).toContain("disk error");
			failing = false;
			await panel.refresh();
			expect(state.sync.problem).toBeUndefined();
		} finally {
			globals["chrome"] = chromeBefore;
		}
	});
});
