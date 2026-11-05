import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, readZip, writeZip, ZipError } from "../src/lib/zip.ts";

const text = (s: string) => new TextEncoder().encode(s);

describe("crc32", () => {
	test("matches the reference value", () => {
		expect(crc32(text("123456789"))).toBe(0xcbf43926);
		expect(crc32(new Uint8Array())).toBe(0);
	});
});

describe("writeZip and readZip", () => {
	test("round trip with stored and deflated entries", async () => {
		const json = text(JSON.stringify({ a: "x".repeat(1000) }));
		const image = crypto.getRandomValues(new Uint8Array(2048));
		const zip = await writeZip([
			{ name: "case.json", data: json },
			{ name: "shots/s1.webp", data: image },
			{ name: "empty.txt", data: new Uint8Array() },
			{ name: "Ünïcode.md", data: text("ä") },
		]);
		expect(zip.length).toBeLessThan(json.length + image.length);
		const files = await readZip(zip);
		expect([...files.keys()]).toEqual([
			"case.json",
			"shots/s1.webp",
			"empty.txt",
			"Ünïcode.md",
		]);
		expect(files.get("case.json")).toEqual(json);
		expect(files.get("shots/s1.webp")).toEqual(image);
		expect(files.get("empty.txt")).toEqual(new Uint8Array());
		expect(new TextDecoder().decode(files.get("Ünïcode.md"))).toBe("ä");
	});

	test.skipIf(Bun.which("unzip") === null)(
		"readable by the system unzip",
		async () => {
			const zip = await writeZip([
				{ name: "a/b.txt", data: text("hello ".repeat(100)) },
			]);
			const dir = mkdtempSync(join(tmpdir(), "overmark-zip-"));
			try {
				await Bun.write(join(dir, "x.zip"), zip);
				const proc = Bun.spawnSync([
					"unzip",
					"-p",
					join(dir, "x.zip"),
					"a/b.txt",
				]);
				expect(proc.stdout.toString()).toBe("hello ".repeat(100));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	test("rejects duplicates, garbage and damaged entries", async () => {
		await expect(
			writeZip([
				{ name: "a", data: text("1") },
				{ name: "a", data: text("2") },
			]),
		).rejects.toThrow(ZipError);
		await expect(readZip(text("not a zip at all"))).rejects.toThrow(
			"not a zip archive",
		);
		const zip = await writeZip([{ name: "a.txt", data: text("abc") }], {
			compress: () => false,
		});
		const at = 30 + "a.txt".length;
		zip[at] = (zip[at] ?? 0) ^ 0xff; // flip a data byte
		await expect(readZip(zip)).rejects.toThrow("damaged entry");
	});

	test("unpacks only the entries asked for", async () => {
		const zip = await writeZip([
			{ name: "case.json", data: text("{}") },
			{ name: "big.bin", data: new Uint8Array(1000) },
		]);
		const files = await readZip(zip, {
			include: (name) => name === "case.json",
			maxTotalBytes: 10,
		});
		expect([...files.keys()]).toEqual(["case.json"]);
	});

	test("stops inflating an entry that is larger than it says", async () => {
		const data = new Uint8Array(64 * 1024 * 1024); // zeros deflate to ~64 KB
		const zip = await writeZip([{ name: "bomb", data }]);
		const view = new DataView(zip.buffer);
		const central = zip.length - 22 - (46 + "bomb".length);
		expect(view.getUint32(central, true)).toBe(0x02014b50);
		view.setUint32(22, 1, true); // local header: size
		view.setUint32(central + 24, 1, true); // central directory: size
		// Count what the decompressor hands out: an inflate that reads to the
		// end would produce all 64 MB before any size check could fail it.
		const Original = globalThis.DecompressionStream;
		let produced = 0;
		class Counting {
			readonly readable: ReadableStream<Uint8Array>;
			readonly writable: WritableStream<BufferSource>;
			constructor(format: CompressionFormat) {
				const inner = new Original(format);
				this.writable = inner.writable;
				this.readable = inner.readable.pipeThrough(
					new TransformStream<Uint8Array, Uint8Array>({
						transform(chunk, controller) {
							produced += chunk.length;
							controller.enqueue(chunk);
						},
					}),
				);
			}
		}
		globalThis.DecompressionStream = Counting as typeof DecompressionStream;
		try {
			await expect(readZip(zip)).rejects.toThrow(
				"entry bomb unpacks to more than it says",
			);
		} finally {
			globalThis.DecompressionStream = Original;
		}
		expect(produced).toBeGreaterThan(0);
		expect(produced).toBeLessThan(8 * 1024 * 1024);
	}, 30_000);

	test("rejects a central directory that runs past the end", async () => {
		const zip = await writeZip([{ name: "a.txt", data: text("abc") }]);
		const view = new DataView(zip.buffer);
		const central = zip.length - 22 - (46 + "a.txt".length);
		view.setUint16(central + 28, 0xffff, true); // name length
		await expect(readZip(zip)).rejects.toThrow("broken central directory");
	});

	test("refuses to write more entries than a zip without zip64 holds", async () => {
		const entries = Array.from({ length: 0x10000 }, (_, i) => ({
			name: String(i),
			data: new Uint8Array(),
		}));
		await expect(writeZip(entries)).rejects.toThrow("more than 65535 entries");
	});

	test("enforces the limits", async () => {
		const zip = await writeZip([
			{ name: "a", data: new Uint8Array(100) },
			{ name: "b", data: new Uint8Array(100) },
		]);
		await expect(readZip(zip, { maxEntries: 1 })).rejects.toThrow(
			"more than 1 entries",
		);
		await expect(readZip(zip, { maxTotalBytes: 150 })).rejects.toThrow(
			"more than 150 bytes",
		);
	});
});
