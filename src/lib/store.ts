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
}

export interface CaseStore {
	/** All cases, newest change first. */
	listCases(): Promise<Case[]>;
	getCase(id: string): Promise<Case | undefined>;
	putCase(value: Case): Promise<void>;
	/** Deletes the case and its images. */
	deleteCase(id: string): Promise<void>;
	getImage(caseId: string, path: string): Promise<StoredImage | undefined>;
	putImage(caseId: string, path: string, image: StoredImage): Promise<void>;
	/** Deletes the case's images whose paths are not in `keep`. */
	pruneImages(caseId: string, keep: ReadonlySet<string>): Promise<void>;
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

	async pruneImages(caseId: string, keep: ReadonlySet<string>): Promise<void> {
		const prefix = `${caseId}/`;
		for (const key of [...this.images.keys()]) {
			if (key.startsWith(prefix) && !keep.has(key.slice(prefix.length)))
				this.images.delete(key);
		}
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
}
