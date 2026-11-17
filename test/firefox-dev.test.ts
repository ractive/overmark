import { expect, test } from "bun:test";
import {
	DEV_PREFS,
	panelTabUrl,
	userPref,
	withDevPrefs,
} from "../scripts/firefox-dev.ts";

test("the development profile keeps the add-on's UUID and storage, and what user.js set", () => {
	const fresh = withDevPrefs("");
	for (const [name, value] of Object.entries(DEV_PREFS))
		expect(fresh).toContain(`user_pref(${JSON.stringify(name)}, ${value});`);
	expect(withDevPrefs(fresh)).toBe(fresh);
	const name = "extensions.webextensions.keepUuidOnUninstall";
	const own = `user_pref("${name}", false);\n`;
	const kept = withDevPrefs(own);
	expect(kept.startsWith(own)).toBe(true);
	expect(kept).not.toContain(`${name}", true`);
	// A line commented out sets nothing; the last live one wins.
	const commented = `// user_pref("${name}", true);\n`;
	expect(userPref(commented, name)).toBeUndefined();
	expect(withDevPrefs(commented)).toContain(`\nuser_pref("${name}", true);`);
	expect(userPref(`${own}user_pref("${name}", true);\n`, name)).toBe("true");
	expect(panelTabUrl("u-1", 31)).toBe(
		"moz-extension://u-1/sidepanel/index.html?window=31",
	);
});
