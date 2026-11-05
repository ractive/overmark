/**
 * Turning what the content script drew into a stored case (service worker).
 *
 * The content script captures each screenshot under a pending path of its
 * own (`pending/<shot>.webp`), so a save can never overwrite an image another
 * case version references. Saving draws the marks and cuts the crops (slow,
 * outside any transaction), then commits in one transaction against the case
 * as it is stored at that moment: the shots get their final ids, the marks'
 * numbers are checked against the stored ones, and the case and its images are
 * written together. A verdict saved or marks added meanwhile are kept.
 */

import {
	type Annotation,
	CASE_FORMAT,
	type Case,
	cropImage,
	nextNumbers,
	type PageInfo,
	pendingImage,
	type Rect,
	type Shot,
	shotImage,
	validateCase,
} from "./case.ts";
import type { RenderedMark } from "./marks.ts";
import type { CaseStore, StoredImage } from "./store.ts";

/** An annotation as the content script sends it: with the crop's rectangle. */
export type AnnotationDraft = Omit<Annotation, "crop"> & { cropRect: Rect };

export interface SaveRequest {
	caseId: string;
	/** `false`: add to the existing case `caseId`. */
	isNew: boolean;
	title: string;
	page: PageInfo;
	/**
	 * New shots with provisional ids; their images are stored under
	 * `pendingImage(id)`. The saved case gives them their final ids.
	 */
	shots: Shot[];
	annotations: AnnotationDraft[];
	/** The id the pending screenshots are stored under, when not `caseId`. */
	imagesFrom?: string;
}

/** Cut several crops from one screenshot. */
export type Crop = (
	image: Blob,
	rects: readonly Rect[],
	dpr: number,
) => Promise<StoredImage[]>;

/** A screenshot with marks drawn on it. */
export type Draw = (
	image: Blob,
	marks: readonly RenderedMark[],
	dpr: number,
) => Promise<StoredImage>;

export class SaveError extends Error {
	override name = "SaveError";
}

/**
 * Write the crops and the case, then remove the pending screenshots. A save
 * that fails keeps them: the marks they belong to can be saved again. `draw`
 * puts the marks on screenshots that were taken without them.
 */
export async function saveCase(
	store: CaseStore,
	request: SaveRequest,
	crop: Crop,
	now: Date = new Date(),
	draw?: Draw,
): Promise<Case> {
	const from = request.imagesFrom ?? request.caseId;
	const screenshots = new Map<string, StoredImage>();
	const crops = new Map<AnnotationDraft, StoredImage>();
	for (const shot of request.shots) {
		const stored = await store.getImage(from, pendingImage(shot.id));
		if (stored === undefined)
			throw new SaveError(`the screenshot ${shot.id} is missing`);
		const drafts = request.annotations.filter((a) => a.shot === shot.id);
		const image = draw
			? await draw(stored.blob, drafts, shot.viewport.dpr)
			: stored;
		screenshots.set(shot.id, image);
		const cut = await crop(
			image.blob,
			drafts.map((d) => d.cropRect),
			shot.viewport.dpr,
		);
		drafts.forEach((d, i) => {
			const c = cut[i];
			if (c !== undefined) crops.set(d, c);
		});
	}
	for (const draft of request.annotations) {
		if (!crops.has(draft))
			throw new SaveError(`mark ${draft.number} names no new screenshot`);
	}
	const stamp = now.toISOString();
	const saved = await store.updateCase(request.caseId, (current) => {
		if (request.isNew && current !== undefined)
			throw new SaveError("A case with this id exists already.");
		if (!request.isNew && current === undefined)
			throw new SaveError("The case no longer exists.");
		const images = new Map<string, StoredImage>();
		const finalIds = new Map<string, string>();
		const shots = [...(current?.shots ?? [])];
		let shotNumber = nextNumbers(current).shot;
		for (const shot of request.shots) {
			const id = `s${shotNumber++}`;
			finalIds.set(shot.id, id);
			shots.push({ ...shot, id, image: shotImage(id) });
			const image = screenshots.get(shot.id);
			if (image !== undefined)
				images.set(shotImage(id), {
					blob: image.blob,
					width: image.width,
					height: image.height,
				});
		}
		const taken = new Set(current?.annotations.map((a) => a.number));
		const annotations: Annotation[] = [...(current?.annotations ?? [])];
		for (const draft of request.annotations) {
			if (taken.has(draft.number))
				throw new SaveError(
					`mark ${draft.number} exists in the case already (it changed meanwhile). Click "Add marks" in the side panel again, then save.`,
				);
			taken.add(draft.number);
			const { cropRect: _, ...rest } = draft;
			const id = `a${draft.number}`;
			annotations.push({
				...rest,
				id,
				shot: finalIds.get(draft.shot) ?? draft.shot,
				crop: cropImage(id),
			});
			const image = crops.get(draft);
			if (image !== undefined) images.set(cropImage(id), image);
		}
		const value = validateCase({
			format: CASE_FORMAT,
			id: request.caseId,
			title: current?.title ?? (request.title.trim() || "Untitled case"),
			createdAt: current?.createdAt ?? stamp,
			updatedAt: stamp,
			page: current?.page ?? request.page,
			shots,
			annotations,
			verdict: current?.verdict ?? null,
		});
		return { value, images };
	});
	await store
		.deleteImages(
			from,
			request.shots.map((s) => pendingImage(s.id)),
		)
		.catch(() => undefined);
	return saved;
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
