/**
 * Always allow and Allow all changes (DEC-018): kept per AI app (grant) and
 * tool in the worker's settings database, gone with the grant, and what a
 * call of a tool that changes something gets from them.
 */

import { describe, expect, test } from "bun:test";
import type { ConfirmRequest } from "@ractive-ch/tab-mcp-client";
import { ALWAYS_KEY, AlwaysAllowed, alwaysOf } from "../src/worker/always.ts";
import { type Decider, decide } from "../src/worker/decide.ts";
import { memoryKv } from "../src/worker/kv.ts";
import type { Answer } from "../src/worker/protocol.ts";

describe("what is always allowed", () => {
	test("per app and tool: another tool, or another app, still asks", async () => {
		const kv = memoryKv();
		const always = await AlwaysAllowed.load(kv);
		expect(always.has("g1", "set_verdict")).toBe(false);
		await always.addTool("g1", "set_verdict");
		expect(always.has("g1", "set_verdict")).toBe(true);
		expect(always.has("g1", "delete_case")).toBe(false);
		expect(always.has("g2", "set_verdict")).toBe(false);
		// Twice is once.
		await always.addTool("g1", "set_verdict");
		expect(always.entry("g1")).toEqual({ all: false, tools: ["set_verdict"] });
	});

	test("Allow all changes lets every tool through, for that app only", async () => {
		const always = await AlwaysAllowed.load(memoryKv());
		await always.setAll("g1", true);
		for (const tool of ["add_annotation", "set_verdict", "delete_case"])
			expect(always.has("g1", tool)).toBe(true);
		expect(always.has("g2", "delete_case")).toBe(false);
		await always.setAll("g1", false);
		expect(always.has("g1", "delete_case")).toBe(false);
	});

	test("Ask again takes one tool back; the app's switch stays as it is", async () => {
		const always = await AlwaysAllowed.load(memoryKv());
		await always.addTool("g1", "set_verdict");
		await always.addTool("g1", "add_annotation");
		await always.removeTool("g1", "set_verdict");
		expect(always.entry("g1")).toEqual({
			all: false,
			tools: ["add_annotation"],
		});
		await always.setAll("g1", true);
		await always.removeTool("g1", "add_annotation");
		expect(always.entry("g1")).toEqual({ all: true, tools: [] });
	});

	test("kept in the settings database: a new worker has it, by grant id", async () => {
		const kv = memoryKv();
		const before = await AlwaysAllowed.load(kv);
		await before.addTool("g1", "set_verdict");
		await before.setAll("g2", true);
		expect(kv.data.get(ALWAYS_KEY)).toEqual({
			g1: { all: false, tools: ["set_verdict"] },
			g2: { all: true, tools: [] },
		});
		const after = await AlwaysAllowed.load(kv);
		expect(after.has("g1", "set_verdict")).toBe(true);
		expect(after.has("g2", "delete_case")).toBe(true);
	});

	test("an app whose grant is gone is forgotten; nothing left removes the key", async () => {
		const kv = memoryKv();
		const always = await AlwaysAllowed.load(kv);
		await always.addTool("g1", "set_verdict");
		await always.setAll("g2", true);
		await always.keepGrants(["g2", "g3"]);
		expect(always.has("g1", "set_verdict")).toBe(false);
		expect(always.has("g2", "set_verdict")).toBe(true);
		await always.keepGrants([]);
		expect(kv.data.has(ALWAYS_KEY)).toBe(false);
		// The switch off with no tools left: nothing kept either.
		await always.setAll("g4", true);
		await always.setAll("g4", false);
		expect(kv.data.has(ALWAYS_KEY)).toBe(false);
	});

	test("a write that fails changes nothing", async () => {
		const kv = memoryKv();
		const always = await AlwaysAllowed.load(kv);
		await always.addTool("g1", "set_verdict");
		kv.set = async () => {
			throw new Error("disk full");
		};
		await expect(always.setAll("g1", true)).rejects.toThrow("disk full");
		await always.addTool("g1", "delete_case").catch(() => {});
		expect(always.has("g1", "delete_case")).toBe(false);
		expect(always.entry("g1")).toEqual({ all: false, tools: ["set_verdict"] });
		expect(kv.data.get(ALWAYS_KEY)).toEqual({
			g1: { all: false, tools: ["set_verdict"] },
		});
	});

	test("changes run one after the other, each from the one before", async () => {
		const kv = memoryKv();
		const always = await AlwaysAllowed.load(kv);
		await Promise.all([
			always.addTool("g1", "a"),
			always.addTool("g1", "b"),
			always.setAll("g1", true),
		]);
		expect(always.entry("g1")).toEqual({ all: true, tools: ["a", "b"] });
	});

	test("what is stored is checked: anything odd is dropped, so it asks", () => {
		expect([...alwaysOf(undefined)]).toEqual([]);
		expect([...alwaysOf([1, 2])]).toEqual([]);
		expect(
			Object.fromEntries(
				alwaysOf({
					g1: { all: true },
					g2: { tools: ["set_verdict", 3, "", "set_verdict"] },
					g3: { all: "yes", tools: "delete_case" },
					g4: null,
					["__proto__"]: { all: true, tools: [] },
				}),
			),
		).toEqual({
			g1: { all: true, tools: [] },
			g2: { all: false, tools: ["set_verdict"] },
			["__proto__"]: { all: true, tools: [] },
		});
	});
});

