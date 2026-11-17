/**
 * The Firefox build while developing it: builds it into `dist-firefox-dev/`
 * and starts Firefox through ff-rdp (https://github.com/ractive/ff-rdp) with
 * one profile that is kept, with the build as a temporary add-on.
 *
 *   bun scripts/firefox-dev.ts [URL] [--test] [--headless] [--port N]
 *   bun scripts/firefox-dev.ts --reload [--test] [--port N]
 *
 * `--test` builds the test build (`build.ts --firefox --test`): host access,
 * `downloads` and the data collection granted at install, and the panel's
 * page usable in a tab. With a URL it then opens the page in a window of its
 * own and the panel's page in the first window's tab, for the page's window
 * (`sidepanel/index.html?window=<id>`): automation reaches that tab, where
 * it cannot reach Firefox's sidebar. Without `--test`, the add-on asks for
 * access as the store's does; a temporary add-on loses what it was given
 * whenever Firefox quits.
 *
 * A temporary add-on is gone when Firefox quits, and one loaded again after
 * its removal gets a new UUID and empty storage. The profile sets
 * `extensions.webextensions.keepUuidOnUninstall` and `keepStorageOnUninstall`
 * against that, and `browser.sessionstore.resume_from_crash` off (ff-rdp ends Firefox with a signal, which removes nothing, and
 * a reload keeps both). Running the script again rebuilds and replaces the
 * running Firefox (ff-rdp's `--replace`); `--reload` rebuilds and reloads the
 * add-on in the running Firefox (`ff-rdp addon reload`), as an update does;
 * extension pages in tabs close then. The profile: `SITEGLOSS_FIREFOX_PROFILE`,
 * or `~/.cache/sitegloss/firefox-dev-profile`. ff-rdp's commands reach this
 * Firefox with `--port N` (6000 unless given; use another one while a
 * Firefox of your own listens there).
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build, FIREFOX_ID } from "./build.ts";

/**
 * What the profile needs: the add-on's UUID and storage outlast its removal,
 * and no tabs come back from the last run (ff-rdp ends Firefox with a
 * signal, which Firefox takes for a crash): the panel's tabs of the run
 * before would be panels too.
 */
export const DEV_PREFS: Readonly<Record<string, boolean>> = {
	"extensions.webextensions.keepUuidOnUninstall": true,
	"extensions.webextensions.keepStorageOnUninstall": true,
	"browser.sessionstore.resume_from_crash": false,
};

/**
 * The value `user.js` sets `name` to, as written, or `undefined`: its last
 * `user_pref` line for it that is not commented out (Firefox reads them in
 * order, the last one wins).
 */
export function userPref(userJs: string, name: string): string | undefined {
	let value: string | undefined;
	for (const line of userJs.split("\n")) {
		const match =
			/^\s*user_pref\(\s*("(?:[^"\\]|\\.)*")\s*,\s*(.*?)\s*\)\s*;/.exec(line);
		if (match?.[1] !== undefined && JSON.parse(match[1]) === name)
			value = match[2];
	}
	return value;
}

/** `user.js` with `DEV_PREFS` added, keeping what it sets already. */
export function withDevPrefs(userJs: string): string {
	const lines = userJs === "" ? [] : userJs.replace(/\n$/, "").split("\n");
	for (const [name, value] of Object.entries(DEV_PREFS))
		if (userPref(userJs, name) === undefined)
			lines.push(`user_pref(${JSON.stringify(name)}, ${value});`);
	return `${lines.join("\n")}\n`;
}

/** The panel's page for the tab in front of window `windowId`. */
export function panelTabUrl(uuid: string, windowId: number): string {
	return `moz-extension://${uuid}/sidepanel/index.html?window=${windowId}`;
}

/** Run ff-rdp on `port`; its JSON's `results`, or it throws with what it said. */
async function ffRdp(port: string, args: string[]): Promise<unknown> {
	const run = Bun.spawn(["ff-rdp", "--port", port, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(run.stdout).text(),
		new Response(run.stderr).text(),
		run.exited,
	]);
	if (code !== 0) throw new Error(`ff-rdp ${args[0]}: ${err || out}`);
	return (JSON.parse(out) as { results?: unknown }).results;
}

/**
 * The test build's layout: the panel's page in the first tab, the page at
 * `url` in a window of its own, the panel showing that window's tab.
 */
async function openPanelTab(port: string, url: string): Promise<void> {
	const addons = (await ffRdp(port, ["addon", "list"])) as {
		id: string;
		uuid?: string;
	}[];
	const uuid = addons.find((a) => a.id === FIREFOX_ID)?.uuid;
	if (uuid === undefined) throw new Error(`${FIREFOX_ID} is not installed`);
	await ffRdp(port, [
		"navigate",
		`moz-extension://${uuid}/sidepanel/index.html`,
	]);
	const windowId = await ffRdp(port, [
		"--tab",
		"moz-extension",
		"eval",
		`await chrome.windows.create({ url: ${JSON.stringify(url)} }).then((w) => w.id)`,
	]);
	if (typeof windowId !== "number")
		throw new Error(`no window for ${url}: ${String(windowId)}`);
	await ffRdp(port, [
		"--tab",
		"moz-extension",
		"navigate",
		panelTabUrl(uuid, windowId),
	]);
	console.error(`panel ${panelTabUrl(uuid, windowId)}\npage ${url}`);
}

if (import.meta.main) {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			headless: { type: "boolean" },
			reload: { type: "boolean" },
			test: { type: "boolean" },
			port: { type: "string", default: "6000" },
		},
	});
	if (Bun.which("ff-rdp") === null) {
		console.error(
			"ff-rdp is not on the PATH: https://github.com/ractive/ff-rdp",
		);
		process.exit(2);
	}
	const port = String(values.port);
	// An empty variable is no profile (`resolve("")` is the working directory).
	const profile = resolve(
		process.env["SITEGLOSS_FIREFOX_PROFILE"] ||
			join(homedir(), ".cache/sitegloss/firefox-dev-profile"),
	);
	await mkdir(profile, { recursive: true });
	const userJs = Bun.file(join(profile, "user.js"));
	const before = (await userJs.exists()) ? await userJs.text() : "";
	const after = withDevPrefs(before);
	if (after !== before) await Bun.write(userJs, after);
	for (const [name, value] of Object.entries(DEV_PREFS)) {
		const set = userPref(after, name);
		if (set !== String(value))
			console.error(
				`${join(profile, "user.js")} sets ${name} to ${set}: loaded again after a removal, the add-on may get a new UUID or empty storage`,
			);
	}
	const { outdir } = await build({
		firefox: true,
		...(values.test ? { test: true } : {}),
		outdir: join(import.meta.dir, "..", "dist-firefox-dev"),
	});
	console.error(`built ${outdir}\nprofile ${profile}`);
	const url = positionals[0];
	const command = values.reload
		? ["ff-rdp", "--port", port, "addon", "reload", outdir]
		: [
				"ff-rdp",
				"launch",
				"--profile",
				profile,
				"--debug-port",
				port,
				"--replace",
				"--temporary-addon",
				outdir,
				...(values.headless ? ["--headless"] : []),
				...(url !== undefined && !values.test ? [url] : []),
			];
	const launch = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
	const code = await launch.exited;
	if (code !== 0 && values.reload)
		console.error(
			`no reload: is this Firefox running (bun scripts/firefox-dev.ts first), on --port ${port}?`,
		);
	if (code === 0 && values.test && url !== undefined && !values.reload)
		await openPanelTab(port, url);
	process.exit(code);
}
