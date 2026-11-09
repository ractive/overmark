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
	MAX_ANNOTATIONS,
	MAX_SHOTS,
	nextNumbers,
	type PageInfo,
	pendingImage,
	plainUrl,
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
	/**
	 * The pending screenshots stay after the save: the toolbar adds a case's
	 * marks one by one, and the next mark on the same view shares its picture.
	 * The toolbar discards them once no mark needs them.
	 */
	keepPending?: boolean;
	/**
	 * Marks of the case on the same view, drawn on the new shot under the new
	 * marks: the screenshot shows what the user saw, as one save would. Only
	 * marks numbered below the new ones are drawn: Undo, which takes the
	 * highest number out, then never leaves a pin of its mark behind.
	 */
	alsoDrawn?: (RenderedMark & { shot: string })[];
}

/** The most marks drawn on a screenshot besides its own (`alsoDrawn`). */
export const MAX_ALSO_DRAWN = 100;

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
	// Said plainly before the slow part, rather than by validateCase after it.
	if (!request.isNew) {
		const c = await store.getCase(request.caseId);
		if (c !== undefined) checkRoom(c, request);
	}
	const lowest = Math.min(...request.annotations.map((a) => a.number));
	const screenshots = new Map<string, StoredImage>();
	const crops = new Map<AnnotationDraft, StoredImage>();
	for (const shot of request.shots) {
		const stored = await store.getImage(from, pendingImage(shot.id));
		if (stored === undefined)
			throw new SaveError(`the screenshot ${shot.id} is missing`);
		const drafts = request.annotations.filter((a) => a.shot === shot.id);
		const others = (request.alsoDrawn ?? [])
			.slice(0, MAX_ALSO_DRAWN)
			.filter((m) => m.shot === shot.id && m.number < lowest);
		const image = draw
			? await draw(stored.blob, [...others, ...drafts], shot.viewport.dpr)
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
		if (current !== undefined) checkRoom(current, request);
		const images = new Map<string, StoredImage>();
		const finalIds = new Map<string, string>();
		const shots = [...(current?.shots ?? [])];
		let shotNumber = nextNumbers(current).shot;
		for (const shot of request.shots) {
			const id = `s${shotNumber++}`;
			finalIds.set(shot.id, id);
			shots.push({
				...shot,
				...(shot.url === undefined ? {} : { url: plainUrl(shot.url) }),
				id,
				image: shotImage(id),
			});
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
			// A deleted mark's number stays its own: its pin is on the screenshots.
			if (taken.has(draft.number) || draft.number <= (current?.lastNumber ?? 0))
				throw new SaveError(
					`mark ${draft.number} exists in the case already: the case changed meanwhile. Adding it again gives it the next free number.`,
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
			page: current?.page ?? {
				...request.page,
				url: plainUrl(request.page.url),
			},
			shots,
			annotations,
			verdict: current?.verdict ?? null,
			importedAt: current?.importedAt,
			lastNumber: current?.lastNumber,
		});
		return { value, images };
	});
	if (!request.keepPending)
		await store
			.deleteImages(
				from,
				request.shots.map((s) => pendingImage(s.id)),
			)
			.catch(() => undefined);
	return saved;
}

/** Whether a mark can take `number` in the case now, and the case's next number. */
export async function numberFree(
	store: CaseStore,
	caseId: string,
	number: number,
): Promise<{ free: boolean; next: number }> {
	const c = await store.getCase(caseId);
	if (c === undefined) throw new SaveError("The case no longer exists.");
	return {
		free:
			number > (c.lastNumber ?? 0) &&
			!c.annotations.some((a) => a.number === number),
		next: nextNumbers(c).annotation,
	};
}

/** How long after its screenshot the toolbar's Undo may take a mark out again. */
export const UNDO_WINDOW_MS = 24 * 60 * 60_000;

/** What the toolbar's add stored, as the worker recorded it (undo.ts). */
export interface AddedAs {
	shot: string;
	comment: string;
}

/**
 * Undo in the toolbar: take out the mark it just added, with its crop and its
 * screenshot. The worker allows it only for a mark this page added (undo.ts);
 * here the mark must still be as that add stored it (not resolved, its comment
 * not edited), the user's, the highest number in the case, on a screenshot of
 * its own taken lately. Its pin was on that screenshot only, which goes with
 * it, so its number is free again (unlike a delete, DEC-013).
 * `removed: false`: it was gone already (deleted in the side panel).
 */
export async function undoAdd(
	store: CaseStore,
	caseId: string,
	annotationId: string,
	added: AddedAs,
	now: Date = new Date(),
): Promise<{ removed: boolean; next: number }> {
	let removed = false;
	const saved = await store.updateCase(caseId, (current) => {
		if (current === undefined)
			throw new SaveError("The case no longer exists.");
		const gone = current.annotations.find((a) => a.id === annotationId);
		if (gone === undefined) return { value: current };
		const refuse = (why: string) =>
			new SaveError(
				`mark ${gone.number} ${why}; delete it in the side panel if it should go.`,
			);
		if (gone.resolution !== undefined) throw refuse("was resolved since");
		if (gone.comment !== added.comment || gone.author !== "user")
			throw refuse("was edited since");
		if (current.annotations.some((a) => a.number > gone.number))
			throw refuse("has marks after it");
		const shot = current.shots.find((s) => s.id === gone.shot);
		const shared = current.annotations.some(
			(a) => a !== gone && a.shot === gone.shot,
		);
		const age = now.getTime() - Date.parse(shot?.capturedAt ?? "");
		if (
			shot === undefined ||
			gone.shot !== added.shot ||
			shared ||
			!(age >= 0 && age < UNDO_WINDOW_MS)
		)
			throw refuse("cannot be undone here");
		removed = true;
		const value = validateCase({
			...current,
			annotations: current.annotations.filter((a) => a !== gone),
			shots: current.shots.filter((s) => s !== shot),
			updatedAt: now.toISOString(),
		});
		return { value, deleteImages: [gone.crop, shot.image] };
	});
	return { removed, next: nextNumbers(saved).annotation };
}

/** The case can take the request's marks and screenshots, or says why not. */
function checkRoom(c: Case, request: SaveRequest): void {
	const full =
		c.shots.length + request.shots.length > MAX_SHOTS
			? `${MAX_SHOTS} screenshots`
			: c.annotations.length + request.annotations.length > MAX_ANNOTATIONS
				? `${MAX_ANNOTATIONS} marks`
				: undefined;
	if (full !== undefined)
		throw new SaveError(
			`“${c.title}” holds ${full}, the most a case can; start a new case for further marks.`,
		);
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
