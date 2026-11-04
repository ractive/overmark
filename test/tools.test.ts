import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { startTestRelay, tokenFor } from "@ractive-ch/tab-mcp/testing";
import { TabMcp, type Tool } from "@ractive-ch/tab-mcp-client";
import type { Annotation, Case, ElementDetails } from "../src/lib/case.ts";
import type {
	AnnotationMatch,
	ContentRequest,
	DescribedElement,
} from "../src/lib/messages.ts";
import { MemoryStore } from "../src/lib/store.ts";
import {
	createTools,
	type ImageTools,
	INSTRUCTIONS,
	type TabBridge,
} from "../src/sidepanel/tools.ts";
import { sampleCase } from "./fixtures.ts";

const element: ElementDetails = {
	tag: "button",
	role: "button",
	name: "Prämien berechnen",
	classes: ["Button_primary"],
	attributes: { type: "submit" },
	ancestors: ["form"],
	rect: { x: 10, y: 10, width: 100, height: 30 },
	page: { width: 1280, height: 2000 },
	selector: '[class*="Button_primary"]',
};

const mark = (n: number): Annotation => ({
	id: `a${n}`,
	number: n,
	shot: "s1",
	comment: `Comment ${n}`,
	author: "user",
	shape: { kind: "box", rect: { x: 5, y: 5, width: 120, height: 40 } },
	crop: `crops/a${n}.webp`,
	element,
});

function webp(size: number): Blob {
	return new Blob([new Uint8Array(size)], { type: "image/webp" });
}

class FakeTab implements TabBridge {
	sent: ContentRequest[] = [];
	loaded: string | undefined;
	captureFails = false;
	async current() {
		return { id: 7, windowId: 1, url: "http://localhost:3000/kk", title: "KK" };
	}
	async send<T>(_tabId: number, request: ContentRequest): Promise<T> {
		this.sent.push(request);
		const match: AnnotationMatch = {
			annotationId: "a1",
			number: 1,
			status: "found",
			score: 0.91,
			current: 0,
			candidates: [
				{
					score: 0.91,
					summary: "button",
					selector: "form > button",
					visible: true,
				},
			],
		};
		switch (request.type) {
			case "case:load":
				this.loaded = request.case.id;
				return {
					caseId: request.case.id,
					url: "http://localhost:3000/kk",
					matches: request.case.annotations.map((a) => ({
						...match,
						annotationId: a.id,
						number: a.number,
					})),
				} as T;
			case "overlay:state":
				return { loadedCase: this.loaded } as T;
			case "case:show":
				return { ...match, current: request.candidate ?? 0 } as T;
			case "element:mark":
				return (request.selector === "#missing"
					? { ok: false, error: "No element on this page matches #missing" }
					: {
							ok: true,
							details: { ...element, name: "Jetzt berechnen" },
							rect: { x: 100, y: 200, width: 150, height: 40 },
							viewport: { width: 1280, height: 800, dpr: 2 },
							scroll: { x: 0, y: 300 },
							url: "http://localhost:3000/kk",
							title: "KK",
						}) satisfies DescribedElement as T;
			default:
				return {} as T;
		}
	}
	async capture() {
		if (this.captureFails) throw new Error("no access");
		return new Blob(["png"], { type: "image/png" });
	}
}

let cropSize = 1000;
const images: ImageTools = {
	toWebp: async () => ({ blob: webp(5000), width: 2560, height: 1600 }),
	scale: async (_blob, maxSide) => ({
		blob: webp(cropSize),
		width: maxSide,
		height: 10,
	}),
	crop: async () => ({ blob: webp(800), width: 300, height: 80 }),
};

let store: MemoryStore;
let tab: FakeTab;
let changed: string[];
let tools: Map<string, Tool>;

async function seed(): Promise<Case> {
	const c: Case = {
		...sampleCase("c_1"),
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
		annotations: [mark(1), mark(2)],
	};
	await store.putCase(c);
	for (const path of ["shots/s1.webp", "crops/a1.webp", "crops/a2.webp"])
		await store.putImage(c.id, path, {
			blob: webp(100),
			width: 10,
			height: 10,
		});
	return c;
}

type Result = { content: { type: string; text?: string; data?: string }[] };

