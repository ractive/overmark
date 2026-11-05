/**
 * Draws the extension icons into `assets/icons/` (committed): a dark rounded
 * square with an amber ring, as if something on the page were circled. A
 * small PNG encoder keeps this free of image packages (DEC-007).
 */

import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { crc32 } from "../src/lib/zip.ts";

const BACKGROUND = [0x1d, 0x24, 0x33] as const;
const RING = [0xff, 0xb0, 0x00] as const;

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

export function drawIcon(size: number): Uint8Array {
	const rgba = new Uint8Array(size * size * 4);
	const samples = 4;
	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			let cover = 0;
			let ring = 0;
			for (let sy = 0; sy < samples; sy++) {
				for (let sx = 0; sx < samples; sx++) {
					// coordinates in -1..1
					const x = ((px + (sx + 0.5) / samples) / size) * 2 - 1;
					const y = ((py + (sy + 0.5) / samples) / size) * 2 - 1;
					if (roundedSquare(x, y, 0.98, 0.32) <= 0) {
						cover++;
						const d = Math.abs(Math.hypot(x * 1.08, y) - 0.52);
						if (d <= (size <= 16 ? 0.16 : 0.12)) ring++;
					}
				}
			}
			const n = samples * samples;
			const t = cover === 0 ? 0 : ring / cover;
			const i = (py * size + px) * 4;
			for (let c = 0; c < 3; c++) {
				rgba[i + c] = Math.round(
					(BACKGROUND[c] ?? 0) * (1 - t) + (RING[c] ?? 0) * t,
				);
			}
			rgba[i + 3] = Math.round(clamp(cover / n) * 255);
		}
	}
	return encodePng(size, size, rgba);
}

if (import.meta.main) {
	for (const size of [16, 32, 48, 128]) {
		const path = join(import.meta.dir, "../assets/icons", `icon-${size}.png`);
		await Bun.write(path, drawIcon(size));
		console.log(`Wrote ${path}`);
	}
}
