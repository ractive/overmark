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
import { relayProblem } from "../src/sidepanel/mcp.ts";
import {
	type CurrentTab,
	confirmRequestFor,
	createTools,
	type ImageTools,
	INSTRUCTIONS,
	type TabBridge,
	type ToolDeps,
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
	/** The annotation ids of the loaded copy. */
	loadedIds = new Set<string>();
	loadError: string | undefined;
	captureFails = false;
	/** Runs during a capture, e.g. the user saving a mark meanwhile. */
	duringCapture: (() => Promise<void>) | undefined;
	captured: CurrentTab[] = [];
	/** The user's own save is taking screenshots. */
	saving = false;
	url = "http://localhost:3000/kk";
	async current() {
		return { id: 7, windowId: 1, url: this.url, title: "KK" };
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
				if (this.loadError !== undefined) return { error: this.loadError } as T;
				this.loaded = request.case.id;
				this.loadedIds = new Set(request.case.annotations.map((a) => a.id));
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
				return (
					request.caseId === this.loaded &&
					this.loadedIds.has(request.annotationId)
						? { ...match, current: request.candidate ?? 0 }
						: null
				) as T;
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
			case "page:blur":
				return (
					this.saving
						? {
								ok: false,
								error: "The user is saving marks on this page right now",
							}
						: { ok: true }
				) as T;
			default:
				return {} as T;
		}
	}
	async capture(tab: CurrentTab) {
		this.captured.push(tab);
		await this.duringCapture?.();
		if (this.captureFails) throw new Error("no access");
		return new Blob(["png"], { type: "image/png" });
	}
}

let cropSize = 1000;
let scaled = 0;
const images: ImageTools = {
	toWebp: async () => ({ blob: webp(5000), width: 2560, height: 1600 }),
	scale: async (_blob, maxSide) => {
		scaled++;
		return { blob: webp(cropSize), width: maxSide, height: 10 };
	},
	crop: async (_image, rects) =>
		rects.map(() => ({ blob: webp(800), width: 300, height: 80 })),
};

let store: MemoryStore;
let tab: FakeTab;
let changed: string[];
let tools: Map<string, Tool>;

/** Case c_1 with marks 1 and 2; its crops are `cropWidth` pixels wide. */
async function seed(
	cropWidth = 10,
	comment?: string,
	marks = 2,
): Promise<Case> {
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
		annotations: Array.from({ length: marks }, (_, i) => mark(i + 1)).map(
			(a) => (comment === undefined ? a : { ...a, comment }),
		),
	};
	await store.putCase(c);
	for (const path of ["shots/s1.webp", "crops/a1.webp", "crops/a2.webp"])
		await store.putImage(c.id, path, {
			blob: webp(100),
			width: path.startsWith("crops") ? cropWidth : 10,
			height: 10,
		});
	return c;
}

type Result = { content: { type: string; text?: string; data?: string }[] };

function build(options: Partial<ToolDeps> = {}): void {
	tools = new Map(
		createTools({
			store,
			tab,
			images,
			onChange: (id) => changed.push(id),
			settle: async () => {},
			...options,
		}).map((t) => [t.name, t]),
	);
}

