/**
 * Which screenshots a save needs: marks the user can see now are taken as
 * they are; the others are grouped into windows the size of the viewport,
 * from top to bottom. Each window becomes one screenshot.
 */

import type { Rect } from "../lib/case.ts";

export interface ShotWindow {
	scrollX: number;
	scrollY: number;
	/** Indexes into the marks given to `planShots`. */
	marks: number[];
}

export function planShots(
	/** Each mark's bounds in document coordinates. */
	marks: readonly Rect[],
	viewport: { width: number; height: number },
	page: { width: number; height: number },
	/** The current scroll position. */
	scroll: { x: number; y: number },
	margin = 24,
): ShotWindow[] {
	const maxY = Math.max(0, page.height - viewport.height);
	const maxX = Math.max(0, page.width - viewport.width);
	const fits = (rect: Rect, w: { scrollX: number; scrollY: number }) =>
		rect.y >= w.scrollY &&
		rect.y + rect.height <= w.scrollY + viewport.height &&
		rect.x >= w.scrollX &&
		rect.x + rect.width <= w.scrollX + viewport.width;
	const current: ShotWindow = {
		scrollX: scroll.x,
		scrollY: scroll.y,
		marks: [],
	};
	const order = marks
		.map((rect, index) => ({ rect, index }))
		.sort((a, b) => a.rect.y - b.rect.y || a.index - b.index);
	const windows: ShotWindow[] = [];
	for (const { rect, index } of order) {
		if (fits(rect, current)) {
			current.marks.push(index);
			continue;
		}
		const open = windows.at(-1);
		if (open !== undefined && fits(rect, open)) {
			open.marks.push(index);
			continue;
		}
		const x =
			rect.x >= scroll.x && rect.x + rect.width <= scroll.x + viewport.width
				? scroll.x
				: Math.min(maxX, Math.max(0, rect.x - margin));
		windows.push({
			scrollX: x,
			scrollY: Math.min(maxY, Math.max(0, rect.y - margin)),
			marks: [index],
		});
	}
	if (current.marks.length > 0) windows.push(current);
	return windows.sort((a, b) => a.scrollY - b.scrollY);
}
