/**
 * A case as a zip (`case.json`, `case.md`, `shots/`, `crops/`) and back.
 */

import { type Case, CaseError, validateCase } from "./case.ts";
import { caseMarkdown } from "./markdown.ts";
import { referencedImages } from "./save.ts";
import type { CaseStore } from "./store.ts";
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
	for (const path of referencedImages(c)) {
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

/** RIFF....WEBP */
function isWebp(data: Uint8Array): boolean {
	const ascii = (from: number, to: number) =>
		String.fromCharCode(...data.subarray(from, to));
	return data.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
}

export type Measure = (
	blob: Blob,
) => Promise<{ width: number; height: number }>;

const measureBitmap: Measure = async (blob) => {
	const bitmap = await createImageBitmap(blob);
	const size = { width: bitmap.width, height: bitmap.height };
	bitmap.close();
	return size;
};

/**
 * Read an exported case into the store. A case with the same id is replaced.
 * Returns the imported case.
 */
export async function importCase(
	store: CaseStore,
	zip: Uint8Array,
	measure: Measure = measureBitmap,
): Promise<Case> {
	const files = await readZip(zip, {
		maxEntries: 2500,
		maxTotalBytes: 300 * 1024 * 1024,
	});
	const json = files.get("case.json");
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
	const images = new Map<
		string,
		{ blob: Blob; width: number; height: number }
	>();
	for (const path of referencedImages(c)) {
		const data = files.get(path);
		if (data === undefined) throw new CaseError(`The export lacks ${path}.`);
		if (!isWebp(data)) throw new CaseError(`${path} is not a WebP image.`);
		const blob = new Blob([data as Uint8Array<ArrayBuffer>], {
			type: "image/webp",
		});
		images.set(path, { blob, ...(await measure(blob)) });
	}
	await store.deleteCase(c.id);
	for (const [path, image] of images) await store.putImage(c.id, path, image);
	await store.putCase(c);
	return c;
}
