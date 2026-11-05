/**
 * Where cases and their images live: IndexedDB in the extension's origin,
 * shared by the service worker and the side panel (database `overmark`, stores
 * `cases` and `images`). `MemoryStore` is the same for tests.
 */

import { type Case, imageKey } from "./case.ts";

export interface StoredImage {
	blob: Blob;
	/** Pixels. */
	width: number;
	height: number;
	/** For a screenshot waiting for its save: when it was taken (ms since the epoch). */
	storedAt?: number;
}

/**
 * A mark's screenshot waits under a pending path until the marks are saved,
 * which can be days in a tab left open; after that it counts as abandoned.
 */
export const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

const isPendingKey = (key: string) => key.includes("/pending/");

export interface CaseStore {
	/** All cases, newest change first. */
	listCases(): Promise<Case[]>;
	getCase(id: string): Promise<Case | undefined>;
	putCase(value: Case): Promise<void>;
	/** Deletes the case and its images. */
	deleteCase(id: string): Promise<void>;
	getImage(caseId: string, path: string): Promise<StoredImage | undefined>;
	putImage(caseId: string, path: string, image: StoredImage): Promise<void>;
	/**
	 * Read a case, change it and write it back in one transaction, so a
	 * concurrent writer (the side panel, another tab) is never overwritten.
	 * `change` runs synchronously inside the transaction and gets `undefined`
	 * for a missing case; throwing aborts everything. The images it returns
	 * are written in the same transaction.
	 */
	updateCase(id: string, change: CaseChange): Promise<Case>;
	/** Deletes these images of the case. */
	deleteImages(caseId: string, paths: readonly string[]): Promise<void>;
	/** Deletes the case's images whose paths are not in `keep`. */
	pruneImages(caseId: string, keep: ReadonlySet<string>): Promise<void>;
	/**
	 * Deletes screenshots of saves that never finished (the tab closed while
	 * saving): pending images stored before `before` (ms), or undated.
	 * Returns how many.
	 */
	sweepPending(before: number): Promise<number>;
	/**
	 * Replace a case and all its images at once (an import): either the new
	 * case and images are stored, or the old ones are kept.
	 */
	replaceCase(
		value: Case,
		images: ReadonlyMap<string, StoredImage>,
	): Promise<void>;
}

export type CaseChange = (current: Case | undefined) => {
	value: Case;
	/** Images to write with the case, by path. */
	images?: ReadonlyMap<string, StoredImage>;
};

function checkId(id: string, value: Case): void {
	if (value.id !== id)
		throw new Error(`updateCase: case ${id} cannot become ${value.id}`);
}

const byUpdate = (a: Case, b: Case) => b.updatedAt.localeCompare(a.updatedAt);

export class MemoryStore implements CaseStore {
	readonly cases = new Map<string, Case>();
	readonly images = new Map<string, StoredImage>();

	async listCases(): Promise<Case[]> {
		return [...this.cases.values()]
			.map((c) => structuredClone(c))
			.sort(byUpdate);
	}

	async getCase(id: string): Promise<Case | undefined> {
		const found = this.cases.get(id);
		return found === undefined ? undefined : structuredClone(found);
	}

	async putCase(value: Case): Promise<void> {
		this.cases.set(value.id, structuredClone(value));
	}

	async deleteCase(id: string): Promise<void> {
		this.cases.delete(id);
		for (const key of [...this.images.keys()])
			if (key.startsWith(`${id}/`)) this.images.delete(key);
	}

	async getImage(
		caseId: string,
		path: string,
	): Promise<StoredImage | undefined> {
		return this.images.get(imageKey(caseId, path));
	}

	async putImage(
		caseId: string,
		path: string,
		image: StoredImage,
	): Promise<void> {
		this.images.set(imageKey(caseId, path), image);
	}

	async updateCase(id: string, change: CaseChange): Promise<Case> {
		const current = this.cases.get(id);
		const { value, images } = change(
			current === undefined ? undefined : structuredClone(current),
		);
		checkId(id, value);
		this.cases.set(id, structuredClone(value));
		for (const [path, image] of images ?? [])
			this.images.set(imageKey(id, path), image);
		return structuredClone(value);
	}

	async deleteImages(caseId: string, paths: readonly string[]): Promise<void> {
		for (const path of paths) this.images.delete(imageKey(caseId, path));
	}

	async pruneImages(caseId: string, keep: ReadonlySet<string>): Promise<void> {
		const prefix = `${caseId}/`;
		for (const key of [...this.images.keys()]) {
			if (key.startsWith(prefix) && !keep.has(key.slice(prefix.length)))
				this.images.delete(key);
		}
	}

	async sweepPending(before: number): Promise<number> {
		let swept = 0;
		for (const [key, image] of [...this.images]) {
			if (isPendingKey(key) && (image.storedAt ?? 0) < before) {
				this.images.delete(key);
				swept++;
			}
		}
		return swept;
	}

