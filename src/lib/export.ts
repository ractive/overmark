/**
 * A case as a zip (`case.json`, `case.md`, `shots/`, `crops/`) and back; and
 * all cases as one zip, a folder per case in that layout (DEC-020).
 */

import {
	type Case,
	CaseError,
	caseImages,
	MAX_TITLE,
	newId,
	plainUrl,
	validateCase,
} from "./case.ts";
import { caseMarkdown } from "./markdown.ts";
import type { CaseStore, StoredImage } from "./store.ts";
import { readZip, writeZip, type ZipEntry } from "./zip.ts";

export const EXPORT_SUFFIX = ".overmark.zip";

/** `login-button-contrast`: a case's title as a file or folder name. */
function slugOf(c: Case): string {
	const slug = c.title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
	return slug || "case";
}

/** `login-button-contrast.overmark.zip` */
export function exportFileName(c: Case): string {
	return `${slugOf(c)}${EXPORT_SUFFIX}`;
}

/** `overmark-cases-2026-11-12.overmark.zip`, by the local date. */
export function exportAllFileName(now = new Date()): string {
	const two = (n: number) => String(n).padStart(2, "0");
	return `overmark-cases-${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}${EXPORT_SUFFIX}`;
}

/** A case's files, each name after `folder` (`""`: at the top). */
async function caseEntries(
	store: CaseStore,
	c: Case,
	folder: string,
): Promise<ZipEntry[]> {
	const encoder = new TextEncoder();
	const entries: ZipEntry[] = [
		{
			name: `${folder}case.json`,
			data: encoder.encode(`${JSON.stringify(c, null, "\t")}\n`),
		},
		{ name: `${folder}case.md`, data: encoder.encode(caseMarkdown(c)) },
	];
	for (const path of caseImages(c)) {
		const image = await store.getImage(c.id, path);
		if (image === undefined)
			throw new CaseError(`the image ${path} of “${c.title}” is missing`);
		entries.push({
			name: `${folder}${path}`,
			data: new Uint8Array(await image.blob.arrayBuffer()),
		});
	}
	return entries;
}

export async function exportCase(
	store: CaseStore,
	c: Case,
): Promise<Uint8Array> {
	return writeZip(await caseEntries(store, c, ""));
}

/**
 * The folder of each case in a file of all cases, in their order: its title
 * as a file name, with `-2`, `-3` for a title that comes again.
 */
export function caseFolders(cases: readonly Case[]): string[] {
	const used = new Set<string>();
	return cases.map((c) => {
		const slug = slugOf(c);
		let name = slug;
		for (let n = 2; used.has(name); n++) name = `${slug}-${n}`;
		used.add(name);
		return name;
	});
}

/** The largest file of all cases the side panel reads (and writes). */
export const MAX_IMPORT_ALL_BYTES = 512 * 1024 * 1024;

/** Every case in one zip: a folder per case, each as `exportCase` lays it out. */
export async function exportAllCases(
	store: CaseStore,
	cases: readonly Case[],
): Promise<Uint8Array> {
	if (cases.length === 0) throw new CaseError("There are no cases to export.");
	const folders = caseFolders(cases);
	const entries: ZipEntry[] = [];
	let bytes = 0;
	for (const [i, c] of cases.entries()) {
		for (const entry of await caseEntries(store, c, `${folders[i]}/`)) {
			bytes += entry.data.length;
			entries.push(entry);
		}
		// A file the panel would refuse to import again is no use.
		if (bytes > MAX_IMPORT_ALL_BYTES)
			throw new CaseError(
				`All cases together are larger than ${MAX_IMPORT_ALL_BYTES / 1024 / 1024} MB. Export them one at a time.`,
			);
	}
	return writeZip(entries);
}

/** The largest export the side panel reads. */
export const MAX_IMPORT_BYTES = 150 * 1024 * 1024;

/** case.json is text about marks; a real one is far smaller than this. */
export const MAX_CASE_JSON_BYTES = 20 * 1024 * 1024;
/** Limits per imported image: larger ones are no Overmark screenshot. */
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 16_384;
export const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;

/**
 * Width and height from a WebP file's header (`VP8 `, `VP8L` or `VP8X`),
 * without decoding it; `undefined` when it is no WebP.
 */
export function webpSize(
	data: Uint8Array,
): { width: number; height: number } | undefined {
	const ascii = (from: number, to: number) =>
		String.fromCharCode(...data.subarray(from, to));
	if (data.length < 30 || ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WEBP")
		return undefined;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const u24 = (at: number) =>
		(data[at] ?? 0) | ((data[at + 1] ?? 0) << 8) | ((data[at + 2] ?? 0) << 16);
	switch (ascii(12, 16)) {
		case "VP8X":
			return { width: u24(24) + 1, height: u24(27) + 1 };
		case "VP8L": {
			if (data[20] !== 0x2f) return undefined;
			const bits = view.getUint32(21, true);
			return {
				width: (bits & 0x3fff) + 1,
				height: ((bits >>> 14) & 0x3fff) + 1,
			};
		}
		case "VP8 ":
			if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a)
				return undefined;
			return {
				width: view.getUint16(26, true) & 0x3fff,
				height: view.getUint16(28, true) & 0x3fff,
			};
		default:
			return undefined;
	}
}

