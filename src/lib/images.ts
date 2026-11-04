/**
 * Screenshots and crops as WebP, with `createImageBitmap` and
 * `OffscreenCanvas` (service worker and side panel; DEC-007).
 */

import type { Rect } from "./case.ts";
import type { StoredImage } from "./store.ts";

/** The longest side Claude looks at; larger images are scaled down anyway. */
export const MAX_SIDE = 1568;

const QUALITY = 0.85;

async function render(
	source: ImageBitmap,
	crop: { x: number; y: number; width: number; height: number },
	maxSide: number,
): Promise<StoredImage> {
	const scale = Math.min(1, maxSide / Math.max(crop.width, crop.height));
	const width = Math.max(1, Math.round(crop.width * scale));
	const height = Math.max(1, Math.round(crop.height * scale));
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d");
	if (ctx === null) throw new Error("no 2d canvas");
	ctx.drawImage(
		source,
		crop.x,
		crop.y,
		crop.width,
		crop.height,
		0,
		0,
		width,
		height,
	);
	const blob = await canvas.convertToBlob({
		type: "image/webp",
		quality: QUALITY,
	});
	return { blob, width, height };
}

/** A `captureVisibleTab` data URL as a full-size WebP. */
export async function screenshotToWebp(dataUrl: string): Promise<StoredImage> {
	const blob = await (await fetch(dataUrl)).blob();
	const bitmap = await createImageBitmap(blob);
	try {
		return await render(
			bitmap,
			{ x: 0, y: 0, width: bitmap.width, height: bitmap.height },
			Number.POSITIVE_INFINITY,
		);
	} finally {
		bitmap.close();
	}
}

/**
 * A part of a screenshot: `rect` in CSS pixels of the shot, `dpr` its pixels
 * per CSS pixel. The crop is clamped to the image and at most `maxSide` long.
 */
export async function cropImage(
	image: Blob,
	rect: Rect,
	dpr: number,
	maxSide = MAX_SIDE,
): Promise<StoredImage> {
	const bitmap = await createImageBitmap(image);
	try {
		const x = Math.max(0, Math.floor(rect.x * dpr));
		const y = Math.max(0, Math.floor(rect.y * dpr));
		const width = Math.max(
			1,
			Math.min(bitmap.width - x, Math.ceil(rect.width * dpr)),
		);
		const height = Math.max(
			1,
			Math.min(bitmap.height - y, Math.ceil(rect.height * dpr)),
		);
		return await render(bitmap, { x, y, width, height }, maxSide);
	} finally {
		bitmap.close();
	}
}

/** The whole image, scaled down to at most `maxSide`. */
export async function scaleImage(
	image: Blob,
	maxSide = MAX_SIDE,
): Promise<StoredImage> {
	const bitmap = await createImageBitmap(image);
	try {
		return await render(
			bitmap,
			{ x: 0, y: 0, width: bitmap.width, height: bitmap.height },
			maxSide,
		);
	} finally {
		bitmap.close();
	}
}
