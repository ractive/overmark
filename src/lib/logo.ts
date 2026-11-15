/**
 * Overmark's logo (DEC-029): a light `</>` on a dark tile with a hand-drawn
 * amber pen loop round it. The geometry is the owner's, ported as it was
 * chosen; the icon files (`bun scripts/icons.ts`) and the bars' ring in the
 * page are all drawn from it, so they never disagree. Units: a 128 × 128 tile.
 */

export type LogoPoint = readonly [number, number];

export const LOGO_COLOURS = {
	tile: "#1d2433",
	amber: "#ffb000",
	paper: "#e8ebf2",
	/** The glyph on the white tile, for dark backgrounds. */
	ink: "#1b2130",
	lightTile: "#ffffff",
} as const;

/** The rounded tile, as the owner chose it from the drawings: the whole square, corners of 26. */
export const TILE = { inset: 0, radius: 26 } as const;

/** One drawing of the logo: polylines stroked with round caps and joins. */
export interface LogoDrawing {
	loop: readonly LogoPoint[];
	loopWidth: number;
	glyph: readonly (readonly LogoPoint[])[];
	glyphWidth: number;
}

const smoothstep = (x: number): number => {
	const t = Math.max(0, Math.min(1, x));
	return t * t * (3 - 2 * t);
};

interface LoopOptions {
	cx: number;
	cy: number;
	rx: number;
	ry: number;
	turns: number;
	/** Where it starts, in degrees (y down). */
	start: number;
	tilt: number;
	/** How far its last part moves outwards, so it ends above its own start. */
	end: number;
	/** Where (0..1 along the stroke) that move begins. */
	from: number;
	wobble: number;
	seed: number;
	n: number;
}

const LOOP: LoopOptions = {
	cx: 62,
	cy: 67,
	rx: 45,
	ry: 29,
	turns: 1.03,
	start: -78,
	tilt: -5,
	end: 10.5,
	from: 0.76,
	wobble: 0.018,
	seed: 0.9,
	n: 240,
};

/** The pen loop: from near the top, counterclockwise once round. */
export function loopPoints(options: Partial<LoopOptions> = {}): LogoPoint[] {
	const o = { ...LOOP, ...options };
	const rad = Math.PI / 180;
	const tilt = o.tilt * rad;
	const points: LogoPoint[] = [];
	for (let i = 0; i <= o.n; i++) {
		const t = i / o.n;
		const a = o.start * rad - t * o.turns * 2 * Math.PI;
		const k =
			1 +
			o.wobble * Math.sin(2 * a + o.seed) +
			0.4 * o.wobble * Math.sin(3 * a + 2 * o.seed);
		const off = o.end * smoothstep((t - o.from) / (1 - o.from));
		const x = (o.rx * k + off) * Math.cos(a);
		const y = (o.ry * k + off) * Math.sin(a);
		points.push([
			o.cx + x * Math.cos(tilt) - y * Math.sin(tilt),
			o.cy + x * Math.sin(tilt) + y * Math.cos(tilt),
		]);
	}
	return points;
}

/** The `</>` glyph as polylines; without the slash it is `< >`. */
export function glyphSegments(
	scale: number,
	slash: boolean,
	cx = 64,
	cy = 67,
): LogoPoint[][] {
	const s = scale;
	const out: LogoPoint[][] = [
		[
			[cx - 16 * s, cy - 14 * s],
			[cx - 30 * s, cy],
			[cx - 16 * s, cy + 14 * s],
		],
		[
			[cx + 16 * s, cy - 14 * s],
			[cx + 30 * s, cy],
			[cx + 16 * s, cy + 14 * s],
		],
	];
	if (slash)
		out.push([
			[cx + 6 * s, cy - 20 * s],
			[cx - 6 * s, cy + 20 * s],
		]);
	return out;
}

/** From 48 px up. */
export const FULL_LOGO: LogoDrawing = {
	loop: loopPoints(),
	loopWidth: 8,
	glyph: glyphSegments(0.78, true),
	glyphWidth: 8,
};

/** At 16 and 32 px, where `</>` is illegible: `< >` and a heavier loop. */
export const SMALL_LOGO: LogoDrawing = {
	loop: loopPoints({ end: 13, from: 0.72, rx: 44, ry: 29 }),
	loopWidth: 11,
	glyph: glyphSegments(0.7, false),
	glyphWidth: 12,
};

/**
 * On the page's bars, at 20 px: the small drawing's loop with a heavier pen.
 * Its end lifts further than in the icon, or a stroke this wide would close
 * the loop into a ring.
 */
export const BAR_LOOP = {
	points: loopPoints({ end: 22, from: 0.72, rx: 44, ry: 29 }),
	width: 14,
} as const;

const num = (v: number): string => String(Math.round(v * 100) / 100);

/** A polyline as an SVG path `d`, to two decimals. */
export function pathData(points: readonly LogoPoint[]): string {
	return points
		.map(([x, y], i) => `${i === 0 ? "M" : "L"}${num(x)} ${num(y)}`)
		.join(" ");
}

/** The box a polyline's stroke covers: x, y, width, height. */
export function strokeBounds(
	points: readonly LogoPoint[],
	width: number,
): [number, number, number, number] {
	const xs = points.map((p) => p[0]);
	const ys = points.map((p) => p[1]);
	const h = width / 2;
	const x = Math.min(...xs) - h;
	const y = Math.min(...ys) - h;
	return [x, y, Math.max(...xs) + h - x, Math.max(...ys) + h - y];
}
