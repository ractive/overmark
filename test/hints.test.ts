import { expect, test } from "bun:test";
import { CaseHints } from "../src/sidepanel/hints.ts";

/** The line under the case's buttons, written through `hints`. */
function line() {
	const hints = new CaseHints();
	let text: string | undefined;
	const writer = (may: () => boolean) => (t: string) => {
		if (may()) text = t;
	};
	return {
		hints,
		action: () => writer(hints.action()),
		draw: () => writer(hints.draw()),
		text: () => text,
	};
}

test("a draw's found line comes after an action that says nothing", () => {
	const l = line();
	const draw = l.draw();
	l.action(); // Done adding, an Export that went well
	draw("3 of 4 marks found");
	expect(l.text()).toBe("3 of 4 marks found");
});

test("an action that wrote: the draws under way and their searches again say nothing more", () => {
	const l = line();
	const draw = l.draw();
	draw("1 of 2 marks found");
	l.action()("Could not export: disk full");
	draw("2 of 2 marks found");
	expect(l.text()).toBe("Could not export: disk full");
	// A draw started after it may.
	l.draw()("2 of 2 marks found");
	expect(l.text()).toBe("2 of 2 marks found");
});

test("two actions answering in reverse order: the later click wins", () => {
	const l = line();
	const matchSize = l.action();
	const exported = l.action();
	exported("Could not export: disk full");
	matchSize("This tab is now 894×649, as when the marks were made.");
	expect(l.text()).toBe("Could not export: disk full");
});

test("an action's error after another's success: the error shows", () => {
	const l = line();
	const matchSize = l.action();
	const resolve = l.action();
	matchSize("This tab is now 894×649, as when the marks were made.");
	resolve("Not saved: The case no longer exists.");
	expect(l.text()).toBe("Not saved: The case no longer exists.");
});

test("an action writes again after its own first write", () => {
	const l = line();
	const a = l.action();
	a("Saving…");
	a("Saved");
	expect(l.text()).toBe("Saved");
});

test("a writer of a closed case writes nothing, an action nor a draw", () => {
	const l = line();
	const a = l.action();
	const d = l.draw();
	l.hints.cancel(); // "← All cases", another case opened, Hide marks
	a("late");
	d("late too");
	expect(l.text()).toBeUndefined();
	l.action()("now");
	expect(l.text()).toBe("now");
});