	async replaceCase(
		value: Case,
		images: ReadonlyMap<string, StoredImage>,
	): Promise<void> {
		await this.deleteCase(value.id);
		for (const [path, image] of images)
			this.images.set(imageKey(value.id, path), image);
		this.cases.set(value.id, structuredClone(value));
	}
}

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
	});
}

const prefixRange = (caseId: string) =>
	IDBKeyRange.bound(`${caseId}/`, `${caseId}/￿`);

export class IdbStore implements CaseStore {
	#db: Promise<IDBDatabase> | undefined;

	#open(): Promise<IDBDatabase> {
		this.#db ??= new Promise((resolve, reject) => {
			const req = indexedDB.open("overmark", 1);
			req.onupgradeneeded = () => {
				req.result.createObjectStore("cases", { keyPath: "id" });
				req.result.createObjectStore("images");
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => {
				this.#db = undefined;
				reject(req.error);
			};
		});
		return this.#db;
	}

	async listCases(): Promise<Case[]> {
		const db = await this.#open();
		const cases = await request(
			db.transaction("cases").objectStore("cases").getAll(),
		);
		return (cases as Case[]).sort(byUpdate);
	}

	async getCase(id: string): Promise<Case | undefined> {
		const db = await this.#open();
		return (await request(
			db.transaction("cases").objectStore("cases").get(id),
		)) as Case | undefined;
	}

	async putCase(value: Case): Promise<void> {
		const db = await this.#open();
		const tx = db.transaction("cases", "readwrite");
		tx.objectStore("cases").put(value);
		await done(tx);
	}

	async deleteCase(id: string): Promise<void> {
		const db = await this.#open();
		const tx = db.transaction(["cases", "images"], "readwrite");
		tx.objectStore("cases").delete(id);
		tx.objectStore("images").delete(prefixRange(id));
		await done(tx);
	}

	async getImage(
		caseId: string,
		path: string,
	): Promise<StoredImage | undefined> {
		const db = await this.#open();
		return (await request(
			db
				.transaction("images")
				.objectStore("images")
				.get(imageKey(caseId, path)),
		)) as StoredImage | undefined;
	}

	async putImage(
		caseId: string,
		path: string,
		image: StoredImage,
	): Promise<void> {
		const db = await this.#open();
		const tx = db.transaction("images", "readwrite");
		tx.objectStore("images").put(image, imageKey(caseId, path));
		await done(tx);
	}

	async updateCase(id: string, change: CaseChange): Promise<Case> {
		const db = await this.#open();
		const tx = db.transaction(["cases", "images"], "readwrite");
		const cases = tx.objectStore("cases");
		let result: Case | undefined;
		let failure: unknown;
		const read = cases.get(id);
		read.onsuccess = () => {
			try {
				const { value, images } = change(read.result as Case | undefined);
				checkId(id, value);
				cases.put(value);
				const store = tx.objectStore("images");
				for (const [path, image] of images ?? [])
					store.put(image, imageKey(id, path));
				result = value;
			} catch (error) {
				failure = error;
				tx.abort();
			}
		};
		try {
			await done(tx);
		} catch (error) {
			throw failure ?? error;
		}
		if (result === undefined) throw failure ?? new Error("case not written");
		return result;
	}

	async deleteImages(caseId: string, paths: readonly string[]): Promise<void> {
		if (paths.length === 0) return;
		const db = await this.#open();
		const tx = db.transaction("images", "readwrite");
		const store = tx.objectStore("images");
		for (const path of paths) store.delete(imageKey(caseId, path));
		await done(tx);
	}

	async pruneImages(caseId: string, keep: ReadonlySet<string>): Promise<void> {
		const db = await this.#open();
		const tx = db.transaction("images", "readwrite");
		const store = tx.objectStore("images");
		const keys = (await request(
			store.getAllKeys(prefixRange(caseId)),
		)) as string[];
		for (const key of keys) {
			if (!keep.has(key.slice(caseId.length + 1))) store.delete(key);
		}
		await done(tx);
	}

	async sweepPending(before: number): Promise<number> {
		const db = await this.#open();
		const tx = db.transaction("images", "readwrite");
		let swept = 0;
		const cursor = tx.objectStore("images").openCursor();
		cursor.onsuccess = () => {
			const at = cursor.result;
			if (at === null) return;
			const image = at.value as StoredImage;
			if (isPendingKey(String(at.key)) && (image.storedAt ?? 0) < before) {
				at.delete();
				swept++;
			}
			at.continue();
		};
		await done(tx);
		return swept;
	}

	async replaceCase(
		value: Case,
		images: ReadonlyMap<string, StoredImage>,
	): Promise<void> {
		const db = await this.#open();
		const tx = db.transaction(["cases", "images"], "readwrite");
		const store = tx.objectStore("images");
		store.delete(prefixRange(value.id));
		for (const [path, image] of images)
			store.put(image, imageKey(value.id, path));
		tx.objectStore("cases").put(value);
		await done(tx);
	}
}