async function call(
	name: string,
	input: Record<string, unknown> = {},
): Promise<Result> {
	const tool = tools.get(name);
	if (tool === undefined) throw new Error(`no tool ${name}`);
	const signal = new AbortController().signal;
	return (await tool.execute(input, {
		signal,
		client: { grantId: "g", id: "https://claude.ai/oauth", host: "claude.ai" },
	})) as Result;
}

const json = (r: Result, i = 0) => JSON.parse(r.content[i]?.text ?? "null");

beforeEach(() => {
	store = new MemoryStore();
	tab = new FakeTab();
	changed = [];
	cropSize = 1000;
	tools = new Map(
		createTools({
			store,
			tab,
			images,
			onChange: (id) => changed.push(id),
			settle: async () => {},
		}).map((t) => [t.name, t]),
	);
});

describe("tools", () => {
	test("list_cases and get_case", async () => {
		await seed();
		expect(json(await call("list_cases"))).toEqual([
			{
				caseId: "c_1",
				title: "Button contrast",
				url: "https://www.example.com/kk",
				marks: 2,
				verdict: null,
				updatedAt: "2026-11-04T10:00:00Z",
			},
		]);
		const result = await call("get_case", { caseId: "c_1" });
		const view = json(result);
		expect(view.marks.map((m: { mark: number }) => m.mark)).toEqual([1, 2]);
		expect(view.marks[0].element.name).toBe("Prämien berechnen");
		expect(result.content.map((c) => c.type)).toEqual([
			"text",
			"text",
			"image",
			"text",
			"image",
		]);
		const noImages = await call("get_case", { caseId: "c_1", images: false });
		expect(noImages.content).toHaveLength(1);
	});

	test("get_case leaves out crops beyond the size budget", async () => {
		await seed();
		cropSize = 400_000; // ~533 000 base64 characters each
		const result = await call("get_case", { caseId: "c_1" });
		expect(result.content.filter((c) => c.type === "image")).toHaveLength(1);
		expect(result.content.at(-1)?.text).toContain("crops/a2.webp");
	});

	test("unknown cases and images are errors", async () => {
		await expect(call("get_case", { caseId: "c_9" })).rejects.toThrow(
			"No case with id c_9",
		);
		await seed();
		await expect(
			call("get_image", { caseId: "c_1", path: "crops/a9.webp" }),
		).rejects.toThrow("no image crops/a9.webp");
		const image = await call("get_image", {
			caseId: "c_1",
			path: "shots/s1.webp",
		});
		expect(image.content[1]?.type).toBe("image");
	});

	test("load_case and highlight", async () => {
		await seed();
		const loaded = json(await call("load_case", { caseId: "c_1" }));
		expect(loaded.marks[1]).toEqual({
			mark: 2,
			status: "found",
			score: 0.91,
			shownCandidate: 0,
			candidates: [
				{
					score: 0.91,
					summary: "button",
					selector: "form > button",
					visible: true,
				},
			],
		});
		tab.loaded = undefined;
		tab.sent = [];
		const shown = json(
			await call("highlight", { caseId: "c_1", mark: 1, candidate: 1 }),
		);
		expect(shown.shownCandidate).toBe(1);
		expect(tab.sent.map((r) => r.type)).toEqual([
			"overlay:state",
			"case:load",
			"case:show",
		]);
		await expect(call("highlight", { caseId: "c_1", mark: 5 })).rejects.toThrow(
			"no mark 5",
		);
	});

	test("capture returns the tab's screenshot", async () => {
		const result = await call("capture");
		expect(json(result)).toEqual({
			url: "http://localhost:3000/kk",
			title: "KK",
		});
		expect(result.content[1]?.type).toBe("image");
	});

	test("add_annotation adds an AI mark with its own screenshot", async () => {
		await seed();
		const result = await call("add_annotation", {
			caseId: "c_1",
			selector: "form button",
			comment: "  Fixed on localhost  ",
		});
		expect(result.content[0]?.text).toContain("Added mark 3");
		const c = await store.getCase("c_1");
		const added = c?.annotations.find((a) => a.number === 3);
		expect(added?.author).toBe("ai");
		expect(added?.comment).toBe("Fixed on localhost");
		expect(added?.shot).toBe("s2");
		expect(added?.element?.name).toBe("Jetzt berechnen");
		expect(added?.shape).toEqual({
			kind: "element",
			rect: { x: 100, y: 200, width: 150, height: 40 },
		});
		expect(c?.shots.map((s) => s.id)).toEqual(["s1", "s2"]);
		expect(await store.getImage("c_1", "crops/a3.webp")).toBeDefined();
		expect(await store.getImage("c_1", "shots/s2.webp")).toBeDefined();
		expect(tab.sent.at(-1)?.type).toBe("element:unmark");
		expect(changed).toEqual(["c_1"]);
	});

	test("add_annotation: a missing element, and a failed screenshot still unmarks", async () => {
		await seed();
		await expect(
			call("add_annotation", {
				caseId: "c_1",
				selector: "#missing",
				comment: "x",
			}),
		).rejects.toThrow("No element on this page matches #missing");
		tab.captureFails = true;
		await expect(
			call("add_annotation", {
				caseId: "c_1",
				selector: "button",
				comment: "x",
			}),
		).rejects.toThrow("no access");
		expect(tab.sent.at(-1)?.type).toBe("element:unmark");
		expect((await store.getCase("c_1"))?.annotations).toHaveLength(2);
	});

	test("set_verdict and delete_case", async () => {
		await seed();
		await call("set_verdict", { caseId: "c_1", verdict: " Darker button. " });
		expect((await store.getCase("c_1"))?.verdict).toBe("Darker button.");
		await call("set_verdict", { caseId: "c_1", verdict: "" });
		expect((await store.getCase("c_1"))?.verdict).toBeNull();
		await call("delete_case", { caseId: "c_1" });
		expect(await store.getCase("c_1")).toBeUndefined();
		expect(store.images.size).toBe(0);
		expect(changed).toEqual(["c_1", "c_1", "c_1"]);
	});

	test("hints: reading tools are read-only, changing ones ask first", () => {
		const hints = Object.fromEntries(
			[...tools.values()].map((t) => [t.name, t.annotations ?? {}]),
		);
		for (const name of [
			"list_cases",
			"get_case",
			"get_image",
			"load_case",
			"highlight",
			"capture",
		])
			expect(hints[name]?.readOnlyHint).toBe(true);
		for (const name of ["add_annotation", "set_verdict", "delete_case"])
			expect(hints[name]?.consequentialHint).toBe(true);
		expect(hints["delete_case"]?.destructiveHint).toBe(true);
		expect(hints["get_case"]?.untrustedContentHint).toBe(true);
	});
});

