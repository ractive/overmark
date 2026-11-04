import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	build,
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
			expect(Buffer.from(committed).equals(Buffer.from(png))).toBe(true);
		}
	});
});
