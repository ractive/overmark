/**
 * The logo (DEC-029): its geometry as the owner chose it, and the icon files
 * drawn from it, which nobody edits by hand.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import {
	drawIcon,
	drawStoreIcon,
	ICON_SIZES,
	iconFiles,
} from "../scripts/icons.ts";
import {
	BAR_LOOP,
	FULL_LOGO,
	LOGO_COLOURS,
	type LogoPoint,
	SMALL_LOGO,
} from "../src/lib/logo.ts";

interface Image {
	width: number;
	height: number;
	rgba: Uint8Array;
}

/** Reads the PNGs the script writes: RGBA, 8 bits, every row unfiltered. */
function decodePng(png: Uint8Array): Image {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let at = 8;
	let width = 0;
	let height = 0;
	const data: Uint8Array[] = [];
	while (at < png.length) {
		const length = view.getUint32(at);
		const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
		const body = png.subarray(at + 8, at + 8 + length);
		if (type === "IHDR") {
			width = view.getUint32(at + 8);
			height = view.getUint32(at + 12);
			expect([...body.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
		}
		if (type === "IDAT") data.push(body);
		at += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(data));
	const rgba = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const row = y * (width * 4 + 1);
		expect(raw[row]).toBe(0);
		rgba.set(raw.subarray(row + 1, row + 1 + width * 4), y * width * 4);
	}
	return { width, height, rgba };
}

const rgb = (hex: string): number[] =>
	[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

function pixel(img: Image, x: number, y: number): number[] {
	const i = (y * img.width + x) * 4;
	return [...img.rgba.subarray(i, i + 4)];
}

/** The pixel at a point of the 128-unit tile. */
const at = (img: Image, ux: number, uy: number): number[] =>
	pixel(
		img,
		Math.floor((ux * img.width) / 128),
		Math.floor((uy * img.height) / 128),
	);

const near = (p: number[], hex: string, by = 24): boolean =>
	rgb(hex).every((c, i) => Math.abs(c - (p[i] ?? 0)) <= by) && p[3] === 255;

function count(img: Image, hex: string): number {
	let n = 0;
	for (let y = 0; y < img.height; y++)
		for (let x = 0; x < img.width; x++) if (near(pixel(img, x, y), hex)) n++;
	return n;
}

/** Every generated file, drawn once. */
const files = iconFiles();
const icons = new Map(ICON_SIZES.map((s) => [s, decodePng(drawIcon(s))]));
const icon = (size: number): Image => icons.get(size as 16) as Image;

describe("the icons", () => {
	for (const size of ICON_SIZES) {
		test(`${size} px: a tile with transparent corners, a light glyph and an amber loop`, () => {
			const img = icon(size);
			expect([img.width, img.height]).toEqual([size, size]);
			for (const [x, y] of [
				[0, 0],
				[size - 1, 0],
				[0, size - 1],
				[size - 1, size - 1],
			] as const)
				expect(pixel(img, x, y)[3]).toBe(0);
			// Below the loop, inside the tile, nothing is drawn.
			expect(near(at(img, 64, 116), LOGO_COLOURS.tile, 0)).toBe(true);
			expect(count(img, LOGO_COLOURS.amber)).toBeGreaterThan(0);
			expect(count(img, LOGO_COLOURS.paper)).toBeGreaterThan(0);
		});
	}

	test("16 and 32 px draw `< >`, 48 and 128 px the full `</>`", () => {
		// The middle of the slash: light in the full drawing, the tile in the small one.
		for (const size of [16, 32])
			expect(near(at(icon(size), 64, 67), LOGO_COLOURS.tile, 8)).toBe(true);
		for (const size of [48, 128])
			expect(near(at(icon(size), 64, 67), LOGO_COLOURS.paper, 40)).toBe(true);
	});

	test("the store's icon: 128 px, the logo inside 16 px of transparent padding", () => {
		const img = decodePng(drawStoreIcon());
		expect([img.width, img.height]).toEqual([128, 128]);
		for (let y = 0; y < 128; y++)
			for (let x = 0; x < 128; x++)
				if (x < 16 || x >= 112 || y < 16 || y >= 112)
					expect(pixel(img, x, y)[3]).toBe(0);
		expect(pixel(img, 64, 120)[3]).toBe(0);
		expect(near(pixel(img, 64, 104), LOGO_COLOURS.tile, 0)).toBe(true);
		expect(count(img, LOGO_COLOURS.amber)).toBeGreaterThan(100);
		expect(count(img, LOGO_COLOURS.paper)).toBeGreaterThan(20);
	});

	test("the committed files are what the script draws now", async () => {
		const root = join(import.meta.dir, "..");
		for (const [path, made] of Object.entries(files)) {
			const file = await Bun.file(join(root, path)).bytes();
			if (typeof made === "string")
				expect(new TextDecoder().decode(file), path).toBe(made);
			else expect(decodePng(file), path).toEqual(decodePng(made));
		}
	});

	test("the SVGs draw the same tile, glyph and loop", () => {
		const svg = files["assets/brand/icon-light-small.svg"] as string;
		expect(svg).toContain(`fill="${LOGO_COLOURS.lightTile}"`);
		expect(svg).toContain(`stroke="${LOGO_COLOURS.ink}" stroke-width="12"`);
		expect(svg).toContain(`stroke="${LOGO_COLOURS.amber}" stroke-width="11"`);
		const full = files["assets/brand/icon.svg"] as string;
		expect(full).toContain(`fill="${LOGO_COLOURS.tile}"`);
		expect(full).toContain(`stroke="${LOGO_COLOURS.paper}" stroke-width="8"`);
		// Three strokes in the full glyph: `<`, `>` and the slash.
		expect(full.match(/M/g)?.length).toBe(4);
	});
});

describe("the loop on the page's bars", () => {
	test("its two ends stay apart at the bars' stroke width", () => {
		const { points, width } = BAR_LOOP;
		const head = points.slice(0, 30);
		const tail = points.slice(-20);
		const gap = Math.min(
			...tail.flatMap(([x, y]) =>
				head.map(([hx, hy]) => Math.hypot(x - hx, y - hy)),
			),
		);
		// Centre lines further apart than one stroke: paper shows between them.
		expect(gap).toBeGreaterThan(width + 3);
	});
});

describe("the geometry matches the owner's", () => {
	const close = (p: LogoPoint | undefined, x: number, y: number) => {
		expect(Math.abs((p?.[0] ?? Number.NaN) - x)).toBeLessThan(0.05);
		expect(Math.abs((p?.[1] ?? Number.NaN) - y)).toBeLessThan(0.05);
	};

	test("the full drawing", () => {
		expect(FULL_LOGO.loop.length).toBe(241);
		close(FULL_LOGO.loop[0], 68.6915, 38.5913);
		close(FULL_LOGO.loop[120], 59.3909, 95.7885);
		close(FULL_LOGO.loop.at(-1), 59.7424, 28.0393);
		close(FULL_LOGO.glyph[0]?.[1], 40.6, 67);
		close(FULL_LOGO.glyph[2]?.[0], 68.68, 51.4);
		expect([FULL_LOGO.loopWidth, FULL_LOGO.glyphWidth]).toEqual([8, 8]);
	});

	test("the small drawing", () => {
		close(SMALL_LOGO.loop[0], 68.4891, 38.609);
		close(SMALL_LOGO.loop.at(-1), 59.5562, 25.5466);
		close(SMALL_LOGO.glyph[1]?.[1], 85, 67);
		expect(SMALL_LOGO.glyph.length).toBe(2);
		expect([SMALL_LOGO.loopWidth, SMALL_LOGO.glyphWidth]).toEqual([11, 12]);
	});
});
