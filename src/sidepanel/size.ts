/**
 * The tab's size in CSS pixels, as a case records it (`innerWidth`,
 * `innerHeight`), and the window size that gives a tab another one.
 */

export interface Size {
	width: number;
	height: number;
}

/** A pixel or two is rounding, not another layout. */
const SLACK = 2;

/** The tab's size in CSS pixels: Chrome's is in screen pixels, before zoom. */
export function cssSize(tab: Size, zoom: number): Size {
	const z = zoom > 0 ? zoom : 1;
	return {
		width: Math.round(tab.width / z),
		height: Math.round(tab.height / z),
	};
}

export function sameSize(a: Size, b: Size): boolean {
	return (
		Math.abs(a.width - b.width) <= SLACK &&
		Math.abs(a.height - b.height) <= SLACK
	);
}

/**
 * The window size that gives its tab `target` CSS pixels: the window grows by
 * what the tab lacks, so the side panel and the toolbars keep their room.
 */
export function windowFor(
	target: Size,
	tab: Size,
	window: Size,
	zoom: number,
): Size {
	const z = zoom > 0 ? zoom : 1;
	return {
		width: window.width + Math.round(target.width * z) - tab.width,
		height: window.height + Math.round(target.height * z) - tab.height,
	};
}

export interface Bounds extends Size {
	left: number;
	top: number;
}

/**
 * The window at `size` where it fits on `screen`: Chrome refuses a window
 * that is mostly off the screen, so it is no larger and moves in.
 */
export function onScreen(
	size: Size,
	at: { left: number; top: number },
	screen: Bounds,
): Bounds {
	const width = Math.min(size.width, screen.width);
	const height = Math.min(size.height, screen.height);
	const clamp = (value: number, start: number, room: number, length: number) =>
		Math.max(start, Math.min(value, start + room - length));
	return {
		width,
		height,
		left: clamp(at.left, screen.left, screen.width, width),
		top: clamp(at.top, screen.top, screen.height, height),
	};
}
