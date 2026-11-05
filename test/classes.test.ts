import { describe, expect, test } from "bun:test";
import {
	isGeneratedId,
	readableClass,
	readableClasses,
} from "../src/lib/classes.ts";

describe("readableClass", () => {
	test.each([
		["Button_primary__x7Yz2", "Button_primary"],
		["Header_root__a1B2c", "Header_root"],
		["_primary_1a2b3_1", "primary"],
		["Button__StyledButton-sc-1x2y3z-0", "Button__StyledButton"],
		["css-1a2b3c-Button", "Button"],
		["card__title", "card__title"],
		["px-4", "px-4"],
		["MainNav", "MainNav"],
		["is-active", "is-active"],
	])("%s → %s", (input, expected) => {
		expect(readableClass(input)).toBe(expected);
	});

	test.each(["sc-bdVaJa", "css-1x2y3z", "kLmNoP", "e1abc2d3", ""])(
		"%s is random",
		(input) => {
			expect(readableClass(input)).toBeUndefined();
		},
	);

	test("a class attribute keeps order and drops duplicates", () => {
		expect(
			readableClasses(
				"Button_primary__x7Yz2  sc-bdVaJa Button_primary__zzZ99 px-4",
			),
		).toEqual(["Button_primary", "px-4"]);
	});
});

describe("isGeneratedId", () => {
	test.each([
		":r1:",
		"«r3»",
		"radix-:r5:",
		"3f2a9c1e-77aa-4c1b-9d55-0123456789ab",
		"ember123",
		"mui-42",
		"headlessui-menu-button-3",
		"item-1234",
	])("%s is generated", (id) => {
		expect(isGeneratedId(id)).toBe(true);
	});

	test.each(["main", "search-input", "login-form", "step2"])(
		"%s is hand-written",
		(id) => {
			expect(isGeneratedId(id)).toBe(false);
		},
	);
});