async function call(
	name: string,
	input: Record<string, unknown> = {},
	signal: AbortSignal = new AbortController().signal,
): Promise<Result> {
	const tool = tools.get(name);
	if (tool === undefined) throw new Error(`no tool ${name}`);
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
	scaled = 0;
	build();
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
		// Crops within 800 px go as they are stored: no second WebP pass.
		expect(scaled).toBe(0);
	});

	test("get_case leaves out crops beyond the size budget", async () => {
		await seed(2000);
		cropSize = 400_000; // ~533 000 base64 characters each
		const result = await call("get_case", { caseId: "c_1" });
		expect(result.content.filter((c) => c.type === "image")).toHaveLength(1);
		expect(result.content.at(-1)?.text).toContain("crops/a2.webp");
	});

	test("get_case counts the text against the limit and compacts a large case", async () => {
		build({ maxMessageBytes: () => 40_000 });
		await seed(10, "x".repeat(20_000));
		const result = await call("get_case", { caseId: "c_1" });
		const view = json(result);
		expect(view.marks[0].comment).toHaveLength(1001);
		expect(view.marks[0].element).toBe(
			'button "Prämien berechnen" · Button_primary',
		);
		expect(result.content[1]?.text).toContain("The case is large");
		const total = result.content.reduce(
			(n, c) => n + (c.text ?? c.data ?? "").length,
			0,
		);
		expect(total).toBeLessThan(30_000);
	});

	test("list_cases and load_case stay under the limit and say what they left out", async () => {
		build({ maxMessageBytes: () => 20_000 });
		for (let i = 0; i < 60; i++)
			await store.putCase({
				...sampleCase(
					`c_${i + 10}`,
					`2026-11-04T10:${String(i).padStart(2, "0")}:00Z`,
				),
				title: "T".repeat(450),
			});
		const listed = await call("list_cases");
		const cases = json(listed);
		expect(cases.length).toBeGreaterThan(0);
		expect(cases.length).toBeLessThan(60);
		expect(cases[0].caseId).toBe("c_69"); // newest first
		expect(listed.content[1]?.text).toContain("older cases are left out");
		expect(JSON.stringify(listed).length).toBeLessThan(20_000);

		await seed(10, undefined, 200);
		const loaded = await call("load_case", { caseId: "c_1" });
		const marks = json(loaded).marks;
		expect(marks.length).toBeLessThan(200);
		expect(marks[0].mark).toBe(1);
		expect(loaded.content[1]?.text).toContain("marks are left out");
		expect(JSON.stringify(loaded).length).toBeLessThan(20_000);
	});

	test("get_image scales down to fit, and refuses what cannot fit", async () => {
		await seed();
		const fits = await call("get_image", {
			caseId: "c_1",
			path: "shots/s1.webp",
		});
		expect(fits.content[1]?.type).toBe("image");
		build({ maxMessageBytes: () => 100_000 });
		cropSize = 200_000;
		await expect(
			call("get_image", { caseId: "c_1", path: "shots/s1.webp" }),
		).rejects.toThrow("does not fit");
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
		for (const r of tab.sent)
			if (r.type === "case:show") expect(r.caseId).toBe("c_1");
	});

	test("load_case passes on the page's error", async () => {
		await seed();
		tab.loadError = "Loading was replaced by another case.";
		await expect(call("load_case", { caseId: "c_1" })).rejects.toThrow(
			"Loading was replaced by another case.",
		);
		await expect(call("highlight", { caseId: "c_1", mark: 1 })).rejects.toThrow(
			"Loading was replaced by another case.",
		);
	});

	test("highlight loads the case again when the loaded copy lacks the mark", async () => {
		await seed();
		await call("load_case", { caseId: "c_1" });
		await call("add_annotation", {
			caseId: "c_1",
			selector: "form button",
			comment: "New",
		});
		tab.sent = [];
		const shown = json(await call("highlight", { caseId: "c_1", mark: 3 }));
		expect(shown.mark).toBe(1); // the fake's match
		expect(tab.sent.map((r) => r.type)).toEqual([
			"overlay:state",
			"case:show",
			"case:load",
			"case:show",
		]);
	});

	test("capture returns the tab's screenshot, with password fields blurred", async () => {
		const result = await call("capture");
		expect(json(result)).toEqual({
			url: "http://localhost:3000/kk",
			title: "KK",
		});
		expect(result.content[1]?.type).toBe("image");
		expect(tab.captured.map((t) => t.id)).toEqual([7]);
		expect(tab.sent).toEqual([
			{ type: "page:blur", blurForms: false },
			{ type: "page:unblur" },
		]);
	});

	test("screenshots for the AI app follow the blur setting, and unblur on failure", async () => {
		build({ blurForms: () => true });
		await seed();
		await call("add_annotation", {
			caseId: "c_1",
			selector: "form button",
			comment: "x",
		});
		expect(tab.sent[0]).toMatchObject({
			type: "element:mark",
			blurForms: true,
		});
		tab.sent = [];
		tab.captureFails = true;
		await expect(call("capture")).rejects.toThrow("no access");
		expect(tab.sent).toEqual([
			{ type: "page:blur", blurForms: true },
			{ type: "page:unblur" },
		]);
	});

	test("capture is refused while the user's save takes screenshots", async () => {
		tab.saving = true;
		await expect(call("capture")).rejects.toThrow("saving marks");
		expect(tab.captured).toEqual([]);
	});

	test("add_annotation is refused when the page in front changed after the user allowed it", async () => {
		await seed();
		const signal = new AbortController().signal;
		const question = await confirmRequestFor(store, tab, {
			tool: { name: "add_annotation", description: "Add a mark." },
			arguments: { caseId: "c_1", selector: "button", comment: "x" },
			client: {
				grantId: "g",
				id: "https://claude.ai/oauth",
				host: "claude.ai",
			},
			signal,
		});
		expect(question.tool.description).toContain(
			"Page: http://localhost:3000/kk",
		);
		tab.url = "https://mail.example/inbox";
		await expect(
			call(
				"add_annotation",
				{ caseId: "c_1", selector: "button", comment: "x" },
				signal,
			),
		).rejects.toThrow("The page in front changed since the user allowed this");
		expect((await store.getCase("c_1"))?.annotations).toHaveLength(2);
		tab.url = "http://localhost:3000/kk";
		await call(
			"add_annotation",
			{ caseId: "c_1", selector: "button", comment: "x" },
			signal,
		);
		expect((await store.getCase("c_1"))?.annotations).toHaveLength(3);
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

	test("tools on the tab run one at a time", async () => {
		await seed();
		const results = await Promise.all([
			call("add_annotation", { caseId: "c_1", selector: "a", comment: "one" }),
			call("add_annotation", { caseId: "c_1", selector: "b", comment: "two" }),
			call("capture"),
		]);
		expect(results.map((r) => r.content[0]?.text?.slice(0, 11))).toEqual([
			"Added mark ",
			"Added mark ",
			'{\n  "url": ',
		]);
		const c = await store.getCase("c_1");
		expect(c?.annotations.map((a) => [a.number, a.comment]).slice(2)).toEqual([
			[3, "one"],
			[4, "two"],
		]);
		expect(tab.sent.map((r) => r.type)).toEqual([
			"element:mark",
			"element:unmark",
			"element:mark",
			"element:unmark",
			"page:blur",
			"page:unblur",
		]);
	});

	test("a number the user took meanwhile gives the AI app its own error", async () => {
		await seed();
		tab.duringCapture = async () => {
			await store.updateCase("c_1", (c) => ({
				value: {
					...(c as Case),
					annotations: [...(c as Case).annotations, mark(3)],
				},
			}));
		};
		await expect(
			call("add_annotation", { caseId: "c_1", selector: "a", comment: "x" }),
		).rejects.toThrow(
			"Mark 3 was added to the case meanwhile (by the user); call add_annotation again.",
		);
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
		for (const name of [
			"list_cases",
			"get_case",
			"get_image",
			"load_case",
			"highlight",
			"capture",
			"add_annotation",
		])
			expect(hints[name]?.untrustedContentHint).toBe(true);
	});

	test("list_cases sends only the start of a verdict", async () => {
		await seed();
		await call("set_verdict", { caseId: "c_1", verdict: "v".repeat(5000) });
		expect(json(await call("list_cases"))[0].verdict).toHaveLength(201);
	});
});

