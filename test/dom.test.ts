import { expect, test } from "bun:test";
import { sitePattern } from "../src/sidepanel/dom.ts";

test.each([
	[
		"https://www.example.com/krankenkassen/default?x=1",
		"https://www.example.com/*",
	],
	["http://localhost:5173/page", "http://localhost/*"],
	["chrome://extensions", undefined],
	["not a url", undefined],
])("the site of %s", (url, pattern) => {
	expect(sitePattern(url)).toBe(pattern);
});
