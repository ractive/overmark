/**
 * Filling in Sitegloss's pairing code on the relay's pairing page (DEC-044,
 * tab-mcp's DEC-199). When an AI app opens the hosted relay's `/authorize`
 * page in this browser, Sitegloss reads its form's hooks, asks its user in
 * its own panel (or a notification) whether to connect that app, and only on
 * a yes types its current code into the form's code field and clicks its
 * Connect button. The relay checks the code as if it had been typed.
 *
 * - A setting of its own, off by default, also for a user who gave access to
 *   all sites ("Fill in the code for me" under the pairing code; "Stop
 *   filling in the code" turns it off). The rules of the question and the
 *   fill are `code-filler.ts`; the functions here run in the page.
 * - Only on the hosted relay's own origin, exactly (`HOSTED_ORIGIN`), only on
 *   `/authorize` in a tab's top frame, and only for a form that names
 *   Sitegloss's app (`data-app="sitegloss"`) and carries the relay's
 *   `request_id`. The page's functions check the document's own origin and
 *   path again, so a tab that moved on meanwhile gets nothing. A form that is
 *   not exactly as documented gets nothing: the user types the code as
 *   before.
 * - It needs the optional access to that one site, which the panel asks for
 *   with the click that turns it on (`PAIR_FILL_SITE`); without it Sitegloss
 *   cannot see the page, and nothing changes. No permission is required at
 *   install.
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
	/** `data-client-name`: the name the AI app gave itself ("" for none). */
	clientName: string;
	/** `data-client-host`: the AI app's verified host. */
	clientHost: string;
	/** The hidden `request_id`: the relay's id of this authorization request. */
	requestId: string;
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
 * outside itself: the form's hooks, when this is the top frame of a page at
 * exactly `origin` and `/authorize` with exactly one such form, with exactly
 * one code field, one Connect button and the relay's request id in it;
 * `null` otherwise.
 */
export function readPairingForm(origin: string): PairingForm | null {
	if (
		window.top !== window ||
		location.origin !== origin ||
		location.pathname !== "/authorize"
	)
		return null;
	const forms = document.querySelectorAll('form[data-tab-mcp-pairing="1"]');
	if (forms.length !== 1) return null;
	const form = forms[0] as HTMLFormElement;
	const fields = form.querySelectorAll('input[data-tab-mcp-field="code"]');
	const buttons = form.querySelectorAll(
		'button[data-tab-mcp-action="connect"]',
	);
	const ids = form.querySelectorAll<HTMLInputElement>(
		'input[type="hidden"][name="request_id"]',
	);
	if (fields.length !== 1 || buttons.length !== 1 || ids.length !== 1)
		return null;
	const app = form.getAttribute("data-app");
	const clientName = form.getAttribute("data-client-name");
	const clientHost = form.getAttribute("data-client-host");
	const requestId = (ids[0] as HTMLInputElement).value;
	if (!app || clientName === null || !clientHost || !requestId) return null;
	return { app, clientName, clientHost, requestId };
}

/**
 * Runs in the page: types `code` into the form's code field and clicks its
 * Connect button, only in the top frame of a page at exactly `origin` and
 * `/authorize`, and only if the form is still the one the user was asked
 * about (`seen`): the same app, AI app and request of the relay. Whether it
 * did.
 */
export function fillPairingForm(
	code: string,
	seen: PairingForm,
	origin: string,
): boolean {
	if (
		window.top !== window ||
		location.origin !== origin ||
		location.pathname !== "/authorize"
	)
		return false;
	const forms = document.querySelectorAll('form[data-tab-mcp-pairing="1"]');
	if (forms.length !== 1) return false;
	const form = forms[0] as HTMLFormElement;
	const fields = form.querySelectorAll<HTMLInputElement>(
		'input[data-tab-mcp-field="code"]',
	);
	const buttons = form.querySelectorAll<HTMLButtonElement>(
		'button[data-tab-mcp-action="connect"]',
	);
	const ids = form.querySelectorAll<HTMLInputElement>(
		'input[type="hidden"][name="request_id"]',
	);
	if (fields.length !== 1 || buttons.length !== 1 || ids.length !== 1)
		return false;
	if (
		form.getAttribute("data-app") !== seen.app ||
		form.getAttribute("data-client-name") !== seen.clientName ||
		form.getAttribute("data-client-host") !== seen.clientHost ||
		(ids[0] as HTMLInputElement).value !== seen.requestId
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

/** The relay's code as the client library keeps it. */
export interface CodeNow {
	code: string;
	/** When the relay says it ends (ISO time), by the relay's clock. */
	expiresAt: string;
}

/** A code with less than this left by this computer's clock waits for the next. */
export const CODE_MARGIN_MS = 5000;
/** How long a fill waits for a code, or for the next one. */
export const CODE_WAIT_MS = 10_000;

/**
 * The code to fill in: the current one when it has `CODE_MARGIN_MS` left by
 * this computer's clock (or an end it cannot read); else the next one the
 * relay sends; and when none comes within `waitMs`, the current one after
 * all. A clock that runs ahead makes every code look expired, so the clock
 * alone never keeps a code from being filled in: the relay checks it. With
 * no code at all, the first that comes within `waitMs`. Once `cancelled`
 * says so, nothing, at once.
 */
export async function codeToFill(
	current: () => CodeNow | undefined,
	options: {
		now?: () => number;
		waitMs?: number;
		pollMs?: number;
		cancelled?: () => boolean;
	} = {},
): Promise<string | undefined> {
	const now = options.now ?? Date.now;
	const first = current();
	if (first !== undefined) {
		const ends = Date.parse(first.expiresAt);
		if (Number.isNaN(ends) || ends - now() >= CODE_MARGIN_MS) return first.code;
	}
	const end = now() + (options.waitMs ?? CODE_WAIT_MS);
	for (;;) {
		if (options.cancelled?.()) return undefined;
		const code = current()?.code;
		if (code !== undefined && code !== first?.code) return code;
		if (now() >= end) return first?.code ?? code;
		await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 50));
	}
}