describe("through a relay", () => {
	const relay = startTestRelay();
	afterAll(() => relay.stop());

	test("an MCP client lists and calls the tools; inputs are checked", async () => {
		await seed();
		const confirmed: string[] = [];
		const mcp = new TabMcp({
			relay: relay.url,
			server: {
				name: "overmark",
				version: "0.1.0",
				instructions: INSTRUCTIONS,
			},
			storage: null,
			onConfirm: (request) => {
				confirmed.push(request.tool.name);
				return true;
			},
		});
		for (const tool of tools.values()) await mcp.registerTool(tool);
		const session = await mcp.connect();
		const token = await tokenFor(relay.store, session.address);
		const client = new Client(
			{ name: "test", version: "1.0.0" },
			{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
		);
		await client.connect(
			new StreamableHTTPClientTransport(new URL(session.address), {
				requestInit: { headers: { Authorization: `Bearer ${token}` } },
			}),
		);
		try {
			const listed = await client.listTools();
			expect(listed.tools.map((t) => t.name).sort()).toEqual([
				"add_annotation",
				"capture",
				"delete_case",
				"get_case",
				"get_image",
				"highlight",
				"list_cases",
				"load_case",
				"set_verdict",
			]);
			const cases = await client.callTool({
				name: "list_cases",
				arguments: {},
			});
			expect(JSON.stringify(cases.content)).toContain("c_1");
			const bad = await client.callTool({
				name: "get_image",
				arguments: { caseId: "c_1", path: "../../etc/passwd" },
			});
			expect(bad.isError).toBe(true);
			const verdict = await client.callTool({
				name: "set_verdict",
				arguments: { caseId: "c_1", verdict: "Ship it" },
			});
			expect(verdict.isError).toBeFalsy();
			expect(confirmed).toEqual(["set_verdict"]);
			expect((await store.getCase("c_1"))?.verdict).toBe("Ship it");
		} finally {
			await client.close();
			mcp.disconnect();
		}
	}, 20_000);
});
