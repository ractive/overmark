/**
 * Builds the unpacked extension into `dist/` (or `--outdir`).
 *
 *   bun scripts/build.ts            development build with the fixed key (DEC-006)
 *   bun scripts/build.ts --store    no `key`, for the Chrome Web Store
 *   bun scripts/build.ts --test     grants `<all_urls>` and `downloads` at install, for the end-to-end tests
 *   bun scripts/build.ts --zip      also packs overmark-<version>.zip
 */

import { readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { CONTENT_SCRIPT } from "../src/lib/messages.ts";
import { writeZip } from "../src/lib/zip.ts";
import { ICON_SIZES } from "./icons.ts";

const ROOT = join(import.meta.dir, "..");

export interface BuildOptions {
	outdir?: string;
	/** Leave out `key` (Chrome Web Store upload). */
	store?: boolean;
	/**
	 * Grant `<all_urls>` and `downloads` at install, so tests need no click on
	 * the icon and no answer to Chrome's prompt (DEC-020).
	 */
	test?: boolean;
	minify?: boolean;
}

export interface BuildResult {
	outdir: string;
	manifest: Record<string, unknown>;
	/** The extension ID the key gives; `undefined` for a store build. */
	id: string | undefined;
}

/** The extension ID Chrome derives from a public key (base64 DER). */
export function extensionId(base64Key: string): string {
	const der = Buffer.from(base64Key, "base64");
	const hex = new Bun.CryptoHasher("sha256").update(der).digest("hex");
	return [...hex.slice(0, 32)]
		.map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
		.join("");
}

export async function readKey(): Promise<string> {
	return (await Bun.file(join(ROOT, "manifest-key.txt")).text()).trim();
}

/** The licences of all that a build contains, in the build and so in its zips. */
export const NOTICES_FILE = "LICENSES.txt";

const CLIENT = "node_modules/@ractive-ch/tab-mcp-client";

/**
 * Where each bundled package's licence is, from the repository's root.
 * `@cfworker/json-schema` publishes none; tab-mcp-client passes on its notice.
 */
const LICENCES: Readonly<Record<string, string>> = {
	"@cfworker/json-schema": `${CLIENT}/THIRD-PARTY-NOTICES.txt`,
	"@ractive-ch/tab-mcp-client": `${CLIENT}/LICENSE`,
};

/** The licence in a package's notice file; one without an MIT text stops the build. */
export function mitText(name: string, file: string): string {
	const start = file.indexOf("MIT License");
	if (start < 0) throw new Error(`no MIT licence text for ${name}`);
	return file.slice(start);
}

/** Overmark's licence and those of `packages`; a package without one stops the build. */
export async function notices(packages: Iterable<string>): Promise<string> {
	const text = (path: string) => Bun.file(join(ROOT, path)).text();
	const parts = [
		`Overmark\n\n${await text("LICENSE")}\n${await text("AI_NOTICE")}`,
	];
	for (const name of [...packages].sort()) {
		const path = LICENCES[name];
		if (path === undefined)
			throw new Error(`no licence known for the bundled package ${name}`);
		parts.push(`${name}\n\n${mitText(name, await text(path))}`);
	}
	return parts.join(`\n${"-".repeat(78)}\n\n`);
}

export function createManifest(
	version: string,
	options: { key?: string; test?: boolean },
): Record<string, unknown> {
	const icons = Object.fromEntries(
		ICON_SIZES.map((s) => [String(s), `icons/icon-${s}.png`]),
	);
	return {
		manifest_version: 3,
		name: "Overmark",
		version,
		description:
			"Mark what is wrong on a web page, open the marks in another environment to fix it, and talk them through with your AI app.",
		minimum_chrome_version: "116",
		icons,
		action: { default_title: "Overmark", default_icon: icons },
		background: { service_worker: "background.js", type: "module" },
		side_panel: { default_path: "sidepanel/index.html" },
		permissions: [
			"activeTab",
			"alarms",
			"notifications",
			// The sync to Downloads makes its blob URLs there (DEC-025).
			"offscreen",
			"scripting",
			"sidePanel",
			"storage",
			"unlimitedStorage",
			...(options.test ? ["downloads"] : []),
		],
		// Export asks for it, to say where the file went (DEC-020), and the
		// sync to Downloads writes through it (DEC-025).
		...(options.test ? {} : { optional_permissions: ["downloads"] }),
		optional_host_permissions: ["<all_urls>"],
		...(options.test ? { host_permissions: ["<all_urls>"] } : {}),
		commands: {
			_execute_action: {
				suggested_key: { default: "Alt+Shift+O" },
				description: "Open Overmark on this tab",
			},
		},
		...(options.key ? { key: options.key } : {}),
	};
}

async function bundle(
	entrypoint: string,
	outdir: string,
	format: "esm" | "iife",
	minify: boolean,
	naming?: string,
	test = false,
): Promise<string[]> {
	const result = await Bun.build({
		entrypoints: [join(ROOT, entrypoint)],
		outdir,
		target: "browser",
		format,
		...(naming ? { naming } : {}),
		// Always defined: left to run time, an element with that id on the page
		// would answer for it and open the overlay's shadow root.
		define: { OVERMARK_TEST_BUILD: test ? "true" : "false" },
		minify,
		splitting: format === "esm" && entrypoint.endsWith(".html"),
		sourcemap: "linked",
		metafile: true,
	});
	if (!result.success) {
		throw new AggregateError(result.logs, `build of ${entrypoint} failed`);
	}
	return Object.keys(result.metafile?.inputs ?? {}).flatMap(
		(path) => /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1] ?? [],
	);
}

