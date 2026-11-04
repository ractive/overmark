/**
 * Turning what the content script drew into a stored case (service worker):
 * crops from the screenshots it captured, and the case written or extended.
 */

import {
	type Annotation,
	CASE_FORMAT,
	type Case,
	cropImage,
	type PageInfo,
	type Rect,
	type Shot,
	validateCase,
} from "./case.ts";
import type { CaseStore, StoredImage } from "./store.ts";

/** An annotation as the content script sends it: with the crop's rectangle. */
export type AnnotationDraft = Omit<Annotation, "crop"> & { cropRect: Rect };

export interface SaveRequest {
	caseId: string;
	/** `false`: add to the existing case `caseId`. */
	isNew: boolean;
	title: string;
	page: PageInfo;
	/** New shots; their images are stored already. */
	shots: Shot[];
	annotations: AnnotationDraft[];
}

export type Crop = (
	image: Blob,
	rect: Rect,
	dpr: number,
) => Promise<StoredImage>;

export class SaveError extends Error {
	override name = "SaveError";
}

/** Write the crops and the case; on failure, remove the images it added. */
export async function saveCase(
	store: CaseStore,
	request: SaveRequest,
	crop: Crop,
	now: Date = new Date(),
): Promise<Case> {
	const existing = request.isNew
		? undefined
		: await store.getCase(request.caseId);
	if (!request.isNew && existing === undefined)
		throw new SaveError("The case no longer exists.");
	if (request.isNew && (await store.getCase(request.caseId)) !== undefined)
		throw new SaveError("A case with this id exists already.");
	try {
		const shots = [...(existing?.shots ?? []), ...request.shots];
		const annotations: Annotation[] = [...(existing?.annotations ?? [])];
		for (const draft of request.annotations) {
			const shot = shots.find((s) => s.id === draft.shot);
			if (shot === undefined) throw new SaveError(`unknown shot ${draft.shot}`);
			const image = await store.getImage(request.caseId, shot.image);
			if (image === undefined)
				throw new SaveError(`the screenshot ${shot.image} is missing`);
			const path = cropImage(draft.id);
			await store.putImage(
				request.caseId,
				path,
				await crop(image.blob, draft.cropRect, shot.viewport.dpr),
			);
			const { cropRect: _, ...rest } = draft;
			annotations.push({ ...rest, crop: path });
		}
		const stamp = now.toISOString();
		const saved = validateCase({
			format: CASE_FORMAT,
			id: request.caseId,
			title: request.title.trim() || existing?.title || "Untitled case",
			createdAt: existing?.createdAt ?? stamp,
			updatedAt: stamp,
			page: existing?.page ?? request.page,
			shots,
			annotations,
			verdict: existing?.verdict ?? null,
		});
		await store.putCase(saved);
		return saved;
	} catch (error) {
		await discardUnsaved(store, request.caseId);
		throw error;
	}
}

/** Remove the images of `caseId` that its stored version does not reference. */
export async function discardUnsaved(
	store: CaseStore,
	caseId: string,
): Promise<void> {
	const stored = await store.getCase(caseId);
	await store.pruneImages(caseId, referencedImages(stored));
}

export function referencedImages(c: Case | undefined): Set<string> {
	return new Set([
		...(c?.shots.map((s) => s.image) ?? []),
		...(c?.annotations.map((a) => a.crop) ?? []),
	]);
}

/** A rectangle grown by `pad` and kept inside the viewport. */
export function cropRectFor(
	bounds: Rect,
	viewport: { width: number; height: number },
): Rect {
	const pad = bounds.width === 0 && bounds.height === 0 ? 120 : 40;
	const x = Math.max(0, bounds.x - pad);
	const y = Math.max(0, bounds.y - pad);
	return {
		x,
		y,
		width: Math.max(
			1,
			Math.min(viewport.width, bounds.x + bounds.width + pad) - x,
		),
		height: Math.max(
			1,
			Math.min(viewport.height, bounds.y + bounds.height + pad) - y,
		),
	};
}
