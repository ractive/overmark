import { describe, expect, test } from "bun:test";
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

	test("readable by the system unzip", async () => {
		const zip = await writeZip([
			{ name: "a/b.txt", data: text("hello ".repeat(100)) },
		]);
		const dir = `${process.env["TMPDIR"] ?? "/tmp"}/overmark-zip-${crypto.randomUUID()}`;
		await Bun.write(`${dir}/x.zip`, zip);
		const proc = Bun.spawnSync(["unzip", "-p", `${dir}/x.zip`, "a/b.txt"]);
		await Bun.$`rm -rf ${dir}`.quiet();
		if (proc.exitCode === null) return; // no unzip here
		expect(proc.stdout.toString()).toBe("hello ".repeat(100));
	});

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

	test("an entry that unpacks to more than it claims stops at its claim", async () => {
		const zip = await writeZip([
			{ name: "bomb", data: new Uint8Array(4 * 1024 * 1024) },
		]);
		const view = new DataView(zip.buffer);
		const central = zip.length - 22 - (46 + "bomb".length);
		expect(view.getUint16(8, true)).toBe(8); // deflated
		view.setUint32(22, 1, true); // local header: uncompressed size
		view.setUint32(central + 24, 1, true); // central directory: the same
		await expect(readZip(zip, { maxTotalBytes: 10 })).rejects.toThrow(
			"damaged entry: bomb",
		);
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