function request(tool = "delete_case", grantId = "g1"): ConfirmRequest {
	return {
		tool: { name: tool, title: tool, description: "" },
		arguments: {},
		client: { grantId, id: "https://claude.ai/oauth", host: "claude.ai" },
		signal: new AbortController().signal,
	};
}

/** A decider whose user answers `answer`; `asked` counts the questions. */
async function decider(answer: Answer | "timeout", connected = true) {
	const always = await AlwaysAllowed.load(memoryKv());
	const d: Decider & {
		always: AlwaysAllowed;
		asked: number;
		kept: () => void;
		keptCount: number;
		problems: unknown[];
	} = {
		always,
		asked: 0,
		keptCount: 0,
		problems: [],
		ask: async () => {
			d.asked++;
			return answer;
		},
		connected: () => connected,
		kept: () => {
			d.keptCount++;
		},
		notKept: (error) => d.problems.push(error),
	};
	return d;
}

describe("a call of a tool that changes something", () => {
	test("asks; Allow and Don't allow hold for this call only", async () => {
		for (const [answer, allowed] of [
			["allow", true],
			["deny", false],
			["timeout", false],
		] as const) {
			const d = await decider(answer);
			expect(await decide(d, request())).toBe(allowed);
			expect(await decide(d, request())).toBe(allowed);
			expect(d.asked).toBe(2);
		}
	});

	test("Always allow: the next call of that tool from that app does not ask; another tool or app does", async () => {
		const d = await decider("always");
		expect(await decide(d, request("set_verdict"))).toBe(true);
		expect(d.asked).toBe(1);
		expect(await decide(d, request("set_verdict"))).toBe(true);
		expect(d.asked).toBe(1);
		await decide(d, request("delete_case"));
		await decide(d, request("set_verdict", "g2"));
		expect(d.asked).toBe(3);
		// Each kept Always allow lets the questions it covers through.
		expect(d.keptCount).toBe(3);
	});

	test("Allow all changes: nothing asks for that app", async () => {
		const d = await decider("deny");
		await d.always.setAll("g1", true);
		for (const tool of ["add_annotation", "set_verdict", "delete_case"])
			expect(await decide(d, request(tool))).toBe(true);
		expect(d.asked).toBe(0);
		expect(await decide(d, request("delete_case", "g2"))).toBe(false);
		expect(d.asked).toBe(1);
	});

	test("Always allow from an app disconnected meanwhile allows this call, keeps nothing", async () => {
		const d = await decider("always", false);
		expect(await decide(d, request())).toBe(true);
		expect(d.always.has("g1", "delete_case")).toBe(false);
		expect(d.keptCount).toBe(0);
	});

	test("Always allow that cannot be kept allows this call and says why", async () => {
		const problems: unknown[] = [];
		const d: Decider = {
			always: {
				has: () => false,
				addTool: async () => {
					throw new Error("disk full");
				},
			},
			ask: async () => "always",
			connected: () => true,
			kept: () => problems.push("kept"),
			notKept: (error) => problems.push(error),
		};
		expect(await decide(d, request())).toBe(true);
		expect(problems).toHaveLength(1);
		expect(String(problems[0])).toContain("disk full");
	});
});