/** An export read and checked, not stored yet. */
export interface ParsedExport {
	case: Case;
	images: Map<string, StoredImage>;
}

/** Entries in any one file of all cases: the zip format's own limit. */
const MAX_ALL_ENTRIES = 0xffff;

/**
 * Read and check the case in `folder` (`""`: at the top) of a zip already
 * checked for its size.
 */
async function readCaseIn(
	zip: Uint8Array,
	folder: string,
	maxEntries: number,
): Promise<ParsedExport> {
	const limits = { maxEntries, maxTotalBytes: MAX_IMPORT_BYTES };
	const json = (
		await readZip(zip, {
			...limits,
			maxTotalBytes: MAX_CASE_JSON_BYTES,
			include: (n) => n === `${folder}case.json`,
		})
	).get(`${folder}case.json`);
	if (json === undefined)
		throw new CaseError(
			"This is not an Overmark export: case.json is missing.",
		);
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(json));
	} catch {
		throw new CaseError("case.json is not valid JSON.");
	}
	const c = validateCase(parsed);
	const wanted = caseImages(c);
	const files = await readZip(zip, {
		...limits,
		include: (n) => n.startsWith(folder) && wanted.has(n.slice(folder.length)),
	});
	const images = new Map<string, StoredImage>();
	for (const path of wanted) {
		const data = files.get(`${folder}${path}`);
		if (data === undefined) throw new CaseError(`The export lacks ${path}.`);
		const size = webpSize(data);
		if (size === undefined) throw new CaseError(`${path} is not a WebP image.`);
		if (
			data.length > MAX_IMAGE_BYTES ||
			size.width < 1 ||
			size.height < 1 ||
			size.width > MAX_IMAGE_SIDE ||
			size.height > MAX_IMAGE_SIDE ||
			size.width * size.height > MAX_IMAGE_PIXELS
		)
			throw new CaseError(`${path} is too large for a screenshot.`);
		const blob = new Blob([data as Uint8Array<ArrayBuffer>], {
			type: "image/webp",
		});
		images.set(path, { blob, ...size });
	}
	return { case: c, images };
}

/** Read and check an exported case without touching the store. */
export async function readExport(zip: Uint8Array): Promise<ParsedExport> {
	if (zip.length > MAX_IMPORT_BYTES)
		throw new CaseError(
			`The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`,
		);
	return readCaseIn(zip, "", 2500);
}

/**
 * Read and check a file with one case (`exportCase`) or all of them
 * (`exportAllCases`): one case for a `case.json` at the top, else one for
 * each `<folder>/case.json`. One bad case refuses the whole file.
 */
export async function readExports(zip: Uint8Array): Promise<ParsedExport[]> {
	if (zip.length > MAX_IMPORT_ALL_BYTES)
		throw new CaseError(
			`The file is larger than ${MAX_IMPORT_ALL_BYTES / 1024 / 1024} MB.`,
		);
	// Only the names: nothing is unpacked.
	const names: string[] = [];
	await readZip(zip, {
		maxEntries: MAX_ALL_ENTRIES,
		include: (n) => {
			names.push(n);
			return false;
		},
	});
	if (names.includes("case.json")) return [await readExport(zip)];
	const folders = names.flatMap(
		(n) => /^([^/]+\/)case\.json$/.exec(n)?.[1] ?? [],
	);
	if (folders.length === 0)
		throw new CaseError(
			"This is not an Overmark export: case.json is missing.",
		);
	const cases: ParsedExport[] = [];
	const ids = new Set<string>();
	for (const folder of folders) {
		let parsed: ParsedExport;
		try {
			parsed = await readCaseIn(zip, folder, MAX_ALL_ENTRIES);
		} catch (error) {
			const why = error instanceof Error ? error.message : String(error);
			throw new CaseError(`In ${folder}: ${why}`);
		}
		if (ids.has(parsed.case.id))
			throw new CaseError(
				`The file holds the case ${parsed.case.id} twice (in ${folder}).`,
			);
		ids.add(parsed.case.id);
		cases.push(parsed);
	}
	return cases;
}

/**
 * Store a read export: replacing a case with the same id, or as a copy with
 * a new id. Either everything is stored or nothing changes. It is marked as
 * imported, whatever the file says, and keeps no more of the page's address
 * than a saved case does. Its findings are no AI app's own: the app a finding
 * names is whatever the file says (DEC-019).
 */
export async function storeImport(
	store: CaseStore,
	parsed: ParsedExport,
	options: { copy?: boolean; now?: Date } = {},
): Promise<Case> {
	const c: Case = {
		...parsed.case,
		...(options.copy
			? {
					id: newId("c"),
					title: `${parsed.case.title.slice(0, MAX_TITLE - COPY.length)}${COPY}`,
				}
			: {}),
		page: { ...parsed.case.page, url: plainUrl(parsed.case.page.url) },
		annotations: parsed.case.annotations.map((a) =>
			a.findings === undefined
				? a
				: {
						...a,
						findings: a.findings.map((f) => ({ ...f, imported: true })),
					},
		),
		importedAt: (options.now ?? new Date()).toISOString(),
	};
	await store.replaceCase(c, parsed.images);
	return c;
}

const COPY = " (copy)";
