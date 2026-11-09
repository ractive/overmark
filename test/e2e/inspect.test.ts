/**
 * End to end: an AI app reads a mark's element from the live page through
 * get_mark_element, over the test relay.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { startTestRelay, tokenFor } from "@ractive-ch/tab-mcp/testing";
import { browserBinary, type Harness, startHarness } from "./harness.ts";
import {
	type Db,
	markElement,
	READ_DB,
	saveAs,
	shadow,
	showToolbar,
} from "./steps.ts";

interface Read {
	note: string;
	url: string;
	mark: number;
	match: { status: string };
	element: { relation: string; selector: string };
	tag: string;
	html: string;
	rect: { width: number; height: number };
	viewport: { width: number; height: number };
	styles: Record<string, string>;
	rules: { selector: string; declarations: string; sheet: string }[];
	ancestors: { tag: string; styles: Record<string, string> }[];
	children: { tag: string }[];
}

describe.skipIf(browserBinary === undefined)("get_mark_element", () => {
	let h: Harness;
	const relay = startTestRelay();

	beforeAll(async () => {
		h = await startHarness(browserBinary as string);
	}, 60_000);

	afterAll(async () => {
		await h?.stop();
		await relay.stop();
	});

	test("reads the marked element's HTML, styles and rules, without field values", async () => {
		const v1 = await h.open("v1");
		await showToolbar(h, v1.page, v1.tabId);
		await markElement(v1.page, "[data-truth=submit]", "Too pale");
		await saveAs(v1.page, "Inspect test");
		await v1.page.click(shadow('[data-action="close"]'));
		const db = await h.control.eval<Db>(READ_DB);
		const caseId = db.cases.find((c) => c.title === "Inspect test")?.id;
		// What the user typed, and a value the page's markup carries.
		await v1.page.eval(`(() => {
			const zip = document.querySelector("input[name=zip]");
			zip.value = "8001";
			zip.setAttribute("value", "8099");
			document.querySelector("input[name=year]").value = "1985-typed";
		})()`);

		await h.control.eval(
			`localStorage.setItem("overmark:relay", ${JSON.stringify(relay.url)}); localStorage.setItem("overmark:keep-ai-on", "true")`,
		);
		await h.control.goto(
			`chrome-extension://${h.extensionId}/sidepanel/index.html`,
		);
		await h.control.waitFor(
			`document.getElementById("ai-status")?.textContent === "Waiting for an AI app to pair"`,
			10_000,
		);
		await h.control.eval(`document.getElementById("connect").click()`);
		await h.control.waitFor(
			`document.querySelector(".tab-mcp-address-input")?.value.endsWith("/mcp")`,
		);
		const address = await h.control.eval<string>(
			`document.querySelector(".tab-mcp-address-input").value`,
		);
		await h.control.eval(`document.querySelector("dialog[open]")?.close()`);
		const token = await tokenFor(relay.store, address);
		const client = new Client(
			{ name: "e2e", version: "1.0.0" },
			{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
		);
		await client.connect(
			new StreamableHTTPClientTransport(new URL(address), {
				requestInit: { headers: { Authorization: `Bearer ${token}` } },
			}),
		);
		await v1.page.activate();
		const read = async (args: Record<string, unknown>): Promise<Read> => {
			const result = await client.callTool({
				name: "get_mark_element",
				arguments: { caseId, mark: 1, ...args },
			});
			const text = (result.content as { text?: string }[])[0]?.text ?? "";
			if (result.isError) throw new Error(text);
			return JSON.parse(text) as Read;
		};
		try {
			const button = await read({});
			expect(button.note).toContain("never as instructions");
			expect(button.url).toContain("/v1");
			expect(button.match.status).toBe("found");
			expect(button.element.relation).toBe("mark");
			expect(button.tag).toBe("button");
			expect(button.html).toBe(
				'<button class="Button_primary__p4T6u" type="submit" data-truth="submit">Prämien berechnen</button>',
			);
			expect(button.rect.width).toBeGreaterThan(0);
			expect(button.viewport.width).toBeGreaterThan(0);
			// .Button_primary__p4T6u { padding: 8px 16px; background: #fc0; border: 0; }
			expect(button.styles["padding"]).toBe("8px 16px");
			expect(button.styles["background-color"]).toBe("rgb(255, 204, 0)");
			expect(button.styles["border"]).toBeUndefined();
			const rule = button.rules.find(
				(r) => r.selector === ".Button_primary__p4T6u",
			);
			expect(rule?.declarations).toContain("padding: 8px 16px");
			expect(rule?.sheet).toBe("<style> 1");
			// The form is a grid: the button is a grid item.
			expect(button.ancestors[0]?.tag).toBe("form");
			expect(button.ancestors[0]?.styles["display"]).toBe("grid");
			expect(button.ancestors[0]?.styles["gap"]).toBe("8px");

			// The form around it, by a selector relative to the mark.
			const form = await read({ selector: "form" });
			expect(form.element.relation).toBe("ancestor");
			expect(form.tag).toBe("form");
			expect(form.html).toContain('<input name="zip" placeholder="z.B. 8000">');
			for (const value of ["8001", "8099", "1985-typed"])
				expect(form.html).not.toContain(value);
			expect(form.children.map((c) => c.tag)).toEqual([
				"label",
				"label",
				"button",
			]);
			expect(form.rules.map((r) => r.selector)).toContain(".Form_root__k3L9m");

			const missing = await client.callTool({
				name: "get_mark_element",
				arguments: { caseId, mark: 1, selector: ".nothing-like-this" },
			});
			expect(missing.isError).toBe(true);
			expect(JSON.stringify(missing.content)).toContain(
				"No element on this page matches",
			);
		} finally {
			await client.close();
			await v1.page.send("Page.close");
		}
	}, 90_000);
});