describe("confirmations", () => {
	const request = (name: string, args: Record<string, unknown>) => ({
		tool: { name, description: "Does it." },
		arguments: args,
		client: { grantId: "g", id: "https://claude.ai/oauth", host: "claude.ai" },
		signal: new AbortController().signal,
	});

	test("name the case and, for a new mark, the page", async () => {
		await seed();
		await store.updateCase("c_1", (c) => ({
			value: { ...(c as Case), verdict: "x" },
		}));
		const del = await confirmRequestFor(
			store,
			tab,
			request("delete_case", { caseId: "c_1" }),
		);
		expect(del.tool.description).toBe(
			"Does it.\n\nCase: “Button contrast” (www.example.com/kk, 2 marks, with a verdict).",
		);
		expect(del.arguments).toEqual({ caseId: "c_1" });
		const add = await confirmRequestFor(
			store,
			tab,
			request("add_annotation", { caseId: "c_1", selector: "a" }),
		);
		expect(add.tool.description).toContain("Page: http://localhost:3000/kk");
		const unknown = await confirmRequestFor(
			store,
			tab,
			request("set_verdict", { caseId: "c_9" }),
		);
		expect(unknown.tool.description).toContain("Case: none has the id c_9.");
	});
});

describe("relay addresses", () => {
	test.each([
		["https://relay.example.com", undefined],
		["wss://relay.example.com/x", undefined],
		["http://localhost:8080", undefined],
		["http://127.0.0.1:8080", undefined],
		["http://[::1]:8080", undefined],
		["http://192.168.1.20:8080", "Plain http: works only for localhost"],
		["ftp://relay.example.com", "Use an https:"],
		["relay", "Not an address."],
	])("%s", (value, problem) => {
		const found = relayProblem(value);
		if (problem === undefined) expect(found).toBeUndefined();
		else expect(found).toContain(problem);
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
