/**
 * Filling in Sitegloss's pairing code on the relay's pairing page (DEC-044,
 * tab-mcp's DEC-199). When an AI app opens the hosted relay's `/authorize`
 * page in this browser, Sitegloss reads its form's hooks, asks its user in
 * its own panel (or a notification) whether to connect that app, and only on
 * a yes types its current code into the form's code field and clicks its
 * Connect button. The relay checks the code as if it had been typed.
 *
 * - Only on the hosted relay's own origin, exactly (`HOSTED_ORIGIN`), only on
 *   `/authorize` in a tab's top frame, and only for a form that names
 *   Sitegloss's app (`data-app="sitegloss"`). A form that is not exactly as
 *   documented gets nothing: the user types the code as before.
 * - It needs the optional access to that one site, which the panel asks for
 *   with a click (`PAIR_FILL_SITE`); without it Sitegloss cannot see the
 *   page, and nothing changes. No permission is required at install.
 * - The code goes into the field and nowhere else: not into an attribute of
 *   the page, a log or a message. The relay's page runs no scripts of its
 *   own (tab-mcp's DEC-057).
 */

import { DEFAULT_RELAY } from "./settings.ts";

/** The hosted relay's origin: the one origin whose page Sitegloss fills in. */
export const HOSTED_ORIGIN = new URL(DEFAULT_RELAY).origin;

/** The optional host access the panel asks for (`permissions.request`). */
export const PAIR_FILL_SITE = { origins: [`${HOSTED_ORIGIN}/*`] };

/** The relay's pairing page. */
export const PAIRING_PATH = "/authorize";

/** What the form says, as the relay wrote it (tab-mcp's DEC-199, version 1). */
export interface PairingForm {
	/** `data-app`: the app whose page the AI app asks to pair with. */
	app: string;
	/** `data-client-name`: the name the AI app gave itself. */
	clientName: string;
	/** `data-client-host`: the AI app's verified host. */
	clientHost: string;
}

/** Whether `url` is the pairing page of one of `origins`, exactly. */
export function isPairingPage(
	url: string | undefined,
	origins: readonly string[],
): boolean {
	if (url === undefined) return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	return origins.includes(parsed.origin) && parsed.pathname === PAIRING_PATH;
}

/** A code as the relay sends it: 8 letters, `XXXX-XXXX`. */
export const isCode = (code: string | undefined): code is string =>
	code !== undefined && /^[A-Z]{4}-[A-Z]{4}$/.test(code);

/**
 * Runs in the page (`scripting.executeScript`), so it uses nothing from
 * outside itself: the form's hooks, when there is exactly one such form with
 * exactly one code field and one Connect button in it; `null` otherwise.
 */
export function readPairingForm(): PairingForm | null {
	const forms = document.querySelectorAll('form[data-tab-mcp-pairing="1"]');
	if (forms.length !== 1) return null;
	const form = forms[0] as HTMLFormElement;
	const fields = form.querySelectorAll('input[data-tab-mcp-field="code"]');
	const buttons = form.querySelectorAll(
		'button[data-tab-mcp-action="connect"]',
	);
	if (fields.length !== 1 || buttons.length !== 1) return null;
	const app = form.getAttribute("data-app");
	const clientName = form.getAttribute("data-client-name");
	const clientHost = form.getAttribute("data-client-host");
	if (!app || !clientName || !clientHost) return null;
	return { app, clientName, clientHost };
}

/**
 * Runs in the page: types `code` into the form's code field and clicks its
 * Connect button, only if the form is still the one the user was asked
 * about (`seen`). Whether it did.
 */
export function fillPairingForm(code: string, seen: PairingForm): boolean {
	const forms = document.querySelectorAll('form[data-tab-mcp-pairing="1"]');
	if (forms.length !== 1) return false;
	const form = forms[0] as HTMLFormElement;
	const fields = form.querySelectorAll<HTMLInputElement>(
		'input[data-tab-mcp-field="code"]',
	);
	const buttons = form.querySelectorAll<HTMLButtonElement>(
		'button[data-tab-mcp-action="connect"]',
	);
	if (fields.length !== 1 || buttons.length !== 1) return false;
	if (
		form.getAttribute("data-app") !== seen.app ||
		form.getAttribute("data-client-name") !== seen.clientName ||
		form.getAttribute("data-client-host") !== seen.clientHost
	)
		return false;
	const field = fields[0] as HTMLInputElement;
	const button = buttons[0] as HTMLButtonElement;
	if (field.disabled || button.disabled) return false;
	field.value = code;
	field.dispatchEvent(new Event("input", { bubbles: true }));
	button.click();
	return true;
}
