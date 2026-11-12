import { expect, test } from "bun:test";
import { Latest } from "../src/lib/latest.ts";

test("only the newest piece of work stays current", () => {
	const latest = new Latest();
	const first = latest.start();
	const second = latest.start();
	expect(first.current()).toBe(false);
	expect(second.current()).toBe(true);
	latest.cancel();
	expect(second.current()).toBe(false);
});

test("peek joins the newest without making it stale, and goes stale with it", () => {
	const latest = new Latest();
	const action = latest.start();
	const draw = latest.peek();
	// The user's action keeps its say; the draw may write too.
	expect(action.current()).toBe(true);
	expect(draw.current()).toBe(true);
	// A newer action makes both stale.
	const next = latest.start();
	expect(action.current()).toBe(false);
	expect(draw.current()).toBe(false);
	expect(next.current()).toBe(true);
});
