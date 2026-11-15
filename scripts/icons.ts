/**
 * Draws the logo's files from its geometry in `src/lib/logo.ts` (DEC-029), all
 * committed: the extension icons in `assets/icons/`, the store's icon in
 * `assets/store/` and SVGs in `assets/brand/`. From one geometry, so a PNG and
 * an SVG never disagree. A small PNG encoder keeps this free of image
 * packages (DEC-007).
 */

import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
	FULL_LOGO,
	LOGO_COLOURS,
	type LogoDrawing,
	type LogoPoint,
	pathData,
	SMALL_LOGO,
	TILE,
} from "../src/lib/logo.ts";
import { crc32 } from "../src/lib/zip.ts";

export const ICON_SIZES = [16, 32, 48, 128] as const;

const rgb = (hex: string): readonly number[] =>
	[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const BACKGROUND = rgb(LOGO_COLOURS.tile);
const AMBER = rgb(LOGO_COLOURS.amber);
const PAPER = rgb(LOGO_COLOURS.paper);
function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

/** An RGBA image as PNG. */
export function encodePng(
	width: number,
	height: number,
	rgba: Uint8Array,
): Uint8Array {
	const header = new Uint8Array(13);
	const hv = new DataView(header.buffer);
	hv.setUint32(0, width);
	hv.setUint32(4, height);
	header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA, deflate, no filter, no interlace
	const raw = new Uint8Array(height * (width * 4 + 1));
	for (let y = 0; y < height; y++) {
		raw.set(
			rgba.subarray(y * width * 4, (y + 1) * width * 4),
			y * (width * 4 + 1) + 1,
		);
	}
	const parts = [
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", new Uint8Array(deflateSync(raw))),
		chunk("IEND", new Uint8Array()),
	];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** Signed distance to a rounded square centred at 0 with half size `h`. */
function roundedSquare(x: number, y: number, h: number, r: number): number {
	const qx = Math.abs(x) - h + r;
	const qy = Math.abs(y) - h + r;
	return (
		Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
		Math.min(Math.max(qx, qy), 0) -
		r
	);
}

/** A polyline's segments, each with the box it reaches with the stroke. */
interface Stroke {
	segments: [number, number, number, number][];
	boxes: [number, number, number, number][];
	half: number;
}

function stroke(points: readonly LogoPoint[], width: number): Stroke {
	const half = width / 2;
	const segments: Stroke["segments"] = [];
	const boxes: Stroke["boxes"] = [];
	for (let i = 1; i < points.length; i++) {
		const [ax, ay] = points[i - 1] as LogoPoint;
		const [bx, by] = points[i] as LogoPoint;
		segments.push([ax, ay, bx, by]);
		boxes.push([
			Math.min(ax, bx) - half,
			Math.min(ay, by) - half,
			Math.max(ax, bx) + half,
			Math.max(ay, by) + half,
		]);
	}
	return { segments, boxes, half };
}

/** Within half the width of a segment: a round cap and join at every point. */
function inside(s: Stroke, x: number, y: number): boolean {
	const h2 = s.half * s.half;
	for (let i = 0; i < s.segments.length; i++) {
		const [x0, y0, x1, y1] = s.boxes[i] as Stroke["boxes"][number];
		if (x < x0 || x > x1 || y < y0 || y > y1) continue;
		const [ax, ay, bx, by] = s.segments[i] as Stroke["segments"][number];
		const dx = bx - ax;
		const dy = by - ay;
		const len2 = dx * dx + dy * dy;
		const t = len2 === 0 ? 0 : clamp(((x - ax) * dx + (y - ay) * dy) / len2);
		const ex = x - ax - t * dx;
		const ey = y - ay - t * dy;
		if (ex * ex + ey * ey <= h2) return true;
	}
	return false;
}

/**
 * The logo on a transparent `size` × `size` image, its 128-unit tile in the
 * square from `at` to `at + side` pixels: the tile, the glyph, the loop over
 * them, each sample in or out (16 per pixel).
 */
function drawLogo(
	size: number,
	drawing: LogoDrawing,
	at = 0,
	side = size,
): Uint8Array {
	const loop = stroke(drawing.loop, drawing.loopWidth);
	const glyph = drawing.glyph.map((g) => stroke(g, drawing.glyphWidth));
	const h = 64 - TILE.inset;
	const rgba = new Uint8Array(size * size * 4);
	const samples = 4;
	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			let cover = 0;
			const sum = [0, 0, 0];
			for (let sy = 0; sy < samples; sy++) {
				for (let sx = 0; sx < samples; sx++) {
					// in tile units, 0..128
					const x = ((px + (sx + 0.5) / samples - at) / side) * 128;
					const y = ((py + (sy + 0.5) / samples - at) / side) * 128;
					if (roundedSquare(x - 64, y - 64, h, TILE.radius) > 0) continue;
					cover++;
					const colour = inside(loop, x, y)
						? AMBER
						: glyph.some((g) => inside(g, x, y))
							? PAPER
							: BACKGROUND;
					for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (colour[c] ?? 0);
				}
			}
			const i = (py * size + px) * 4;
			if (cover === 0) continue;
			for (let c = 0; c < 3; c++)
				rgba[i + c] = Math.round((sum[c] ?? 0) / cover);
			rgba[i + 3] = Math.round((cover / (samples * samples)) * 255);
		}
	}
	return encodePng(size, size, rgba);
}

