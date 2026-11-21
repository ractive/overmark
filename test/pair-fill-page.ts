/**
 * The relay's pairing page, as relay 0.12 writes it (tab-mcp's
 * `oauth/server.ts`, `#pairingPage`, the hooks of its DEC-199): for the unit
 * and the end-to-end tests of filling in the code (DEC-044). The hidden
 * `request_id` is the relay's id of the authorization request; a wrong code
 * renders the same form again, with the same id and an error above it.
 */

/** The relay's pairing form, as relay 0.12 writes it. */
export function pairingPage(
	options: {
		app?: string;
		name?: string;
		host?: string;
		forms?: number;
		requestId?: string;
		error?: string;
	} = {},
): string {
	const form = `<form method="post" action="/authorize" data-tab-mcp-pairing="1" data-app="${options.app ?? "sitegloss"}" data-client-name="${options.name ?? "Claude"}" data-client-host="${options.host ?? "claude.ai"}">
<input type="hidden" name="request_id" value="${options.requestId ?? "r_1"}">
<input type="hidden" name="csrf" value="csrf-token">
<label for="code">Code</label>
<input id="code" name="code" type="text" data-tab-mcp-field="code" autocomplete="off" maxlength="12" required>
<div class="actions">
<button type="submit" class="primary" name="action" value="connect" data-tab-mcp-action="connect">Connect</button>
<button type="submit" class="secondary" name="action" value="cancel" formnovalidate>Cancel</button>
</div>
</form>`;
	const error =
		options.error === undefined
			? ""
			: `<p class="error" role="alert" id="error">${options.error}</p>`;
	return `<!doctype html><html><body><h1>Connect Claude</h1>${error}${form.repeat(options.forms ?? 1)}</body></html>`;
}
