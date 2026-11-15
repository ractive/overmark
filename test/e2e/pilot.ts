/**
 * How well does Overmark find elements again on real pages?
 *
 *   bun test/e2e/pilot.ts <url> [<the same page in another environment>]
 *
 * Picks up to 25 visible elements spread over <url> (1280×800) and records
 * their details with the extension's own code. Then it looks for each one
 * after a reload, at phone width (390×844), and in the other environment if one is
 * given, with the same search the extension uses when a case is loaded. For
 * the same environment, "right" means the element at the same place in the DOM;
 * for another environment it prints what was found, for a person to judge.
 *
 * Needs Chrome for Testing or Chromium (CHROME_PATH, or Playwright's).
 */

import { join } from "node:path";
import { Browser, findBrowser, type Page } from "./browser.ts";

const urls = process.argv.slice(2);
if (urls.length === 0) {
	console.error(
		"usage: bun test/e2e/pilot.ts <url> [<url in another environment>]",
	);
	process.exit(2);
}
const binary = findBrowser();
if (binary === undefined) {
	console.error("Chrome for Testing or Chromium is needed (CHROME_PATH).");
	process.exit(2);
}

const bundle = await Bun.build({
	entrypoints: [join(import.meta.dir, "pilot-entry.ts")],
	target: "browser",
	format: "iife",
});
if (!bundle.success) throw new AggregateError(bundle.logs, "pilot bundle");
const code = await (bundle.outputs[0] as Blob).text();

const DESKTOP = {
	width: 1280,
	height: 800,
	deviceScaleFactor: 1,
	mobile: false,
};
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };

/** Load a page as a person would: wait, then dismiss a cookie banner. */
async function open(
	page: Page,
	url: string,
	metrics: typeof DESKTOP,
): Promise<void> {
	await page.send("Emulation.setDeviceMetricsOverride", metrics);
	await page.goto(url, 45_000);
	await Bun.sleep(2500);
	await page.eval(`(() => {
		const buttons = [...document.querySelectorAll("button, [role=button], a")];
		const pick = (re) => buttons.find((b) => re.test((b.innerText || "").trim()));
		const b = pick(/^(alle ablehnen|ablehnen|nur notwendige|reject all|decline)/i) ?? pick(/^(alle akzeptieren|akzeptieren|accept all|zustimmen)/i);
		b?.click();
	})()`);
	await Bun.sleep(1200);
	await page.eval(code);
}

const SETUP = `(() => {
	globalThis.__pathOf = (e) => {
		const parts = [];
		for (let at = e; at && at !== document.documentElement; at = at.parentElement)
			parts.unshift([...at.parentElement.children].indexOf(at));
		return parts.join("/");
	};
	globalThis.__byPath = (path) => {
		let at = document.documentElement;
		for (const i of path.split("/").filter(Boolean).map(Number)) at = at?.children[i];
		return at ?? null;
	};
	globalThis.__visible = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
	globalThis.__label = (e) => (e.localName + " " + (e.getAttribute("aria-label") || e.textContent || e.getAttribute("alt") || "").replace(/\\s+/g, " ").trim().slice(0, 40)).trim();
})()`;

interface Target {
	details: unknown;
	path: string;
	label: string;
}

async function pickTargets(page: Page): Promise<Target[]> {
	await page.eval(SETUP);
	return page.eval<Target[]>(`(() => {
		const P = globalThis.__overmarkPilot;
		const all = [...document.querySelectorAll("h1, h2, h3, h4, button, a[href], input, select, textarea, img, label, p, li")]
			.filter((e) => {
				const r = e.getBoundingClientRect();
				const s = getComputedStyle(e);
				return r.width > 8 && r.height > 8 && s.visibility !== "hidden" && s.display !== "none" && !e.closest("[role=dialog], [aria-modal=true]");
			})
			.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
		const step = Math.max(1, Math.floor(all.length / 25));
		const picked = all.filter((_, i) => i % step === 0).slice(0, 25);
		const context = P.createContext(document);
		return picked.map((e) => ({ details: P.describeElement(e, context), path: __pathOf(e), label: __label(e) }));
	})()`);
}

interface Outcome {
	status: string;
	score: number;
	path: string | null;
	label: string | null;
	/** The found element is visible; and the element at the recorded place is. */
	visible: boolean;
	originalVisible: boolean;
}

async function search(
	page: Page,
	targets: Target[],
): Promise<{ outcomes: Outcome[]; ms: number }> {
	await page.eval(SETUP);
	return page.eval(`(() => {
		const P = globalThis.__overmarkPilot;
		const targets = ${JSON.stringify(targets.map((t) => t.details))};
		const paths = ${JSON.stringify(targets.map((t) => t.path))};
		const started = performance.now();
		const search = P.createSearch(document);
		const outcomes = targets.map((stored, i) => {
			const found = P.findCandidates(search, stored);
			const best = found.candidates[0]?.element;
			return { status: found.status, score: Math.round(found.score * 100) / 100, path: best ? __pathOf(best) : null, label: best ? __label(best) : null, visible: __visible(best), originalVisible: __visible(__byPath(paths[i])) };
		});
		return { outcomes, ms: Math.round(performance.now() - started) };
	})()`);
}

function report(
	name: string,
	targets: Target[],
	outcomes: Outcome[],
	ms: number,
	judge: boolean,
): void {
	const count = (s: string) => outcomes.filter((o) => o.status === s).length;
	const shown = outcomes.filter((o) => o.status !== "lost");
	// The same place in the DOM; or, where a layout hides the original, a visible copy.
	const isRight = (o: Outcome, i: number) =>
		o.path === targets[i]?.path || (!o.originalVisible && o.visible);
	const right = outcomes.filter(
		(o, i) => o.status !== "lost" && isRight(o, i),
	).length;
	console.log(
		`\n${name}: ${count("found")} found, ${count("probable")} probable, ${count("ambiguous")} ambiguous, ${count("lost")} lost of ${targets.length}; ${judge ? `${right} of ${shown.length} shown on the right element (≈: a visible copy of an element this layout hides); ` : ""}${ms} ms`,
	);
	for (const [i, o] of outcomes.entries()) {
		const t = targets[i] as Target;
		const mark = !judge
			? " "
			: o.status === "lost"
				? "-"
				: o.path === t.path
					? "✓"
					: isRight(o, i)
						? "≈"
						: "✗";
		if (judge && mark === "✓" && o.status === "found") continue;
		const where = o.visible ? "" : " (hidden)";
		console.log(
			`  ${mark} ${String(i + 1).padStart(2)} ${o.status.padEnd(9)} ${String(o.score).padEnd(4)} ${t.label.padEnd(46)} → ${o.label ?? "(none)"}${where}`,
		);
	}
}

const browser = await Browser.launch(
	binary,
	join(import.meta.dir, "../../dist"),
);
try {
	const page = await browser.newPage();
	await open(page, urls[0] as string, DESKTOP);
	const targets = await pickTargets(page);
	console.log(`${urls[0]}: ${targets.length} elements recorded at 1280×800`);

	await open(page, urls[0] as string, DESKTOP);
	let r = await search(page, targets);
	report("Reloaded, 1280×800", targets, r.outcomes, r.ms, true);

	await open(page, urls[0] as string, PHONE);
	r = await search(page, targets);
	report("Phone, 390×844", targets, r.outcomes, r.ms, true);

	if (urls[1]) {
		await open(page, urls[1], DESKTOP);
		r = await search(page, targets);
		report(
			`Other environment ${urls[1]}, 1280×800`,
			targets,
			r.outcomes,
			r.ms,
			false,
		);
	}
} finally {
	await browser.close();
}
