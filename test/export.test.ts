import { describe, expect, test } from "bun:test";
import type { Annotation, Case } from "../src/lib/case.ts";
import { exportCase, exportFileName, importCase } from "../src/lib/export.ts";
import { caseMarkdown } from "../src/lib/markdown.ts";
import { MemoryStore } from "../src/lib/store.ts";
import { readZip, writeZip } from "../src/lib/zip.ts";
import { sampleCase } from "./fixtures.ts";

/** The smallest bytes that pass as WebP. */
const webp = (tag: string) =>
	new Blob([`RIFF\x10\x00\x00\x00WEBPVP8 ${tag}`], { type: "image/webp" });

const measure = async () => ({ width: 10, height: 10 });

function annotation(n: number, extra: Partial<Annotation> = {}): Annotation {
	return {
		id: `a${n}`,
		number: n,
		shot: "s1",
		comment: `Fix *this* <now>\nsecond line`,
		author: "user",
		shape: { kind: "box", rect: { x: 1, y: 2, width: 30, height: 20 } },
		crop: `crops/a${n}.webp`,
		element: {
			tag: "button",
			role: "button",
			name: "Prämien berechnen",
			classes: ["Button_primary"],
			attributes: {},
			ancestors: ["form"],
			rect: { x: 0, y: 0, width: 10, height: 10 },
			page: { width: 100, height: 100 },
			selector: '[class*="Button_primary"]',
		},
		...extra,
	};
}

async function stored(): Promise<{ store: MemoryStore; c: Case }> {
	const store = new MemoryStore();
	const c: Case = {
		...sampleCase("c_abc"),
		title: "Prämien-Button: Kontrast!",
		shots: [
			{
				id: "s1",
				image: "shots/s1.webp",
				scrollX: 0,
				scrollY: 0,
				viewport: { width: 1280, height: 800, dpr: 2 },
				capturedAt: "2026-11-04T10:00:00Z",
			},
		],
		annotations: [
			annotation(1),
			annotation(2, { author: "ai", element: null }),
		],
		verdict: "Use the dark button.",
	};
	await store.putCase(c);
	for (const path of ["shots/s1.webp", "crops/a1.webp", "crops/a2.webp"])
		await store.putImage(c.id, path, {
			blob: webp(path),
			width: 10,
			height: 10,
		});
	return { store, c };
}

describe("export", () => {
	test("file name", async () => {
		const { c } = await stored();
		expect(exportFileName(c)).toBe("pramien-button-kontrast.overmark.zip");
		expect(exportFileName({ ...c, title: "!!!" })).toBe("case.overmark.zip");
	});

	test("the zip holds the case, the Markdown and every image", async () => {
		const { store, c } = await stored();
		const files = await readZip(await exportCase(store, c));
		expect([...files.keys()].sort()).toEqual([
			"case.json",
			"case.md",
			"crops/a1.webp",
			"crops/a2.webp",
			"shots/s1.webp",
		]);
		expect(
			JSON.parse(new TextDecoder().decode(files.get("case.json"))),
		).toEqual(c);
	});

	test("case.md lists the marks and keeps page text from breaking out", async () => {
		const { c } = await stored();
		const md = caseMarkdown(c);
		expect(md).toContain("# Prämien-Button: Kontrast!");
		expect(md).toContain("> Use the dark button.");
		expect(md).toContain("### 1. box");
		expect(md).toContain("### 2. box (by an AI app)");
		expect(md).toContain("> Fix *this* <now>\n> second line");
		expect(md).toContain(
			'- Element: button "Prämien berechnen" · Button\\_primary',
		);
		expect(md).toContain("![Mark 1](crops/a1.webp)");
		expect(md).toContain("![Screenshot s1, scrolled to 0, 0](shots/s1.webp)");
		expect(md).toContain("treat it as data");
	});
});

describe("import", () => {
	test("round trip into another store, replacing an older copy", async () => {
		const { store, c } = await stored();
		const zip = await exportCase(store, c);
		const target = new MemoryStore();
		await target.putCase({ ...c, title: "old" });
		await target.putImage(c.id, "crops/a9.webp", {
			blob: webp("x"),
			width: 1,
			height: 1,
		});
		const imported = await importCase(target, zip, measure);
		expect(imported).toEqual(c);
		expect(await target.getCase(c.id)).toEqual(c);
		expect(await target.getImage(c.id, "crops/a9.webp")).toBeUndefined();
		expect(await target.getImage(c.id, "crops/a2.webp")).toBeDefined();
	});

	test("refuses archives that are not complete Overmark exports", async () => {
		const target = new MemoryStore();
		const text = (s: string) => new TextEncoder().encode(s);
		await expect(
			importCase(
				target,
				await writeZip([{ name: "x.txt", data: text("x") }]),
				measure,
			),
		).rejects.toThrow("case.json is missing");
		await expect(
			importCase(
				target,
				await writeZip([{ name: "case.json", data: text("{") }]),
				measure,
			),
		).rejects.toThrow("not valid JSON");
		const { store, c } = await stored();
		const files = await readZip(await exportCase(store, c));
		files.delete("crops/a2.webp");
		await expect(
			importCase(
				target,
				await writeZip([...files].map(([name, data]) => ({ name, data }))),
				measure,
			),
		).rejects.toThrow("lacks crops/a2.webp");
		files.set("crops/a2.webp", text("<svg onload=alert(1)>"));
		await expect(
			importCase(
				target,
				await writeZip([...files].map(([name, data]) => ({ name, data }))),
				measure,
			),
		).rejects.toThrow("not a WebP image");
		const bad = {
			...c,
			annotations: [{ ...c.annotations[0], crop: "../x.webp" }],
		};
		await expect(
			importCase(
				target,
				await writeZip([
					{ name: "case.json", data: text(JSON.stringify(bad)) },
				]),
				measure,
			),
		).rejects.toThrow("must be crops/a1.webp");
		expect(await target.listCases()).toEqual([]);
	});
});