/**
 * Refuse to empty a directory that is not a build: the repository, one of its
 * parents, or a folder with other files in it and no `manifest.json`.
 */
export async function checkOutdir(outdir: string): Promise<void> {
	const target = resolve(outdir);
	if (`${ROOT}${sep}`.startsWith(`${target}${sep}`))
		throw new Error(`refusing to empty ${target}: it holds the repository`);
	let names: string[];
	try {
		names = await readdir(target);
	} catch (error) {
		// Only a folder that does not exist yet is fine; a file there (ENOTDIR)
		// or one we may not read must not be deleted.
		if ((error as { code?: string }).code === "ENOENT") return;
		throw new Error(
			`refusing to use ${target}: ${(error as { code?: string }).code === "ENOTDIR" ? "it is a file" : String(error)}`,
		);
	}
	if (names.length > 0 && !names.includes("manifest.json"))
		throw new Error(
			`refusing to empty ${target}: not empty and not a build (no manifest.json)`,
		);
}

export async function build(options: BuildOptions = {}): Promise<BuildResult> {
	const outdir = resolve(options.outdir ?? join(ROOT, "dist"));
	await checkOutdir(outdir);
	const minify = options.minify ?? true;
	const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as {
		version: string;
	};
	await rm(outdir, { recursive: true, force: true });
	const packages = new Set([
		...(await bundle(
			"src/background.ts",
			outdir,
			"esm",
			minify,
			undefined,
			options.test,
		)),
		...(await bundle(
			"src/content/index.ts",
			outdir,
			"iife",
			minify,
			CONTENT_SCRIPT,
			options.test,
		)),
		...(await bundle(
			"src/sidepanel/index.html",
			join(outdir, "sidepanel"),
			"esm",
			minify,
			undefined,
			options.test,
		)),
		// The sync to Downloads' blob URLs (DEC-025).
		...(await bundle(
			"src/offscreen/index.html",
			join(outdir, "offscreen"),
			"esm",
			minify,
		)),
	]);
	await Bun.write(join(outdir, NOTICES_FILE), await notices(packages));
	for (const size of ICON_SIZES) {
		const name = `icon-${size}.png`;
		await Bun.write(
			join(outdir, "icons", name),
			Bun.file(join(ROOT, "assets/icons", name)),
		);
	}
	const key = options.store ? undefined : await readKey();
	const manifest = createManifest(pkg.version, {
		...(key ? { key } : {}),
		...(options.test ? { test: true } : {}),
	});
	await Bun.write(
		join(outdir, "manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	return { outdir, manifest, id: key ? extensionId(key) : undefined };
}

async function filesOf(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	return entries
		.filter((e) => e.isFile())
		.map((e) => relative(dir, join(e.parentPath, e.name)))
		.filter((p) => !p.endsWith(".map"))
		.sort();
}

/** Pack a build into a zip for "Load unpacked" or the store. */
export async function zipBuild(outdir: string, target: string): Promise<void> {
	const entries = [];
	for (const name of await filesOf(outdir)) {
		entries.push({
			name: name.split("\\").join("/"),
			data: new Uint8Array(await Bun.file(join(outdir, name)).arrayBuffer()),
		});
	}
	await Bun.write(target, await writeZip(entries));
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			store: { type: "boolean" },
			test: { type: "boolean" },
			zip: { type: "boolean" },
			outdir: { type: "string" },
		},
	});
	const result = await build({
		...(values.outdir ? { outdir: values.outdir } : {}),
		...(values.store ? { store: true } : {}),
		...(values.test ? { test: true } : {}),
	});
	console.log(
		`Built ${relative(process.cwd(), result.outdir) || "."}${result.id ? ` (extension ID ${result.id})` : " (no key: store build)"}`,
	);
	if (values.zip) {
		const target = join(
			ROOT,
			`overmark-${result.manifest["version"]}${values.store ? "-store" : ""}.zip`,
		);
		await zipBuild(result.outdir, target);
		console.log(`Packed ${relative(process.cwd(), target)}`);
	}
}
