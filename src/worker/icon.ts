/**
 * The toolbar icon while AI access is on: Sitegloss's icon with a green
 * spark in its corner, instead of the "on" badge (the owner, 2026-11-12).
 * Chrome's badges show text only, so the spark is drawn into the icon.
 */

/** The spark's green; the white edge keeps it apart from any icon colour. */
export const SPARK_GREEN = "#16a34a";
const SPARK_EDGE = "#ffffff";

/** One four-pointed star: centre and radius, as fractions of the icon size. */
interface Star {
	x: number;
	y: number;
	r: number;
}

/** A large star in the lower right corner and a small one above it. */
export const SPARK: readonly Star[] = [
	{ x: 0.7, y: 0.7, r: 0.25 },
	{ x: 0.86, y: 0.32, r: 0.085 },
];
/** The white edge's width, as a fraction of the icon size. */
const EDGE = 0.1;
/** How far the sides bow in: 0 is a thin star, 1 a square. */
const WAIST = 0.2;

/** What of a 2D context the spark needs (a fake one in the tests). */
export interface SparkContext {
	beginPath(): void;
	moveTo(x: number, y: number): void;
	quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
	closePath(): void;
	fill(): void;
	stroke(): void;
	fillStyle: unknown;
	strokeStyle: unknown;
	lineWidth: number;
	lineJoin: unknown;
}

function star(c: SparkContext, { x, y, r }: Star, size: number): void {
	const cx = x * size;
	const cy = y * size;
	const rr = r * size;
	const k = WAIST * rr;
	c.beginPath();
	c.moveTo(cx, cy - rr);
	c.quadraticCurveTo(cx + k, cy - k, cx + rr, cy);
	c.quadraticCurveTo(cx + k, cy + k, cx, cy + rr);
	c.quadraticCurveTo(cx - k, cy + k, cx - rr, cy);
	c.quadraticCurveTo(cx - k, cy - k, cx, cy - rr);
	c.closePath();
}

/** Draw the spark over an icon of `size` pixels already on `c`. */
export function drawSpark(c: SparkContext, size: number): void {
	c.lineJoin = "round";
	c.strokeStyle = SPARK_EDGE;
	c.lineWidth = EDGE * size;
	for (const s of SPARK) {
		star(c, s, size);
		c.stroke();
	}
	c.fillStyle = SPARK_GREEN;
	for (const s of SPARK) {
		star(c, s, size);
		c.fill();
	}
}

/** The sizes Chrome's toolbar uses (1× and 2× screens). */
const SIZES = [16, 32] as const;

let sparked: Promise<Record<number, ImageData>> | undefined;

/** The icon with the spark, drawn once per worker. */
function sparkedIcon(): Promise<Record<number, ImageData>> {
	sparked ??= (async () => {
		const images: Record<number, ImageData> = {};
		for (const size of SIZES) {
			const response = await fetch(
				chrome.runtime.getURL(`icons/icon-${size}.png`),
			);
			const bitmap = await createImageBitmap(await response.blob());
			const canvas = new OffscreenCanvas(size, size);
			const c = canvas.getContext("2d");
			if (!c) throw new Error("no 2D context for the icon");
			c.drawImage(bitmap, 0, 0, size, size);
			bitmap.close();
			drawSpark(c, size);
			images[size] = c.getImageData(0, 0, size, size);
		}
		return images;
	})();
	// A failure is tried again at the next change.
	sparked.catch(() => (sparked = undefined));
	return sparked;
}

/** The plain icon: the manifest's, every size of it. */
function plainIcon(): Record<string, string> {
	const icon = chrome.runtime.getManifest().action?.default_icon;
	return typeof icon === "object"
		? icon
		: Object.fromEntries(SIZES.map((s) => [s, `icons/icon-${s}.png`]));
}

/** What the switch needs (fakes in the tests). */
export interface IconDeps {
	setIcon(details: chrome.action.TabIconDetails): Promise<void>;
	sparked(): Promise<Record<number, ImageData>>;
	plain(): Record<string, string>;
	/** The icon now shown, after each change that went through. */
	shown?(on: boolean): void;
}

/**
 * The toolbar icon with the spark (`on`) or without: a repeat does nothing,
 * the latest call wins over one still drawing, and a failed one is tried
 * again at the next call.
 */
export function iconSwitch(deps: IconDeps): (on: boolean) => Promise<void> {
	let wanted: boolean | undefined;
	let latest = 0;
	return async (on) => {
		if (wanted === on) return;
		wanted = on;
		const call = ++latest;
		try {
			const imageData = on ? await deps.sparked() : undefined;
			if (call !== latest) return;
			await deps.setIcon(imageData ? { imageData } : { path: deps.plain() });
			deps.shown?.(on);
		} catch (error) {
			if (call === latest) wanted = undefined;
			console.warn("Sitegloss: the toolbar icon", error);
		}
	};
}

/** Sitegloss's toolbar icon. */
export const showSpark = iconSwitch({
	setIcon: (details) => chrome.action.setIcon(details),
	sparked: sparkedIcon,
	plain: plainIcon,
	// For a look in the worker's console, and the end-to-end tests.
	shown: (on) => {
		(globalThis as { siteglossIcon?: string }).siteglossIcon = on
			? "spark"
			: "plain";
	},
});
