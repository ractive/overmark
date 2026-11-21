/**
 * Steps against a real sitegloss.dev server, shared by the end-to-end tests
 * that sign in.
 */

import { PASSWORD } from "../cloud-real.ts";
import type { Browser, Page } from "./browser.ts";
import { until } from "./steps.ts";

const id = (name: string) => `document.getElementById(${JSON.stringify(name)})`;
const text = (name: string) => `(${id(name)}?.textContent ?? "")`;

/** Sign in at `base` in the panel, as a user does: the server's own page, in the browser's window. */
export async function signInPanel(
	browser: Browser,
	panel: Page,
	base: string,
	email = "tess@example.com",
	who = "Tess Tester",
): Promise<void> {
	await panel.waitFor(`${id("cloud")}?.dataset.cloud === "off"`);
	await panel.eval(
		`(() => { document.querySelector(".cloud-server").open = true; const choice = ${id("cloud-server-choice")}; choice.value = "other"; choice.dispatchEvent(new Event("change")); const field = ${id("cloud-server")}; field.value = ${JSON.stringify(base)}; field.dispatchEvent(new Event("change")); field.blur(); return true; })()`,
	);
	await panel.waitFor(
		`${text("cloud")}.includes(${JSON.stringify(new URL(base).host)})`,
	);
	const before = new Set((await browser.targets()).map((t) => t.targetId));
	await panel.click(
		`${id("cloud")}.querySelector('[data-action="cloud-sign-in"]')`,
	);
	const opened = (
		await until(
			() => browser.targets(),
			(now) =>
				now.some((t) => !before.has(t.targetId) && t.url.startsWith(base)),
			20_000,
		)
	).find((t) => !before.has(t.targetId) && t.url.startsWith(base));
	const sign = await browser.attachPage(opened?.targetId as string);
	await sign.waitFor(`document.querySelector('input[type="email"]')`, 20_000);
	await sign.click(`document.querySelector('input[type="email"]')`);
	await sign.type(email);
	await sign.click(`document.querySelector('input[type="password"]')`);
	await sign.type(PASSWORD);
	await sign.click(`document.querySelector('button[type="submit"]')`);
	await until(
		async () => {
			const allow = `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Allow")`;
			// The window closes by itself once it is done: a command sent to
			// it then is never answered, so none is waited for long.
			const asks = await Promise.race([
				sign
					.eval<boolean>(
						`location.pathname.startsWith("/consent") && !!${allow}`,
					)
					.catch(() => false),
				Bun.sleep(2000).then(() => false),
			]);
			if (asks)
				await Promise.race([
					sign.click(allow).catch(() => undefined),
					Bun.sleep(2000),
				]);
			return (await browser.targets()).some(
				(t) => t.targetId === opened?.targetId,
			);
		},
		(open) => !open,
		30_000,
	);
	await panel.waitFor(
		`${text("cloud-who")}.includes(${JSON.stringify(who)})`,
		20_000,
	);
	await panel.waitFor(`${text("cloud-status")}.length > 0`, 30_000);
}
