/**
 * The relay's pairing page, as relay 0.12.0 writes it (tab-mcp's
 * `oauth/server.ts`, the hooks of its DEC-199): for the unit and the
 * end-to-end tests of filling in the code (DEC-044).
 */

/** The relay's pairing form, as relay 0.12.0 writes it. */
export function pairingPage(
	options: { app?: string; name?: string; host?: string; forms?: number } = {},
): string {
	const form = `<form method="post" action="/authorize" data-tab-mcp-pairing="1" data-app="${options.app ?? "sitegloss"}" data-client-name="${options.name ?? "Claude"}" data-client-host="${options.host ?? "claude.ai"}">
<input type="hidden" name="request" value="r_1">
<label for="code">Code</label>
<input id="code" name="code" type="text" data-tab-mcp-field="code" autocomplete="off" maxlength="12" required>
<div class="actions">
<button type="submit" class="primary" name="action" value="connect" data-tab-mcp-action="connect">Connect</button>
<button type="submit" class="secondary" name="action" value="cancel" formnovalidate>Cancel</button>
</div>
</form>`;
	return `<!doctype html><html><body><h1>Connect Claude</h1>${form.repeat(options.forms ?? 1)}</body></html>`;
}
