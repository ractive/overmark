/**
 * The window whose tab in front the panel shows: the one it is in. Firefox's
 * test build runs the panel's page in a tab (automation cannot reach the
 * sidebar), which then names the window of the pages it is for in its
 * address, `sidepanel/index.html?window=<id>`; only there.
 */

declare const SITEGLOSS_TEST_BUILD: boolean | undefined;
declare const SITEGLOSS_FIREFOX: boolean | undefined;

/** The `?window=` of a panel's address, if it names one. */
export function windowParam(search: string): number | undefined {
	const value = new URLSearchParams(search).get("window");
	if (value === null || !/^\d+$/.test(value)) return undefined;
	return Number(value);
}

/** The panel's window: see above. */
export async function panelWindow(): Promise<number | undefined> {
	// The defines themselves, not `browser.ts`'s constants: other builds drop it.
	if (
		typeof SITEGLOSS_TEST_BUILD !== "undefined" &&
		SITEGLOSS_TEST_BUILD &&
		typeof SITEGLOSS_FIREFOX !== "undefined" &&
		SITEGLOSS_FIREFOX
	) {
		const named = windowParam(location.search);
		if (named !== undefined) return named;
	}
	return (await chrome.windows.getCurrent()).id;
}
