/**
 * A case as a zip (`case.json`, `case.md`, `shots/`, `crops/`) and back.
 */

import {
	type Case,
	CaseError,
	caseImages,
	newId,
	validateCase,
} from "./case.ts";
import { caseMarkdown } from "./markdown.ts";
import type { CaseStore, StoredImage } from "./store.ts";
import { readZip, writeZip, type ZipEntry } from "./zip.ts";

export const EXPORT_SUFFIX = ".overmark.zip";

/** `login-button-contrast.overmark.zip` */
export function exportFileName(c: Case): string {
	const slug = c.title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
	return `${slug || "case"}${EXPORT_SUFFIX}`;
}

export async function exportCase(
	store: CaseStore,
	c: Case,
): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const entries: ZipEntry[] = [
		{
			name: "case.json",
			data: encoder.encode(`${JSON.stringify(c, null, "\t")}\n`),
		},
		{ name: "case.md", data: encoder.encode(caseMarkdown(c)) },
	];
	for (const path of caseImages(c)) {
		const image = await store.getImage(c.id, path);
		if (image === undefined)
			throw new CaseError(`the image ${path} is missing`);
		entries.push({
			name: path,
			data: new Uint8Array(await image.blob.arrayBuffer()),
		});
	}
	return writeZip(entries);
}

/** The largest export the side panel reads. */
export const MAX_IMPORT_BYTES = 150 * 1024 * 1024;
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

/** Read and check an exported case without touching the store. */
export async function readExport(zip: Uint8Array): Promise<ParsedExport> {
	if (zip.length > MAX_IMPORT_BYTES)
		throw new CaseError(
			`The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`,
		);
	const limits = { maxEntries: 2500, maxTotalBytes: MAX_IMPORT_BYTES };
	const json = (
		await readZip(zip, { ...limits, include: (n) => n === "case.json" })
	).get("case.json");
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
		include: (n) => wanted.has(n),
	});
	const images = new Map<string, StoredImage>();
	for (const path of wanted) {
		const data = files.get(path);
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

/**
 * Store a read export: replacing a case with the same id, or as a copy with
 * a new id. Either everything is stored or nothing changes.
 */
export async function storeImport(
	store: CaseStore,
	parsed: ParsedExport,
	options: { copy?: boolean } = {},
): Promise<Case> {
	const c: Case = options.copy
		? { ...parsed.case, id: newId("c"), title: `${parsed.case.title} (copy)` }
		: parsed.case;
	await store.replaceCase(c, parsed.images);
	return c;
}

/** Read an export and store it, replacing a case with the same id. */
export async function importCase(
	store: CaseStore,
	zip: Uint8Array,
): Promise<Case> {
	return storeImport(store, await readExport(zip));
}
