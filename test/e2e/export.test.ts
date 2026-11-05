/**
 * A case through the side panel's own buttons and file input: exported,
 * imported with both answers to the prompt, deleted, with the database read
 * after each step. And what a worker that starts again cleans up.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZip } from "../../src/lib/zip.ts";
import { browserBinary, type Harness, startHarness } from "./harness.ts";
import {
	type Db,
	exportOpenCase,
	imageBytes,
	imagesOf,
	importFile,
	markElement,
	openCase,
	panelHome,
	READ_DB,
	restartWorker,
	saveAs,
	showToolbar,
	until,
} from "./steps.ts";

/** Run `body` (an expression using `tx`) in a transaction on the extension's database. */
const write = (body: string) => `new Promise((resolve, reject) => {
	const open = indexedDB.open("overmark");
	open.onerror = () => reject(open.error);
	open.onsuccess = () => {
		const tx = open.result.transaction(["cases", "images"], "readwrite");
		tx.oncomplete = () => resolve(true);
		tx.onerror = () => reject(tx.error);
		${body};
	};
})`;

const putImage = (key: string, storedAt?: number) =>
	`tx.objectStore("images").put({ blob: new Blob(["x"], { type: "image/webp" }), width: 1, height: 1${storedAt === undefined ? "" : `, storedAt: ${storedAt}`} }, ${JSON.stringify(key)})`;

describe.skipIf(browserBinary === undefined)(
	"a case's way out and back",
	() => {
		let h: Harness;
		let folder: string;

		const readDb = () => h.control.eval<Db>(READ_DB);

		beforeAll(async () => {
			h = await startHarness(browserBinary as string);
			folder = mkdtempSync(join(tmpdir(), "overmark-export-"));
		}, 60_000);

		afterAll(async () => {
			await h?.stop();
			rmSync(folder, { recursive: true, force: true });
		});

		test("exported, imported with Keep both and with Replace, then deleted", async () => {
			const { page, tabId } = await h.open("v1");
			await showToolbar(h, page, tabId);
			await markElement(page, "[data-truth=submit]", "Too pale");
			await markElement(page, "[data-truth=tip]", "Say how much");
			await saveAs(page, "Round trip");
			await page.send("Page.close");

			const saved = (await readDb()).cases[0];
			if (saved === undefined) throw new Error("not saved");
			const paths = imagesOf(await readDb(), saved.id);
			expect(paths).toContain("crops/a1.webp");
			expect(paths).toContain("crops/a2.webp");
			expect(paths).toContain("shots/s1.webp");

			// Export: the file holds the case and the stored images, byte for byte.
			const panel = await panelHome(h);
			await openCase(panel, "Round trip");
			const file = await exportOpenCase(h, panel, folder);
			expect(file.endsWith("round-trip.overmark.zip")).toBe(true);
			const zip = await readZip(
				new Uint8Array(await Bun.file(file).arrayBuffer()),
			);
			expect([...zip.keys()].sort()).toEqual(
				["case.json", "case.md", ...paths].sort(),
			);
			const exported = JSON.parse(
				new TextDecoder().decode(zip.get("case.json")),
			);
			expect(exported.id).toBe(saved.id);
			const bytes = (path: string) =>
				Buffer.from(zip.get(path) ?? []).toString("base64");
			for (const path of paths)
				expect((await imageBytes(h.control, "Round trip", path)).base64).toBe(
					bytes(path),
				);

			// The case is here already, so the panel asks. Keep both: a copy with its images.
			await panelHome(h);
			await importFile(panel, file);
			await panel.waitFor(
				`document.querySelector('[data-action="import-copy"]')`,
			);
			expect(
				await panel.eval<boolean>(
					`document.getElementById("import-prompt").hidden`,
				),
			).toBe(false);
			await panel.click(
				`document.querySelector('[data-action="import-copy"]')`,
			);
			const both = await until(readDb, (db) => db.cases.length === 2);
			const copy = both.cases.find((c) => c.id !== saved.id);
			if (copy === undefined) throw new Error("no copy");
			expect(copy.title).toBe("Round trip (copy)");
			expect(copy.annotations.map((a) => a.comment)).toEqual([
				"Too pale",
				"Say how much",
			]);
			expect(imagesOf(both, copy.id)).toEqual(paths);
			expect(imagesOf(both, saved.id)).toEqual(paths);
			for (const path of paths)
				expect(
					(await imageBytes(h.control, "Round trip (copy)", path)).base64,
				).toBe(bytes(path));

			// Replace: everything the case became since the export is gone.
			await h.control.eval(
				write(`
				tx.objectStore("cases").put({ ...${JSON.stringify(saved)}, title: "Changed since" });
				${putImage(`${saved.id}/crops/a9.webp`)};
				${putImage(`${saved.id}/shots/s1.webp`)};
			`),
			);
			await panelHome(h);
			await importFile(panel, file);
			await panel.waitFor(
				`document.querySelector('[data-action="import-replace"]')`,
			);
			await panel.click(
				`document.querySelector('[data-action="import-replace"]')`,
			);
			const replaced = await until(readDb, (db) =>
				db.cases.some((c) => c.title === "Round trip"),
			);
			expect(replaced.cases).toHaveLength(2);
			expect(imagesOf(replaced, saved.id)).toEqual(paths);
			for (const path of paths)
				expect((await imageBytes(h.control, "Round trip", path)).base64).toBe(
					bytes(path),
				);
			expect(imagesOf(replaced, copy.id)).toEqual(paths);

			// Delete: its screenshots go with it, and the copy's stay.
			await panel.waitFor(`document.getElementById("delete-case")`);
			await panel.click(`document.getElementById("delete-case")`);
			await panel.waitFor(
				`document.getElementById("delete-case")?.textContent === "Really delete?"`,
			);
			await Bun.sleep(600); // a confirming click this soon counts as a double-click
			await panel.click(`document.getElementById("delete-case")`);
			const left = await until(readDb, (db) => db.cases.length === 1);
			expect(left.cases[0]?.id).toBe(copy.id);
			expect(imagesOf(left, saved.id)).toEqual([]);
			expect(imagesOf(left, copy.id)).toEqual(paths);
			expect(left.images).toHaveLength(paths.length);
		}, 60_000);

		test("an imported file the panel cannot read changes nothing", async () => {
			const before = await readDb();
			const bad = join(folder, "not-a-case.overmark.zip");
			await Bun.write(bad, "not a zip");
			const panel = await panelHome(h);
			await importFile(panel, bad);
			await panel.waitFor(
				`document.getElementById("import-error-text")?.textContent.startsWith("Could not import")`,
			);
			expect(await readDb()).toEqual(before);
		}, 30_000);

		test("a worker that starts again sweeps abandoned screenshots, and nothing else", async () => {
			const old = "c_gone/pending/p_old.webp";
			const undated = "c_gone/pending/p_undated.webp";
			const recent = "c_gone/pending/p_recent.webp";
			const finished = "c_gone/shots/s1.webp";
			await h.control.eval(
				write(`
				${putImage(old, 1000)};
				${putImage(undated)};
				${putImage(recent, Date.now())};
				${putImage(finished)};
			`),
			);
			const keys = (db: Db) => db.images.map((i) => i.key);
			expect(keys(await readDb())).toContain(old);

			await restartWorker(h);

			const swept = await until(readDb, (db) => !keys(db).includes(old));
			expect(keys(swept)).not.toContain(undated);
			expect(keys(swept)).toContain(recent);
			expect(keys(swept)).toContain(finished);
		}, 30_000);
	},
);