/** The toolbar's sizes draw the simpler logo, the larger ones the full one. */
export function drawIcon(size: number): Uint8Array {
	return drawLogo(size, size <= 32 ? SMALL_LOGO : FULL_LOGO);
}

/** The Chrome Web Store's icon: the logo in the middle 96 × 96, 16 px clear around it. */
export function drawStoreIcon(): Uint8Array {
	return drawLogo(128, FULL_LOGO, 16, 96);
}

/** The logo as SVG, on the dark tile or on the white one for dark backgrounds. */
export function logoSvg(drawing: LogoDrawing, light = false): string {
	const side = 128 - 2 * TILE.inset;
	const tile = light ? LOGO_COLOURS.lightTile : LOGO_COLOURS.tile;
	const glyph = light ? LOGO_COLOURS.ink : LOGO_COLOURS.paper;
	const round = 'fill="none" stroke-linecap="round" stroke-linejoin="round"';
	return [
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">',
		"<title>Sitegloss</title>",
		`<rect x="${TILE.inset}" y="${TILE.inset}" width="${side}" height="${side}" rx="${TILE.radius}" fill="${tile}"/>`,
		`<path d="${drawing.glyph.map(pathData).join(" ")}" ${round} stroke="${glyph}" stroke-width="${drawing.glyphWidth}"/>`,
		`<path d="${pathData(drawing.loop)}" ${round} stroke="${LOGO_COLOURS.amber}" stroke-width="${drawing.loopWidth}"/>`,
		"</svg>",
		"",
	].join("\n");
}

/** Every file this script writes, by its path from the repository's root. */
export function iconFiles(): Record<string, Uint8Array | string> {
	const files: Record<string, Uint8Array | string> = {};
	for (const size of ICON_SIZES)
		files[`assets/icons/icon-${size}.png`] = drawIcon(size);
	files["assets/store/icon-128.png"] = drawStoreIcon();
	files["assets/brand/icon.svg"] = logoSvg(FULL_LOGO);
	files["assets/brand/icon-small.svg"] = logoSvg(SMALL_LOGO);
	files["assets/brand/icon-light.svg"] = logoSvg(FULL_LOGO, true);
	files["assets/brand/icon-light-small.svg"] = logoSvg(SMALL_LOGO, true);
	return files;
}

if (import.meta.main) {
	for (const [path, data] of Object.entries(iconFiles())) {
		await Bun.write(join(import.meta.dir, "..", path), data);
		console.log(`Wrote ${path}`);
	}
}
