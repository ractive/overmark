import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import {
	build,
	checkOutdir,
	createManifest,
	extensionId,
	readKey,
	zipBuild,
} from "../scripts/build.ts";
import { drawIcon } from "../scripts/icons.ts";
import { readZip } from "../src/lib/zip.ts";

const dirs: string[] = [];
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "overmark-build-"));
	dirs.push(dir);
	return dir;
};

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("extension ID", () => {
	test("the committed key gives the documented ID", async () => {
		expect(extensionId(await readKey())).toBe(
			"fphhchhlgklidhnodoleiebmdhnfdadg",
		);
	});
});

describe("manifest", () => {
	test("development: key, activeTab, optional <all_urls> only", () => {
		const m = createManifest("1.2.3", { key: "abc" });
		expect(m["manifest_version"]).toBe(3);
		expect(m["version"]).toBe("1.2.3");
		expect(m["key"]).toBe("abc");
		expect(m["permissions"]).toEqual(["activeTab", "scripting", "sidePanel"]);
		expect(m["optional_host_permissions"]).toEqual(["<all_urls>"]);
		expect(m["host_permissions"]).toBeUndefined();
	});

	test("test builds get host access", () => {
		expect(createManifest("1.0.0", { test: true })["host_permissions"]).toEqual(
			["<all_urls>"],
		);
	});
});

describe("build", () => {
	test("writes the bundles, the side panel, the icons and the manifest", async () => {
		const outdir = tempDir();
		const result = await build({ outdir });
		expect(result.id).toBe("fphhchhlgklidhnodoleiebmdhnfdadg");
		for (const file of [
			"background.js",
			"content.js",
			"sidepanel/index.html",
			"icons/icon-16.png",
			"icons/icon-128.png",
		]) {
			expect(await Bun.file(join(outdir, file)).exists()).toBe(true);
		}
		const html = await Bun.file(join(outdir, "sidepanel/index.html")).text();
		expect(html).not.toContain("main.ts");
		const manifest = await Bun.file(join(outdir, "manifest.json")).json();
		expect(manifest.key).toBe(await readKey());
		// The content script is a classic script: no module syntax at the top level.
		const content = await Bun.file(join(outdir, "content.js")).text();
		expect(content).not.toMatch(/^\s*(import|export)\s/m);
	});

	test("a store build has no key, and its zip holds no source maps", async () => {
		const outdir = tempDir();
		const result = await build({ outdir, store: true });
		expect(result.id).toBeUndefined();
		expect(result.manifest["key"]).toBeUndefined();
		const target = join(tempDir(), "x.zip");
		await zipBuild(outdir, target);
		const files = await readZip(
			new Uint8Array(await Bun.file(target).arrayBuffer()),
		);
		expect(files.has("manifest.json")).toBe(true);
		expect(files.has("content.js")).toBe(true);
		expect([...files.keys()].some((n) => n.endsWith(".map"))).toBe(false);
	});
});

describe("checkOutdir", () => {
	const root = join(import.meta.dir, "..");

	test("refuses the repository and its parents", async () => {
		await expect(checkOutdir(root)).rejects.toThrow("holds the repository");
		await expect(checkOutdir(dirname(root))).rejects.toThrow(
			"holds the repository",
		);
		await expect(checkOutdir(`${root}/.`)).rejects.toThrow(
			"holds the repository",
		);
	});

	test("refuses a folder with other files", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "notes.txt"), "keep me");
		await expect(checkOutdir(dir)).rejects.toThrow("not a build");
		await expect(build({ outdir: dir })).rejects.toThrow("not a build");
		expect(await Bun.file(join(dir, "notes.txt")).text()).toBe("keep me");
	});

	test("refuses a file in place of the folder, and keeps it", async () => {
		const dir = tempDir();
		const file = join(dir, "manifest-key.txt");
		writeFileSync(file, "keep me");
		await expect(checkOutdir(file)).rejects.toThrow("it is a file");
		await expect(build({ outdir: file })).rejects.toThrow("it is a file");
		expect(await Bun.file(file).text()).toBe("keep me");
	});

	test("accepts a missing or empty folder and an earlier build", async () => {
		const dir = tempDir();
		await checkOutdir(dir);
		await checkOutdir(join(dir, "missing"));
		mkdirSync(join(dir, "old"));
		writeFileSync(join(dir, "old", "manifest.json"), "{}");
		writeFileSync(join(dir, "old", "content.js"), "");
		await checkOutdir(join(dir, "old"));
	});
});

/** The decoded scanlines of a PNG: IHDR plus the inflated IDAT data. */
function pngPixels(png: Uint8Array): { header: number[]; data: Buffer } {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const idat: Uint8Array[] = [];
	let header: number[] = [];
	for (let at = 8; at < png.length; ) {
		const length = view.getUint32(at);
		const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
		const data = png.subarray(at + 8, at + 8 + length);
		if (type === "IHDR") header = [...data];
		if (type === "IDAT") idat.push(data);
		at += 12 + length;
	}
	return { header, data: inflateSync(Buffer.concat(idat)) };
}

describe("icons", () => {
	test("are PNGs of the right size and match the committed ones", async () => {
		for (const size of [16, 128]) {
			const png = drawIcon(size);
			expect([...png.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
			const view = new DataView(png.buffer);
			expect(view.getUint32(16)).toBe(size);
			const committed = new Uint8Array(
				await Bun.file(
					join(import.meta.dir, `../assets/icons/icon-${size}.png`),
				).arrayBuffer(),
			);
			// Compare pixels, not bytes: another zlib may deflate them differently.
			expect(pngPixels(committed)).toEqual(pngPixels(png));
		}
	});
});
